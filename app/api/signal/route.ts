import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { bearerToken, resolveSession } from "@/lib/auth";
import { isSessionId } from "@/lib/validate";
import { rateLimit } from "@/lib/ratelimit";
import type { SignalType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: readonly SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
];

const MAX_PAYLOAD = 64 * 1024; // SDP/ICE are small; cap to be safe.

// A connection attempt generates a burst of ICE candidates, so the ceiling has
// to clear that burst while still bounding an unauthenticated flood.
const SIGNAL_LIMIT = 240;
const SIGNAL_WINDOW_MS = 60_000;

// POST /api/signal — body { toId, type, payload? }, auth via Bearer token.
//
// There is deliberately no `fromId` in the body. The sender is always the
// authenticated session, which removes the entire class of "send a signal as
// someone else" attacks rather than trying to validate the claimed sender.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { toId, type, payload, token } = (body ?? {}) as Record<string, unknown>;

  const session = await resolveSession(bearerToken(request, token));
  if (!session) {
    return Response.json({ error: "unknown session" }, { status: 401 });
  }

  if (!isSessionId(toId) || toId === session.id) {
    return Response.json({ error: "invalid recipient" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  if (
    payload !== undefined &&
    payload !== null &&
    (typeof payload !== "string" || payload.length > MAX_PAYLOAD)
  ) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  const limit = rateLimit(`signal:${session.id}`, SIGNAL_LIMIT, SIGNAL_WINDOW_MS);
  if (!limit.ok) {
    return Response.json(
      { error: "too many signals" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const signalType = type as SignalType;
  const payloadStr = typeof payload === "string" ? payload : null;
  const now = new Date();

  // Take a busy lease on a session that is currently free. The `busy: false`
  // predicate makes this atomic: two simultaneous requests to the same target
  // cannot both observe it as free, because only one conditional UPDATE can
  // match. This closes the check-then-act race a prior read-then-write had.
  const takeLease = (id: string) =>
    prisma.presence.updateMany({
      where: { id, busy: false },
      data: { busy: true, busyAt: now },
    });

  const releaseLease = (id: string) =>
    prisma.presence.updateMany({
      where: { id },
      data: { busy: false, busyAt: null },
    });

  if (signalType === "request") {
    // Reserve the target first: they are the contended party. A count of 0
    // means either "already busy" or "gone" — both are an auto-decline, and
    // distinguishing them would leak nothing useful to the initiator.
    const targetLease = await takeLease(toId);
    if (targetLease.count === 0) {
      await sendDecline(toId, session.id);
      return Response.json({ ok: true, autoDeclined: true });
    }

    // Then reserve ourselves, rolling back the target if we can't — otherwise
    // a request we immediately abandon would wedge the target.
    const selfLease = await takeLease(session.id);
    if (selfLease.count === 0) {
      await releaseLease(toId);
      await sendDecline(toId, session.id);
      return Response.json({ ok: true, autoDeclined: true });
    }
  } else if (signalType === "accept") {
    // Both sides were already leased at `request` time. Requiring that to still
    // hold means `accept` cannot fabricate a connection between two users who
    // never asked for one.
    const confirmed = await prisma.presence.updateMany({
      where: { id: { in: [session.id, toId] }, busy: true },
      data: { busyAt: now },
    });
    if (confirmed.count !== 2) {
      return Response.json({ error: "no pending request" }, { status: 409 });
    }
  } else if (signalType === "decline" || signalType === "end") {
    // Free both peers. `end` belongs here too: leaving it out is what made a
    // finished connection leave both users permanently unconnectable.
    await releaseLease(session.id);
    await releaseLease(toId);
  }

  await prisma.signal.create({
    data: { fromId: session.id, toId, type: signalType, payload: payloadStr },
  });

  return Response.json({ ok: true });
}

// Helper: deliver an auto-decline from `targetId` back to `initiator`.
async function sendDecline(targetId: string, initiatorId: string) {
  await prisma.signal.create({
    data: { fromId: targetId, toId: initiatorId, type: "decline", payload: null },
  });
}
