import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  add,
  clear,
  getServerSnapshot,
  getSnapshot,
  isBlocked,
  remove,
  subscribe,
  toggle,
} from "../lib/blocked.ts";

beforeEach(() => clear());

describe("block list", () => {
  it("starts empty", () => {
    assert.deepEqual(getSnapshot(), []);
    assert.equal(isBlocked("a"), false);
  });

  it("adds and removes", () => {
    add("peer-1");
    assert.equal(isBlocked("peer-1"), true);
    remove("peer-1");
    assert.equal(isBlocked("peer-1"), false);
  });

  it("ignores redundant operations", () => {
    add("peer-1");
    add("peer-1");
    assert.deepEqual(getSnapshot(), ["peer-1"]);
    remove("never-added");
    assert.deepEqual(getSnapshot(), ["peer-1"]);
  });

  it("toggles and reports the resulting state", () => {
    assert.equal(toggle("peer-1"), true, "toggle should report now-blocked");
    assert.equal(isBlocked("peer-1"), true);
    assert.equal(toggle("peer-1"), false, "toggle should report now-unblocked");
    assert.equal(isBlocked("peer-1"), false);
  });

  it("clears everything", () => {
    add("a");
    add("b");
    clear();
    assert.deepEqual(getSnapshot(), []);
  });

  it("returns a sorted snapshot", () => {
    add("zeta");
    add("alpha");
    add("mid");
    assert.deepEqual(getSnapshot(), ["alpha", "mid", "zeta"]);
  });

  it("returns a REFERENTIALLY STABLE snapshot between mutations", () => {
    // useSyncExternalStore compares getSnapshot() by identity. Returning a new
    // array each call makes React think the store changed on every render and
    // loops forever — which it did, in production, until this was fixed. An
    // earlier version of this test asserted the opposite ("new array each read
    // is fine"), so the requirement is now pinned explicitly.
    const before = getSnapshot();
    assert.equal(getSnapshot(), before, "identity must hold with no mutations");

    add("peer-1");
    const afterAdd = getSnapshot();
    assert.equal(afterAdd, getSnapshot(), "identity must hold after a mutation");
    assert.notEqual(afterAdd, before, "identity must change when contents change");

    remove("peer-1");
    assert.equal(getSnapshot(), getSnapshot(), "identity must hold after removal");
  });

  it("keeps the same identity across many consecutive reads", () => {
    add("a");
    add("b");
    const first = getSnapshot();
    for (let i = 0; i < 100; i++) {
      assert.equal(getSnapshot(), first, `read ${i} returned a new array`);
    }
  });

  it("exposes a stable server snapshot that never changes", () => {
    const a = getServerSnapshot();
    add("peer-1");
    assert.equal(getServerSnapshot(), a, "server snapshot must stay empty");
    assert.deepEqual(a, []);
    clear();
  });

  it("does not hand out a mutable snapshot", () => {
    add("peer-1");
    const snap = getSnapshot();
    assert.ok(Object.isFrozen(snap), "snapshot must be frozen");
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    let calls = 0;
    const off = subscribe(() => calls++);

    add("a");
    assert.equal(calls, 1);
    add("a"); // no-op, must not notify
    assert.equal(calls, 1);
    remove("a");
    assert.equal(calls, 2);

    off();
    add("b");
    assert.equal(calls, 2, "must not notify after unsubscribe");
  });

  it("does not notify when cleared while already empty", () => {
    let calls = 0;
    const off = subscribe(() => calls++);
    clear();
    assert.equal(calls, 0);
    off();
  });

  it("supports multiple independent subscribers", () => {
    let a = 0;
    let b = 0;
    const offA = subscribe(() => a++);
    const offB = subscribe(() => b++);
    add("x");
    assert.equal(a, 1);
    assert.equal(b, 1);
    offA();
    offB();
    add("y");
    assert.equal(a, 1);
    assert.equal(b, 1);
  });
});
