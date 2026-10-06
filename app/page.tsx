"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import {
  ApiError,
  join,
  leave,
  poll,
  sendSignal,
  type SessionCredentials,
} from "@/lib/api";
import { PeerSession, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import { distanceBand, haversineKm, type DistanceBand } from "@/lib/distance";
import { estimatedLocalTime } from "@/lib/localtime";
import { pickStarter, type Starter } from "@/lib/icebreakers";
import ReachCard from "./components/ReachCard";
import {
  describeNetwork,
  initialNetwork,
  type NetworkSnapshot,
} from "@/lib/netstatus";
import * as blockedStore from "@/lib/blocked";
import { type PeerDot, type SignalMsg, type SignalType } from "@/lib/types";
import { trace, traceEvent } from "@/lib/debug";

type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;

// How long an incoming request stays on screen. Without this the prompt could
// sit forever while its server-side busy lease quietly aged out, leaving the UI
// offering a connection the server would no longer honour.
const INCOMING_TIMEOUT_MS = 30_000;

// How long we wait for the data channel to open after both sides agreed to
// connect. This is not optional: a peer that vanishes mid-handshake never
// reaches `connected`, and without a deadline this tab would stay in
// `connecting`, keep refreshing its own busy lease on every poll, and be
// permanently unconnectable while showing "Connecting…".
const CONNECT_TIMEOUT_MS = 20_000;

// Cap on consecutive silent re-joins before we give up and show the gate. A 401
// loop means something is structurally wrong, and retrying forever would spin.
const MAX_AUTO_REJOINS = 3;

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [session, setSession] = useState<SessionCredentials | null>(null);
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const sessionRef = useRef<SessionCredentials | null>(null);
  const setSessionCreds = (c: SessionCredentials | null) => {
    sessionRef.current = c;
    setSession(c);
  };

  // The raw GPS fix, kept in a ref only: async handlers (silent re-join) need
  // to re-register without depending on a stale render closure, and nothing
  // renders from it any more.
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  // Where the server actually placed us, i.e. after the 1-3 km privacy offset.
  // This is what peers see, so it is what our own marker must be drawn at —
  // drawing it at the raw GPS fix made the map misrepresent our position.
  const [publishedLocation, setPublishedLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  // Distance band per peer, computed once here rather than in each component
  // that needs it, so the dot colour, the reach card and the chat header can
  // never disagree about how far away someone is.
  const peerBands = useMemo(() => {
    const map = new Map<string, DistanceBand>();
    if (!publishedLocation) return map;
    for (const peer of peers) {
      map.set(
        peer.id,
        distanceBand(
          haversineKm(publishedLocation, { lat: peer.lat, lng: peer.lng }),
        ),
      );
    }
    return map;
  }, [peers, publishedLocation]);

  // False until the first poll succeeds, so the map can say "checking" rather
  // than "nobody is here" before it has actually checked.
  const [presenceLoaded, setPresenceLoaded] = useState(false);

  // Brief, one-shot acknowledgement that the handshake succeeded. This is the
  // moment the app used to give no signal at all about.
  const [justConnected, setJustConnected] = useState(false);

  // Reach context, shown once when a connection first opens.
  const [reach, setReach] = useState<{
    peerId: string;
    band: DistanceBand;
    localTime: ReturnType<typeof estimatedLocalTime>;
    starter: Starter;
  } | null>(null);
  const starterSeq = useRef(0);
  const lastStarter = useRef("");

  // Session-scoped block list, held in memory only. See lib/blocked.ts for why
  // it is deliberately not persisted.
  const blockedPeers = useSyncExternalStore(
    blockedStore.subscribe,
    blockedStore.getSnapshot,
    blockedStore.getServerSnapshot,
  );

  // Read by the channel-open callback, which is bound once per PeerSession.
  const peerBandsRef = useRef(peerBands);
  const peerLngRef = useRef(new Map<string, number>());
  useEffect(() => {
    peerBandsRef.current = peerBands;
    peerLngRef.current = new Map(peers.map((p) => [p.id, p.lng]));
  }, [peerBands, peers]);

  // Remote typing indicator. Auto-expires, because a peer who closes the tab
  // mid-sentence never sends a "stopped" message.
  const [peerTyping, setPeerTyping] = useState(false);

  // Real ICE/gathering state, so a stall is legible instead of guessing.
  const [network, setNetwork] = useState<NetworkSnapshot>(initialNetwork);
  const networkRef = useRef(network);
  useEffect(() => {
    networkRef.current = network;
  });
  const typingExpiry = useRef<number | null>(null);
  const lastSentTyping = useRef(false);
  const wavedAtRef = useRef<number>(0);
  const setLocation = (loc: { lat: number; lng: number } | null) => {
    myLocationRef.current = loc;
  };

  const [conn, _setConn] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (c: Conn) => {
    connRef.current = c;
    _setConn(c);
  };

  const [video, _setVideo] = useState<VideoState>("none");
  const videoRef = useRef<VideoState>(video);
  const setVideo = (v: VideoState) => {
    videoRef.current = v;
    _setVideo(v);
  };

  const peerRef = useRef<PeerSession | null>(null);
  const msgId = useRef(0);
  const connTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const noticeQueue = useRef<string[]>([]);
  const rejoinsRef = useRef(0);

  // Notices are queued rather than replaced. Connection teardown emits several
  // in quick succession ("Request declined." then "Stranger disconnected."), and
  // the old behaviour silently dropped all but the last one.
  function showNotice(text: string) {
    noticeQueue.current = [...noticeQueue.current, text];
    if (noticeTimer.current) return; // already draining
    const advance = () => {
      const [next, ...rest] = noticeQueue.current;
      noticeQueue.current = rest;
      setNotice(next ?? null);
      noticeTimer.current =
        next === undefined
          ? null
          : window.setTimeout(() => {
              noticeTimer.current = null;
              advance();
            }, 3500);
    };
    advance();
  }

  // Every signal send funnels through here so failures are visible and auth is
  // never silently skipped. Signals are addressed by recipient only — the
  // server infers the sender from the session token, so there is no `fromId`
  // to get wrong.
  async function signal(toId: string, type: SignalType, payload?: string) {
    const token = sessionRef.current?.token;
    if (!token) return;
    trace("->", type, undefined, toId, payload?.length);
    try {
      await sendSignal(token, toId, type, payload);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleSessionLost();
      } else {
        showNotice("Couldn't reach the server — check your connection.");
      }
    }
  }

  // The server no longer recognises this session, so it was reaped as stale.
  // If we aren't mid-connection we can transparently mint a fresh identity;
  // otherwise the connection is already unrecoverable, so surface it.
  function handleSessionLost() {
    if (connRef.current.kind !== "idle") {
      teardown("Connection lost — reconnecting…");
    }
    if (rejoinsRef.current >= MAX_AUTO_REJOINS) {
      setSessionCreds(null);
      setPhase("gate");
      showNotice("Session expired. Please re-enter.");
      return;
    }
    rejoinsRef.current += 1;
    const loc = myLocationRef.current;
    if (!loc) {
      setPhase("gate");
      return;
    }
    void join(loc.lat, loc.lng)
      .then((creds) => {
        setSessionCreds(creds);
        if (rejoinsRef.current > 0) showNotice("Reconnected.");
      })
      .catch(() => {
        setSessionCreds(null);
        setPhase("gate");
      });
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((prev) => [...prev, { id: msgId.current++, mine, text }]);
  }

  function teardown(message?: string) {
    if (connTimer.current) clearTimeout(connTimer.current);
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    setMessages([]);
    setPeerTyping(false);
    setReach(null);
    setNetwork(initialNetwork());
    setConn({ kind: "idle" });
    if (message) showNotice(message);
  }

  // Deadline for the `connecting` state. A peer that disappears after both
  // sides agreed never opens the channel and never reports `failed`, so this is
  // the only thing that guarantees we stop refreshing a lease for a connection
  // that is never going to exist.
  function armConnectTimeout(peerId: string) {
    traceEvent(`connect deadline armed for ${peerId}`);
    if (connTimer.current) clearTimeout(connTimer.current);
    connTimer.current = setTimeout(() => {
      const c = connRef.current;
      if (c.kind === "connecting" && c.peerId === peerId) {
        traceEvent("CONNECT DEADLINE EXPIRED with", peerId);
        void peerRef.current?.logCandidatePairs();
        void signal(peerId, "end");
        teardown("Couldn't establish the connection.");
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function startPeer(peerId: string, initiator: boolean) {
    traceEvent(`PeerSession created initiator=${initiator} with ${peerId}`);
    const ps = new PeerSession(initiator, {
      onSignal: (type: DescType, payload: string) => {
        void signal(peerId, type, payload);
      },
      onChat: (text) => addMessage(false, text),
      onControl: (ctrl) => handleControl(ctrl),
      onTyping: (isTyping) => handleTyping(isTyping),
      onRemoteStream: (stream) => setRemoteStream(stream),
      onNetwork: (snapshot) => setNetwork(snapshot),
      onConnectionState: (state) => {
        traceEvent("pc connectionState:", state);
        if (state === "failed" || state === "closed") {
          // Prefer the ICE-level explanation over a generic "network" string,
          // since it can say whether the route was blocked or merely died.
          const verdict = describeNetwork(networkRef.current);
          const reason =
            verdict.kind === "blocked"
              ? verdict.hint
              : verdict.kind === "degraded"
                ? verdict.message
                : "The connection couldn't be completed.";
          teardown(`${verdict.kind === "blocked" ? verdict.message : "Connection lost."} ${reason}`);
        }
      },
      onChannelOpen: () => {
        traceEvent("DATA CHANNEL OPEN with", peerId);
        // The handshake completed, so the connect deadline no longer applies.
        if (connTimer.current) clearTimeout(connTimer.current);
        setConn({ kind: "connected", peerId });
        setJustConnected(true);
        window.setTimeout(() => setJustConnected(false), 1400);

        // Reach context, once per connection. Guarded on the peer id so a
        // renegotiation (adding video tracks fires another offer round) cannot
        // re-trigger it.
        setReach((prev) => {
          if (prev?.peerId === peerId) return prev;
          const band = peerBandsRef.current.get(peerId) ?? "far";
          const starter = pickStarter(starterSeq.current++, lastStarter.current);
          lastStarter.current = starter.text;
          return {
            peerId,
            band,
            localTime: estimatedLocalTime(peerLngRef.current.get(peerId) ?? 0),
            starter,
          };
        });
      },
    });
    peerRef.current = ps;
  }

  function handleTyping(isTyping: boolean) {
    if (typingExpiry.current) window.clearTimeout(typingExpiry.current);
    setPeerTyping(isTyping);
    if (isTyping) {
      typingExpiry.current = window.setTimeout(() => setPeerTyping(false), 4000);
    }
  }

  function handleControl(ctrl: PeerControl) {
    const ps = peerRef.current;
    switch (ctrl) {
      case "video-request":
        if (videoRef.current === "none") setVideo("incoming");
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && ps) {
          ps.startVideo()
            .then((stream) => {
              setLocalStream(stream);
              setVideo("active");
            })
            .catch(() => {
              setVideo("none");
              ps.sendControl("video-end");
              showNotice("Camera unavailable.");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          setVideo("none");
          showNotice("Video declined.");
        }
        break;
      case "video-end":
        ps?.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        setVideo("none");
        break;
    }
  }

  // Wave state: an outgoing wave (so you can see it left) and an incoming one
  // (so the other side sees it land). Both clear themselves.
  const [waving, setWaving] = useState<string | null>(null);
  const [wavedAt, setWavedAt] = useState<{ peerId: string; key: number } | null>(null);

  function sendWave(peerId: string) {
    if (connRef.current.kind !== "idle") {
      showNotice("Finish what you're doing first.");
      return;
    }
    if (blockedStore.isBlocked(peerId)) {
      showNotice("You blocked that person.");
      return;
    }
    void signal(peerId, "wave");
    setWaving(peerId);
    window.setTimeout(() => setWaving((cur) => (cur === peerId ? null : cur)), 1600);
  }

  function handleIncomingWave(peerId: string) {
    const key = Date.now();
    wavedAtRef.current = key;
    setWavedAt({ peerId, key });
    window.setTimeout(
      () => setWavedAt((cur) => (cur?.key === wavedAtRef.current ? null : cur)),
      9000,
    );
  }

  function requestConnection(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    // Tapping a blocked dot unblocks rather than connects, so blocking is never
    // a one-way door within a session.
    if (blockedStore.isBlocked(peerId)) {
      blockedStore.remove(peerId);
      showNotice("Unblocked. Tap again to connect.");
      return;
    }
    setConn({ kind: "requesting", peerId });
    void signal(peerId, "request");
    connTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "requesting" &&
        connRef.current.peerId === peerId
      ) {
        // Release our server-side busy lease, otherwise this attempt would
        // keep both users locked out until the lease TTL expired.
        void signal(peerId, "end");
        teardown("No answer.");
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    if (connRef.current.kind === "requesting") {
      void signal(connRef.current.peerId, "end");
    }
    teardown();
  }

  function expireIncoming(peerId: string) {
    if (connRef.current.kind !== "incoming" || connRef.current.peerId !== peerId) {
      return;
    }
    void signal(peerId, "end");
    setConn({ kind: "idle" });
    showNotice("Request expired.");
  }

  function acceptIncoming() {
    if (connRef.current.kind !== "incoming") return;
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    const peerId = connRef.current.peerId;
    startPeer(peerId, false);
    void signal(peerId, "accept");
    setConn({ kind: "connecting", peerId });
    armConnectTimeout(peerId);
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    void signal(connRef.current.peerId, "decline");
    setConn({ kind: "idle" });
  }

  function blockAndEnd(peerId: string) {
    blockedStore.add(peerId);
    void signal(peerId, "end");
    teardown("Blocked. You won't be connected to them again.");
  }

  function endConnection() {
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      void signal(c.peerId, "end");
    }
    teardown();
  }

  function startVideoRequest() {
    if (videoRef.current !== "none" || !peerRef.current) return;
    setVideo("requesting");
    peerRef.current.sendControl("video-request");
  }

  function acceptVideo() {
    const ps = peerRef.current;
    if (!ps) return;
    ps.startVideo()
      .then((stream) => {
        setLocalStream(stream);
        ps.sendControl("video-accept");
        setVideo("active");
      })
      .catch(() => {
        ps.sendControl("video-decline");
        setVideo("none");
        showNotice("Camera unavailable.");
      });
  }

  function declineVideo() {
    peerRef.current?.sendControl("video-decline");
    setVideo("none");
  }

  function endVideo() {
    const ps = peerRef.current;
    ps?.stopVideo();
    ps?.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
  }

  function processSignal(sig: SignalMsg) {
    trace("<-", sig.type, sig.fromId, undefined, sig.payload?.length ?? 0);

    // Signals from a blocked session are discarded before they reach any state
    // machine. `end` still gets through so that blocking someone mid-call tears
    // the connection down cleanly rather than leaving it hanging.
    if (blockedStore.isBlocked(sig.fromId) && sig.type !== "end") {
      // Auto-decline so the blocked party is not left waiting on a prompt that
      // will never appear.
      if (sig.type === "request") void signal(sig.fromId, "decline");
      return;
    }

    switch (sig.type) {
      case "wave": {
        // A wave commits nobody to anything: no prompt, no busy lease, and no
        // state change beyond the ripple on the map.
        if (connRef.current.kind === "idle") handleIncomingWave(sig.fromId);
        break;
      }
      case "request": {
        if (connRef.current.kind === "idle") {
          setConn({ kind: "incoming", peerId: sig.fromId });
          // Bound how long the prompt can hold a busy lease server-side.
          if (incomingTimer.current) clearTimeout(incomingTimer.current);
          incomingTimer.current = setTimeout(
            () => expireIncoming(sig.fromId),
            INCOMING_TIMEOUT_MS,
          );
        } else {
          void signal(sig.fromId, "decline");
        }
        break;
      }
      case "accept": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (connTimer.current) clearTimeout(connTimer.current);
          startPeer(sig.fromId, true);
          setConn({ kind: "connecting", peerId: sig.fromId });
          armConnectTimeout(sig.fromId);
        }
        break;
      }
      case "decline": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (connTimer.current) clearTimeout(connTimer.current);
          teardown("Request declined.");
        }
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        const c = connRef.current;
        const peerId =
          c.kind === "connecting" || c.kind === "connected" ? c.peerId : null;
        if (peerRef.current && peerId === sig.fromId) {
          void peerRef.current.handleSignal(
            sig.type as DescType,
            sig.payload ?? "",
          );
        }
        break;
      }
      case "end": {
        const c = connRef.current;
        if (
          (c.kind === "incoming" ||
            c.kind === "connecting" ||
            c.kind === "connected") &&
          c.peerId === sig.fromId
        ) {
          if (c.kind === "incoming") {
            if (incomingTimer.current) clearTimeout(incomingTimer.current);
            setConn({ kind: "idle" });
          } else {
            teardown("Stranger disconnected.");
          }
        }
        break;
      }
    }
  }

  const processSignalRef = useRef(processSignal);
  useEffect(() => {
    processSignalRef.current = processSignal;
  });

  // Same pattern for the 401 handler: read it through a ref so the polling
  // effect doesn't have to re-subscribe (and restart the loop) whenever the
  // closure identity changes.
  const handleSessionLostRef = useRef(handleSessionLost);
  useEffect(() => {
    handleSessionLostRef.current = handleSessionLost;
  });

  useEffect(() => {
    const token = session?.token;
    if (phase !== "live" || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        // `active` reports whether we hold a live connection, which is what
        // keeps our busy lease from being reclaimed mid-call.
        const data = await poll(token, connRef.current.kind !== "idle");
        if (!active) return;
        setPeers(data.peers);
        setPresenceLoaded(true);
        if (data.me) setPublishedLocation(data.me);
        for (const s of data.signals) processSignalRef.current(s);
        rejoinsRef.current = 0;
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          handleSessionLostRef.current();
        }
        // Other failures (offline, 5xx) are transient: back off one interval
        // and retry rather than tearing down a working session.
      }
      if (active) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase, session?.token]);

  useEffect(() => {
    const token = session?.token;
    if (!token || phase !== "live") return;
    const onLeave = () => leave(token);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [session?.token, phase]);

  async function handleReady(lat: number, lng: number) {
    setLocation({ lat, lng });
    try {
      const creds = await join(lat, lng);
      rejoinsRef.current = 0;
      setSessionCreds(creds);
      setPhase("live");
    } catch {
      // Roll back so the gate stays usable; EntryGate renders the failure.
      setLocation(null);
      throw new Error("join failed");
    }
  }

  if (phase === "gate") {
    return <EntryGate onReady={handleReady} />;
  }

  const inChat = conn.kind === "connecting" || conn.kind === "connected";

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldMap
        peers={peers}
        me={publishedLocation}
        onPeerClick={requestConnection}
        onWave={sendWave}
        wavingPeerId={waving}
        wavedPeerId={wavedAt?.peerId ?? null}
        canConnect={conn.kind === "idle"}
        compact={inChat}
        presenceState={
          !presenceLoaded ? "loading" : peers.length === 0 ? "empty" : "populated"
        }
        bands={peerBands}
        blockedPeers={blockedPeers}
      />

      {/* Connection flourish. Purely decorative, so it is hidden from assistive
          tech; the header status change already carries that information. */}
      {justConnected && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
        >
          <div className="connect-flash rounded-full border-2 border-emerald-400" />
        </div>
      )}

      {reach && video === "none" && (
        <ReachCard
          band={reach.band}
          localTime={reach.localTime}
          starter={reach.starter}
          onDismiss={() => setReach(null)}
        />
      )}

      {/* Wave-back offer. A wave commits nobody to anything, so the reply has
          to stay as low-commitment as the greeting. */}
      {wavedAt && conn.kind === "idle" && video === "none" && (
        <div
          className="wave-in absolute inset-x-0 z-20 flex justify-center px-4"
          style={{
            top: "max(3.5rem, calc(env(safe-area-inset-top) + 3.5rem))",
          }}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/95 py-1.5 pl-3 pr-1.5 text-sm text-zinc-200 shadow-xl backdrop-blur">
            <span aria-hidden="true">👋</span>
            <span>Someone waved at you</span>
            <button
              type="button"
              onClick={() => {
                const target = wavedAt.peerId;
                setWavedAt(null);
                sendWave(target);
              }}
              className="min-h-9 rounded-full bg-zinc-800 px-3 text-xs text-zinc-100 hover:bg-zinc-700"
            >
              Wave back
            </button>
            <button
              type="button"
              onClick={() => {
                const target = wavedAt.peerId;
                setWavedAt(null);
                requestConnection(target);
              }}
              className="min-h-9 rounded-full bg-emerald-400 px-3 text-xs font-semibold text-zinc-950 hover:bg-emerald-300"
            >
              Connect
            </button>
            <button
              type="button"
              onClick={() => setWavedAt(null)}
              aria-label="Dismiss"
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div
          className="absolute left-1/2 top-20 z-30 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-center text-sm text-zinc-100 shadow-lg backdrop-blur"
          style={{ top: "max(5rem, calc(env(safe-area-inset-top) + 4rem))" }}
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}

      {conn.kind === "requesting" && (
        <div className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          <span>Requesting connection…</span>
          <button
            onClick={cancelRequest}
            className="rounded-full bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="A stranger wants to connect"
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}

      {inChat && (
        <ChatPanel
          messages={messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          peerTyping={peerTyping}
          networkMessage={
            inChat && conn.kind === "connecting"
              ? (() => {
                  const v = describeNetwork(network);
                  return v.kind === "progress" ? v.message : "Connecting…";
                })()
              : null
          }
          peerBand={inChat ? peerBands.get(conn.peerId) ?? null : null}
          peerLocalTime={
            inChat && conn.peerId !== undefined
              ? estimatedLocalTime(peerLngRef.current.get(conn.peerId) ?? 0)
              : null
          }
          onDraftChange={(text) => {
            // Only announce transitions, so holding a key does not flood the
            // channel with one message per keystroke.
            const next = text.trim().length > 0;
            if (next !== lastSentTyping.current) {
              lastSentTyping.current = next;
              peerRef.current?.sendTyping(next);
            }
          }}
          onSend={(text) => {
            if (lastSentTyping.current) {
              lastSentTyping.current = false;
              peerRef.current?.sendTyping(false);
            }
            peerRef.current?.sendChat(text);
            addMessage(true, text);
          }}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
          onBlock={() => blockAndEnd(conn.peerId)}
        />
      )}

      {video === "requesting" && (
        <div className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          Waiting for stranger to accept video…
        </div>
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="Start video call?"
          subtitle="The stranger wants to turn on video."
          acceptLabel="Accept"
          declineLabel="Decline"
          tone="video"
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
