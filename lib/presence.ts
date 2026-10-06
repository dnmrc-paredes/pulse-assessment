// How long a presence row survives without a heartbeat (poll). After this the
// dot is treated as offline and removed — implements "dot disappears when the
// user leaves" even if their tab closed without a clean leave.
//
// This must sit ABOVE the browser's background-tab timer throttling interval.
// A hidden tab has its timers clamped (to >=1s normally, and to once per minute
// once "intensive throttling" kicks in after ~5 min hidden), so a short window
// would reap users who simply switched tabs. 75s clears the 60s clamp with
// margin. Clean exits don't wait for this at all — /api/leave fires via
// sendBeacon, so this window only governs crash/reconnect cleanup.
export const STALE_MS = 75_000;

// Orphan signals (mailbox messages never drained) are cleaned up after this.
export const SIGNAL_TTL_MS = 60_000;

// Client poll interval. Kept here so client + server reason about the same cadence.
export const POLL_INTERVAL_MS = 1_500;

// How long a busy lease survives without being refreshed by its holder. The
// holder refreshes it on every poll while it has a live connection, so this is
// a liveness signal, not a call duration limit: it exists so that a crashed or
// half-closed connection releases the lock instead of wedging the user out of
// ever connecting again. Must comfortably exceed POLL_INTERVAL_MS so ordinary
// jitter never costs someone their in-progress connection.
export const BUSY_TTL_MS = 45_000;
