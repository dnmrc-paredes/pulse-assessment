// Opt-in signaling tracing.
//
// Enabled by loading the app with `?debug=1`. Everything is routed through
// `trace()` so that in normal use this costs one boolean check and prints
// nothing — but when a connection fails silently (which is the failure mode
// that actually hurts here), the console can be read to see exactly which hop
// stopped.
const enabled =
  typeof window !== "undefined" &&
  typeof window.location !== "undefined" &&
  new URLSearchParams(window.location.search).has("debug");

export const TRACE_ENABLED = enabled;

const short = (id: string | undefined) => (id ? id.slice(0, 8) : "?");

export function trace(direction: "->" | "<-", type: string, from?: string, to?: string, bytes?: number) {
  if (!enabled) return;
  const size = bytes === undefined ? "" : ` ${bytes}b`;
  console.log(`[pulse] ${direction} ${type} ${direction === "->" ? `${short(from)}->${short(to)}` : `${short(from)}->me`}${size}`);
}

export function traceEvent(label: string, detail?: unknown) {
  if (!enabled) return;
  console.log(`[pulse] ${label}`, detail ?? "");
}
