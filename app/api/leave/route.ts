import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { bearerToken, resolveSession } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEAVE_LIMIT = 30;
const LEAVE_WINDOW_MS = 60_000;

// POST /api/leave — body { token }. Removes the presence row and any pending
// signals to/from this session. Fired by navigator.sendBeacon on tab close, so
// the body may arrive as text — parse defensively.
//
// The caller must present their own session token. Previously this route
// deleted by client-supplied id alone, which meant anyone who learned a session
// id (peers learn them by design) could evict that user and destroy their
// pending signals.
export async function POST(request: NextRequest) {
  let token: unknown;
  try {
    const text = await request.text();
    token = text ? (JSON.parse(text) as Record<string, unknown>).token : undefined;
  } catch {
    token = undefined;
  }

  const session = await resolveSession(bearerToken(request, token));
  if (!session) {
    // Nothing to do: already gone, or not ours to remove. Idempotent by design
    // so a duplicate beacon isn't an error.
    return Response.json({ ok: true });
  }

  const limit = rateLimit(`leave:${session.id}`, LEAVE_LIMIT, LEAVE_WINDOW_MS);
  if (!limit.ok) {
    return Response.json(
      { error: "too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  // Independent cleanup writes — no atomicity needed (and interactive
  // transactions are unreliable over a PgBouncer pooler). Both predicates are
  // index-backed (Signal.toId, Signal.fromId).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: session.id }, { fromId: session.id }] },
  });
  await prisma.presence.deleteMany({ where: { id: session.id } });

  return Response.json({ ok: true });
}
