import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeNetwork,
  initialNetwork,
  type NetworkSnapshot,
} from "../lib/netstatus.ts";

const snap = (o: Partial<NetworkSnapshot>): NetworkSnapshot => ({
  ...initialNetwork(),
  ...o,
});

describe("describeNetwork", () => {
  it("reports ok once ICE has a usable pair", () => {
    assert.equal(describeNetwork(snap({ ice: "connected" })).kind, "ok");
    assert.equal(describeNetwork(snap({ ice: "completed" })).kind, "ok");
  });

  it("reports ok even if gathering errored, once connected", () => {
    const v = describeNetwork(snap({ ice: "connected", gatheringErrors: 3 }));
    assert.equal(v.kind, "ok");
  });

  it("names the likely cause when gathering never completed", () => {
    const v = describeNetwork(snap({ ice: "failed", gathering: "gathering" }));
    assert.equal(v.kind, "blocked");
    assert.match(v.hint, /network may be blocking/i);
  });

  it("names candidate errors specifically", () => {
    const v = describeNetwork(snap({ ice: "failed", gathering: "complete", gatheringErrors: 1 }));
    assert.equal(v.kind, "blocked");
    assert.match(v.hint, /network may be blocking/i);
  });

  it("falls back to a generic hint when gathering succeeded but ICE still failed", () => {
    // Gathering completed and no server errored, so blaming the network
    // specifically would be a guess.
    const v = describeNetwork(snap({ ice: "failed", gathering: "complete", gatheringErrors: 0 }));
    assert.equal(v.kind, "blocked");
    assert.match(v.hint, /direct path/i);
    assert.doesNotMatch(v.hint, /may be blocking/i);
  });

  it("treats closed as terminal", () => {
    assert.equal(describeNetwork(snap({ ice: "closed" })).kind, "blocked");
  });

  it("treats a mid-call dropout differently from a failed connection", () => {
    const dropped = describeNetwork(snap({ ice: "disconnected", everConnected: true }));
    assert.equal(dropped.kind, "degraded");
    assert.match(dropped.message, /dropped/i);

    const failed = describeNetwork(snap({ ice: "failed", everConnected: true }));
    assert.equal(failed.kind, "degraded", "must not blame the network for a mid-call drop");
    assert.match(failed.message, /dropped/i);
  });

  it("gives progress messages that are distinct from each other", () => {
    const messages = new Set(
      [
        describeNetwork(snap({ ice: "checking" })),
        describeNetwork(snap({ ice: "new", gathering: "gathering" })),
        describeNetwork(snap({ ice: "new", gathering: "new" })),
        describeNetwork(snap({ ice: "new", gatheringErrors: 2 })),
      ].map((v) => (v.kind === "progress" ? v.message : "")),
    );
    assert.equal(messages.size, 4, "each progress state should read differently");
  });

  it("always produces something for every ICE state", () => {
    const states = ["new","checking","connected","completed","failed","disconnected","closed"] as const;
    for (const ice of states) {
      for (const gathering of ["new","gathering","complete"] as const) {
        const v = describeNetwork(snap({ ice, gathering }));
        assert.ok(v.kind, `${ice}/${gathering} produced no verdict`);
        if (v.kind !== "ok") {
          assert.ok(v.message.length > 0, `${ice}/${gathering} has an empty message`);
        }
      }
    }
  });

  it("never tells the user something is fine while it is not", () => {
    for (const ice of ["new","checking","failed","disconnected","closed"] as const) {
      assert.notEqual(describeNetwork(snap({ ice })).kind, "ok", `${ice} must not read as ok`);
    }
  });

  it("keeps hints to one sentence so they stay readable", () => {
    for (const ice of ["failed","closed","disconnected"] as const) {
      const v = describeNetwork(snap({ ice }));
      if (v.kind === "blocked" || v.kind === "degraded") {
        assert.ok(v.hint.length < 140, `hint too long for ${ice}: ${v.hint.length}`);
        assert.ok(v.message.length < 60, `message too long for ${ice}: ${v.message.length}`);
      }
    }
  });
});
