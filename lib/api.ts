// Client-side helpers for talking to the coordination API.
//
// Every authenticated call carries the session token. The token is a secret
// capability: it lives only in this tab's memory and is never put in a URL that
// a peer could observe or in a request body a peer can see.
import type { PollResponse, SignalType } from "@/lib/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SessionCredentials {
  id: string;
  token: string;
}

export async function join(
  lat: number,
  lng: number,
): Promise<SessionCredentials> {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) throw new ApiError(res.status, `join failed: ${res.status}`);
  const data = (await res.json()) as SessionCredentials;
  return data;
}

// `active` tells the server this tab holds a live connection, which keeps its
// busy lease from being reclaimed out from under an in-progress call.
export async function poll(
  token: string,
  active: boolean,
): Promise<PollResponse> {
  const query = new URLSearchParams({ token });
  if (active) query.set("active", "1");
  const res = await fetch(`/api/poll?${query.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(res.status, `poll failed: ${res.status}`);
  return res.json();
}

export async function sendSignal(
  token: string,
  toId: string,
  type: SignalType,
  payload?: string,
): Promise<void> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ toId, type, payload }),
  });
  if (!res.ok) throw new ApiError(res.status, `signal failed: ${res.status}`);
}

// Fire-and-forget leave that survives the tab closing. The token travels in the
// body because sendBeacon cannot set custom headers; /api/leave accepts that as
// a fallback to the Authorization header.
export function leave(token: string): void {
  const body = JSON.stringify({ token });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/leave", body);
  } else {
    void fetch("/api/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  }
}
