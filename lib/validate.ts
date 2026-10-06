// Shared input-shape rules. Imported by both client and server so the two
// sides always agree on what a well-formed session id or token looks like.

export const MAX_CHAT_CHARS = 2000;

// Session ids are server-issued UUIDv4 values.
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Session tokens are 32 random bytes, base64url-encoded (43 chars, no padding).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_RE.test(v);
}

export function isToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}
