import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { newSessionId, newSessionToken, hashToken } from "@/lib/auth";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Join is keyed by IP because it is the only thing available before a session
// exists. The ceiling is set well above plausible real-world bursts: many users
// legitimately share one address behind CGNAT, a corporate proxy, or campus
// NAT, so a tight limit would lock out a whole office or dorm rather than an
// abuser. Session-scoped endpoints below use the session instead, where the
// key cannot be shared by accident.
const JOIN_LIMIT = 30;
const JOIN_WINDOW_MS = 10 * 60_000;

// POST /api/join — body { lat, lng } (raw coords).
//
// Mints a brand-new session and returns its credentials. The client does not
// choose its own id: identity is server-issued so that ids cannot collide and
// so that `tokenHash` is guaranteed unique.
//
// The 1-3 km privacy offset is applied here, server-side, so a modified client
// cannot publish its exact location. Raw coordinates are never stored.
export async function POST(request: NextRequest) {
  const limit = rateLimit(clientKey(request, "join"), JOIN_LIMIT, JOIN_WINDOW_MS);
  if (!limit.ok) {
    return Response.json(
      { error: "too many sessions" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { lat, lng } = (body ?? {}) as Record<string, unknown>;
  if (!isValidLatLng(lat, lng)) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }

  const offset = applyPrivacyOffset(lat as number, lng as number);
  const id = newSessionId();
  const token = newSessionToken();

  await prisma.presence.create({
    data: {
      id,
      tokenHash: hashToken(token),
      lat: offset.lat,
      lng: offset.lng,
      busy: false,
      lastSeen: new Date(),
    },
  });

  return Response.json({ ok: true, id, token });
}
