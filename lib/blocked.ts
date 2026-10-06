"use client";

// Session-scoped block list.
//
// IMPORTANT SCOPE NOTE: session ids are server-issued UUIDs that are minted
// fresh on every page load, and there are no accounts. So blocking a session id
// blocks *that session*, not the person — on their next visit they get a new id
// and cannot be blocked by anything we hold.
//
// That is a deliberate consequence of the "no accounts, nothing persists"
// requirement, not an oversight. It means this list is honestly session-scoped,
// which in turn means it can live in memory only: persisting it would store
// identifiers that can never match again, so localStorage would buy nothing and
// cost the privacy guarantee. Nothing is written to disk and nothing is sent to
// the server.
//
// Enforcement is client-side, which is the correct model here: blocking exists
// for the blocker's benefit, not to constrain the blocked party. Refusing to
// dial and auto-declining their requests fully covers both directions without
// the server needing to know anything.

export type BlockListener = () => void;

const blocked = new Set<string>();
const listeners = new Set<BlockListener>();

const EMPTY: readonly string[] = Object.freeze([]);

// Cached snapshot. useSyncExternalStore requires getSnapshot to return a
// referentially stable value while the store is unchanged: returning a fresh
// array each call makes React believe the store mutated and re-render forever
// ("The result of getServerSnapshot should be cached to avoid an infinite
// loop"). It is recomputed only when the set actually changes.
let snapshot: readonly string[] = EMPTY;

function recompute() {
  snapshot = blocked.size === 0
    ? EMPTY
    : Object.freeze(Array.from(blocked).sort());
}

function emit() {
  recompute();
  for (const l of listeners) l();
}

export function subscribe(listener: BlockListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): readonly string[] {
  return snapshot;
}

export function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

export function isBlocked(id: string): boolean {
  return blocked.has(id);
}

export function add(id: string): void {
  if (blocked.has(id)) return;
  blocked.add(id);
  emit();
}

export function remove(id: string): void {
  if (!blocked.delete(id)) return;
  emit();
}

export function toggle(id: string): boolean {
  if (blocked.has(id)) {
    remove(id);
    return false;
  }
  add(id);
  return true;
}

export function clear(): void {
  if (blocked.size === 0) return;
  blocked.clear();
  emit();
}
