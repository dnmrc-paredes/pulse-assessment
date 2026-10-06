// Shared types across client + API.

// Signal mailbox message types. This union mirrors the `SignalType` enum in
// prisma/schema.prisma, which is the authoritative constraint at the database
// level. It is duplicated here rather than imported from @prisma/client so that
// client components don't pull the Prisma client into the browser bundle.
export type SignalType =
  | "wave" // low-commitment greeting; no connection implied
  | "request" // connection request (tap a dot)
  | "accept" // recipient accepted
  | "decline" // recipient declined (or auto-declined while busy)
  | "offer" // WebRTC SDP offer
  | "answer" // WebRTC SDP answer
  | "ice" // WebRTC ICE candidate
  | "end"; // hang up / leave the connection

export interface PeerDot {
  id: string;
  lat: number;
  lng: number;
  busy: boolean;
}

export interface SignalMsg {
  id: string;
  fromId: string;
  toId: string;
  type: SignalType;
  payload: string | null;
  createdAt: string;
}

export interface PollResponse {
  peers: PeerDot[];
  signals: SignalMsg[];
  // The caller's own published position (already privacy-offset server-side).
  // Returned so the client can place its own "Me" marker where peers see it,
  // instead of at its raw GPS coordinates.
  me: { lat: number; lng: number } | null;
}
