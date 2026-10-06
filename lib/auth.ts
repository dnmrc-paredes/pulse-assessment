// Session identity. Server-only.
//
// A session has two identifiers and the distinction is the whole security model:
//
//   id    — public address. Peers learn it (they must, to route signals to a
//           mailbox). Knowing it grants nothing: it cannot be used to act as
//           that session on any endpoint.
//   token — secret capability. Held by the session holder only, never sent to a
//           peer and never written to disk by the client. It is the sole thing
//           that authenticates a request.
//
// Every mutating route resolves the caller by looking up `sha256(token)`, so a
// client-supplied id is never trusted. This is not an account system — there is
// no registration, no credential reuse, and the row is destroyed on leave.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

export function newSessionId(): string {
  return randomUUID();
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Resolve the caller from their token. Returns null when the token is malformed
// or the session no longer exists (left, or reaped as stale).
export async function resolveSession(token: unknown) {
  if (typeof token !== "string" || token.length !== 43) return null;
  return prisma.presence.findUnique({
    where: { tokenHash: hashToken(token) },
    // lat/lng are the *published* (already privacy-offset) coordinates. The
    // client needs these so it can draw its own marker where peers actually see
    // it, rather than at its raw GPS fix.
    select: { id: true, busy: true, busyAt: true, lat: true, lng: true },
  });
}

// Pull the session token from an `Authorization: Bearer` header, falling back to
// a token supplied in the body. The body fallback exists only for POST
// /api/leave, which is fired by navigator.sendBeacon on tab close — beacons
// cannot carry custom headers.
export function bearerToken(request: Request, bodyToken?: unknown): unknown {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return bodyToken;
}
