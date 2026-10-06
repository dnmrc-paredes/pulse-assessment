import { TRACE_ENABLED, traceEvent } from "@/lib/debug";

export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end";

// Single source of truth for the data-channel wire format. The sender and the
// receiver both derive from this union, so a mismatched discriminant is a
// compile error rather than a silently dropped message.
type ChannelMsg =
  | { t: "chat"; text: string }
  | { t: "ctrl"; ctrl: PeerControl };

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  onControl: (ctrl: PeerControl) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
}

// Several STUN servers, because ICE needs at least one to be *reachable* and
// reachability is not universal: Google's STUN in particular is commonly
// blocked in some regions, and a single unreachable server means no srflx
// candidates at all, which looks exactly like a silent hang. The browser
// queries them in parallel and uses whichever answers, so listing several
// costs nothing and removes a whole class of "it won't connect for me" bugs.
//
// `stun:stun.nextcloud.com:443` is deliberate: STUN on 443 survives networks
// that block the usual UDP 3478/19302 ports.
//
// This is still STUN-only (no TURN), so symmetric NATs remain unsupported —
// that needs a relay, which needs infrastructure this project doesn't have.
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
    { urls: "stun:stun.nextcloud.com:443" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

// Upper bound on ICE candidates buffered while waiting for a remote description.
const MAX_QUEUED_CANDIDATES = 64;

// WebRTC signalling here goes over JSON, and that forces an explicit conversion.
//
// RTCSessionDescription and RTCIceCandidate are WebIDL interfaces: `type`, `sdp`,
// `candidate`, `sdpMid` etc. are accessors on the PROTOTYPE, not own properties
// on the instance. JSON.stringify only walks own enumerable properties, so
// stringifying either object directly yields "{}" — the SDP never leaves the
// browser and the peer silently rejects it as malformed. Copying the fields
// into a plain object is what actually makes the payload survive the wire.
function toSessionDescriptionInit(desc: RTCSessionDescription | null): RTCSessionDescriptionInit {
  return { type: desc?.type ?? "offer", sdp: desc?.sdp ?? "" };
}

function toCandidateInit(cand: RTCIceCandidate): RTCIceCandidateInit {
  return {
    candidate: cand.candidate,
    sdpMid: cand.sdpMid,
    sdpMLineIndex: cand.sdpMLineIndex,
    usernameFragment: cand.usernameFragment,
  };
}

export class PeerSession {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private localStream: MediaStream | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  // Serialises inbound signaling. Polling delivers signals in batches, and
  // every one of them is dispatched without awaiting the last, so descriptions
  // and candidates would otherwise be applied concurrently. setRemoteDescription
  // and setLocalDescription are async state transitions on a single
  // RTCPeerConnection; overlapping them corrupts the signaling state machine
  // and the connection never opens.
  private signalChain: Promise<unknown> = Promise.resolve();

  constructor(initiator: boolean, cb: PeerCallbacks) {
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(ICE_CONFIG);

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      const init = toCandidateInit(candidate);
      traceEvent(`ice candidate: ${init.candidate ? init.candidate.slice(0, 48) : "EMPTY"}`);
      this.cb.onSignal("ice", JSON.stringify(init));
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        const local = this.pc.localDescription;
        if (local) {
          const init = toSessionDescriptionInit(local);
          traceEvent(
            `offer created: type=${init.type} sdpLen=${init.sdp?.length ?? 0} signalingState=${this.pc.signalingState}`,
          );
          this.cb.onSignal("offer", JSON.stringify(init));
        } else {
          traceEvent("offer MISSING: localDescription was null");
        }
      } catch {
        // Negotiation can fail transiently (e.g. a simultaneous offer). The
        // collision handling in applySignal is what recovers from that.
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      traceEvent(`pc connectionState: ${this.pc.connectionState}`);
      this.cb.onConnectionState(this.pc.connectionState);
    };

    // The aggregate `connectionState` only says "connecting"; these three say
    // *why* a check never succeeds — whether gathering finished, which transport
    // state ICE is in, and whether a STUN/TURN server was rejected outright.
    this.pc.oniceconnectionstatechange = () => {
      traceEvent(`iceConnectionState: ${this.pc.iceConnectionState}`);
      if (this.pc.iceConnectionState === "failed") void this.logCandidatePairs();
    };
    this.pc.onicegatheringstatechange = () => {
      traceEvent(`iceGatheringState: ${this.pc.iceGatheringState}`);
    };
    this.pc.onicecandidateerror = (event) => {
      const e = event as unknown as { errorCode?: number; errorText?: string; address?: string };
      traceEvent(`iceCandidateError code=${e.errorCode ?? "?"} ${e.errorText ?? ""} ${e.address ?? ""}`);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel("chat");
      this.wireDataChannel(this.dc);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.wireDataChannel(this.dc);
      };
    }
  }

  private wireDataChannel(dc: RTCDataChannel) {
    dc.onopen = () => {
      traceEvent(`data channel open (${dc.label})`);
      this.cb.onChannelOpen();
    };
    dc.onmessage = (e) => {
      let msg: ChannelMsg;
      try {
        msg = JSON.parse(e.data as string) as ChannelMsg;
      } catch {
        return;
      }
      // Re-validate the discriminant and payload: the peer is untrusted, so a
      // typed cast alone proves nothing about what actually arrived.
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "chat" && typeof msg.text === "string") {
        this.cb.onChat(msg.text);
      } else if (msg.t === "ctrl" && typeof msg.ctrl === "string") {
        this.cb.onControl(msg.ctrl as PeerControl);
      }
    };
  }

  async handleSignal(type: DescType, payload: string) {
    if (this.closed) return;
    // Queue onto the chain so signals are applied strictly in arrival order.
    // The chain swallows rejections so one bad signal cannot poison every
    // signal after it.
    const result = this.signalChain.then(() => this.applySignal(type, payload));
    this.signalChain = result.catch(() => {});
    return result;
  }

  private async applySignal(type: DescType, payload: string) {
    if (this.closed) return;

    // The payload arrives over the network from an untrusted peer, so parse
    // defensively — a malformed message must not reject into the caller.
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;

    if (type === "ice") {
      const cand = data as RTCIceCandidateInit;
      traceEvent(
        `applying ice: ${cand.candidate ? cand.candidate.slice(0, 48) : "EMPTY"} hasRemote=${!!this.pc.remoteDescription}`,
      );
      const candidate = data as RTCIceCandidateInit;
      if (!this.pc.remoteDescription) {
        // No remote description yet, so addIceCandidate would throw. Buffer it
        // until applySignal sets one and flushes — but cap the queue so a peer
        // cannot grow it without bound.
        if (this.pendingCandidates.length < MAX_QUEUED_CANDIDATES) {
          this.pendingCandidates.push(candidate);
        }
        return;
      }
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    // Reject anything that isn't a well-formed description of the announced
    // type, otherwise a hostile peer can drive the peer connection into a
    // state it can't recover from.
    if (typeof desc.sdp !== "string" || !desc.sdp) {
      traceEvent(`REJECTED ${type}: no sdp in payload (${JSON.stringify(desc).slice(0, 80)})`);
      return;
    }
    if (desc.type !== type) {
      traceEvent(`REJECTED ${type}: payload type was ${String(desc.type)}`);
      return;
    }
    traceEvent(`applying ${type}: sdpLen=${desc.sdp.length} signalingState=${this.pc.signalingState}`);

    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      await this.pc.setRemoteDescription(desc);
    } catch {
      return;
    }

    // Flush AFTER the remote description exists. addIceCandidate is invalid
    // before that point, so flushing first silently discarded every candidate
    // that had been buffered — which is exactly what happens when a peer
    // receives an offer and its ICE candidates in the same poll batch.
    await this.flushPendingCandidates();

    if (desc.type === "offer") {
      try {
        await this.pc.setLocalDescription();
      } catch {
        return;
      }
      const local = this.pc.localDescription;
      if (local) {
        traceEvent(`answer created: type=${local.type} sdpLen=${local.sdp?.length ?? 0}`);
        this.cb.onSignal("answer", JSON.stringify(toSessionDescriptionInit(local)));
      } else {
        traceEvent("answer MISSING: localDescription was null");
      }
    }
  }

  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  sendChat(text: string) {
    this.safeSend({ t: "chat", text } satisfies ChannelMsg);
  }

  sendControl(ctrl: PeerControl) {
    this.safeSend({ t: "ctrl", ctrl } satisfies ChannelMsg);
  }

  private safeSend(obj: ChannelMsg) {
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify(obj));
    } catch {
      // The channel can close between the state check and the send, and an
      // oversized frame is rejected by the transport. Either way, dropping the
      // message is correct — the connection is already tearing down.
    }
  }

  async startVideo(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }
    return this.localStream;
  }

  stopVideo() {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      for (const sender of this.pc.getSenders()) {
        if (sender.track) {
          try {
            this.pc.removeTrack(sender);
          } catch {}
        }
      }
      this.localStream = null;
    }
  }

  // Dumps which candidate pairs ICE actually tried and whether any bytes moved.
  // A pair with bytesSent > 0 means packets left but nothing came back; zero
  // bytesSent means the pair was never viable.
  async logCandidatePairs() {
    if (!TRACE_ENABLED) return;
    try {
      const stats = await this.pc.getStats();
      const rows: string[] = [];
      stats.forEach((report: RTCStats & { type?: string; [key: string]: unknown }) => {
        const r = report as unknown as Record<string, unknown>;
        if (r.type === "candidate-pair") {
          rows.push(
            `pair id=${String(r.id)} state=${String(r.state ?? "?")} nominated=${!!r.nominated} ` +
              `bytesSent=${Number(r.bytesSent ?? 0)} bytesRecv=${Number(r.bytesReceived ?? 0)} ` +
              `requests=${Number(r.requestsSent ?? 0)} responses=${Number(r.responsesReceived ?? 0)}`,
          );
        }
        if (r.type === "local-candidate" || r.type === "remote-candidate") {
          rows.push(
            `${String(r.type).replace("-candidate", "")} ${String(r.candidateType ?? "?")} ` +
              `${String(r.protocol ?? "")} ${String(r.address ?? "?")}:${String(r.port ?? "?")} ` +
              `state=${String(r.state ?? "?")}`,
          );
        }
      });
      traceEvent("--- ICE stats ---");
      rows.forEach((r) => traceEvent("  " + r));
      if (rows.length === 0) traceEvent("  (no candidate stats reported)");
    } catch {
      traceEvent("getStats() failed");
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
    }
    try {
      this.pc.close();
    } catch {}
  }
}
