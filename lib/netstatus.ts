// Turning WebRTC's ICE state into something a person can act on.
//
// The problem this solves: a stalled connection and a slow connection look
// identical from the outside. Both sit on "Connecting…" with no explanation, so
// the only available response is to guess, or to retry and hope. The browser
// already exposes precisely why it is stuck — iceConnectionState,
// iceGatheringState, and candidate-pair errors — so this maps those onto an
// honest sentence.
//
// Kept separate from the component so the mapping is unit-testable, and so the
// wording can be iterated without touching connection logic.

export type IceState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export type GatheringState = "new" | "gathering" | "complete";

export interface NetworkSnapshot {
  ice: IceState;
  gathering: GatheringState;
  /** How many STUN/TURN candidate requests have errored this attempt. */
  gatheringErrors: number;
  /** True once ICE reports a usable pair. */
  everConnected: boolean;
}

export type NetworkVerdict =
  | { kind: "ok" }
  | { kind: "progress"; message: string }
  | { kind: "degraded"; message: string; hint: string }
  | { kind: "blocked"; message: string; hint: string };

export function initialNetwork(): NetworkSnapshot {
  return { ice: "new", gathering: "new", gatheringErrors: 0, everConnected: false };
}

const STUN_HINT =
  "Your network may be blocking the route WebRTC needs. A VPN, or a different network, usually fixes it.";
const GENERIC_HINT =
  "Connections need a direct path between the two of you. Corporate and public Wi-Fi often block it.";

export function describeNetwork(s: NetworkSnapshot): NetworkVerdict {
  // A usable pair existed at some point, so the route worked and this is a
  // mid-call dropout rather than a failure to connect.
  if (s.everConnected && (s.ice === "disconnected" || s.ice === "failed")) {
    return {
      kind: "degraded",
      message: "Connection dropped",
      hint: "Trying to recover the route.",
    };
  }

  switch (s.ice) {
    case "connected":
    case "completed":
      return { kind: "ok" };

    case "failed":
    case "closed": {
      // If candidate gathering errored or never finished, the almost-certain
      // cause is that STUN was unreachable, which is a network restriction
      // rather than anything the peer did. Say so, because "connection failed"
      // sends people looking in the wrong place.
      const gatheringBroke = s.gatheringErrors > 0 || s.gathering !== "complete";
      return {
        kind: "blocked",
        message: "Couldn't establish a connection",
        hint: gatheringBroke ? STUN_HINT : GENERIC_HINT,
      };
    }

    case "disconnected":
      return {
        kind: "degraded",
        message: "Connection interrupted",
        hint: "Trying to recover…",
      };

    case "checking":
      return { kind: "progress", message: "Checking your network…" };

    case "new":
    default: {
      // Still collecting candidates. This is the state people cannot otherwise
      // distinguish from a hang, and the usual cause is a slow or blocked STUN
      // server, so name what is happening.
      if (s.gathering === "gathering") {
        return { kind: "progress", message: "Looking for a working route…" };
      }
      if (s.gatheringErrors > 0) {
        return { kind: "progress", message: "Your network is slowing this down…" };
      }
      return { kind: "progress", message: "Starting…" };
    }
  }
}
