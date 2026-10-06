import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSession } from "@/lib/auth";
import { STALE_MS, SIGNAL_TTL_MS, BUSY_TTL_MS } from "@/lib/presence";
import { rateLimit } from "@/lib/ratelimit";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The client polls every POLL_INTERVAL_MS (1.5s) ≈ 40/min. 120/min leaves 3x
// headroom for jitter and tab-throttling before a session starts getting 429s.
const POLL_LIMIT = 120;
const POLL_WINDOW_MS = 60_000;

// Bounds on response size. A session only ever needs a small slice of the world
// and a small slice of its own mailbox; without these a single response grows
// with total user count.
const MAX_PEERS = 500;
const MAX_INBOX = 100;

// GET /api/poll?token=&active=1 — the single endpoint that drives the live map.
// It (1) refreshes the caller's heartbeat and busy lease, (2) reclaims expired
// busy locks + stale presence + orphan signals, (3) returns online peers, and
// (4) drains this user's mailbox.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // Identity comes from the token alone. There is no id parameter to spoof.
  const session = await resolveSession(params.get("token"));
  if (!session) {
    // Unknown, malformed, or already-reaped token — the client must re-join.
    return Response.json({ error: "unknown session" }, { status: 401 });
  }

  const limit = rateLimit(`poll:${session.id}`, POLL_LIMIT, POLL_WINDOW_MS);
  if (!limit.ok) {
    return Response.json(
      { error: "polling too fast" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  // `active=1` means the caller holds a live connection, which is what keeps
  // its busy lease from expiring mid-call.
  const active = params.get("active") === "1";

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_MS);
  const signalCutoff = new Date(now.getTime() - SIGNAL_TTL_MS);
  const busyCutoff = new Date(now.getTime() - BUSY_TTL_MS);

  // 1) Heartbeat — refresh the CALLER'S row only. Scoping this to the caller is
  // load-bearing: with an unscoped update, every poll refreshed every row and
  // the staleness sweep below could therefore never match anything, so dead
  // dots accumulated forever.
  await prisma.presence.updateMany({
    where: active && session.busy ? { id: session.id, busy: true } : { id: session.id },
    data: active && session.busy
      ? { lastSeen: now, busyAt: now }
      : { lastSeen: now },
  });

  // 2) Reclaim leases whose holder stopped reporting. Without this a crashed or
  // half-closed connection would leave a user permanently unconnectable.
  await prisma.presence.updateMany({
    where: {
      busy: true,
      OR: [{ busyAt: { lt: busyCutoff } }, { busyAt: null }],
    },
    data: { busy: false, busyAt: null },
  });

  // 3) Reap stale presence rows and orphaned signals (independent writes — no
  // atomicity needed, and avoids transactions over a PgBouncer pooler). Both
  // scans are index-backed now (Presence.lastSeen, Signal.createdAt).
  await prisma.presence.deleteMany({ where: { lastSeen: { lt: staleCutoff } } });
  await prisma.signal.deleteMany({ where: { createdAt: { lt: signalCutoff } } });

  // 4) Online peers, excluding self. Ordered so the cut is stable and favours
  // the most recently active users.
  const peers = await prisma.presence.findMany({
    where: {
      id: { not: session.id },
      lastSeen: { gte: staleCutoff },
    },
    select: { id: true, lat: true, lng: true, busy: true },
    orderBy: { lastSeen: "desc" },
    take: MAX_PEERS,
  });

  // 5) Drain this user's mailbox: read, then delete exactly what we read so a
  // concurrently-inserted signal is never lost.
  const inbox = await prisma.signal.findMany({
    where: { toId: session.id },
    orderBy: { createdAt: "asc" },
    take: MAX_INBOX,
  });
  if (inbox.length > 0) {
    await prisma.signal.deleteMany({
      where: { id: { in: inbox.map((s) => s.id) } },
    });
  }

  const response: PollResponse = {
    peers,
    me: { lat: session.lat, lng: session.lng },
    signals: inbox.map((s) => ({
      id: s.id,
      fromId: s.fromId,
      toId: s.toId,
      // Signal.type is a database enum, so this needs no cast — an
      // unrecognised value is now impossible rather than merely unlikely.
      type: s.type,
      payload: s.payload,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  return Response.json(response);
}
