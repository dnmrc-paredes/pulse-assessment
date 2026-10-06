import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STARTERS, pickStarter } from "../lib/icebreakers.ts";

describe("STARTERS", () => {
  it("is non-empty and free of duplicates", () => {
    assert.ok(STARTERS.length >= 12, `only ${STARTERS.length} starters`);
    const texts = STARTERS.map((s) => s.text);
    assert.equal(new Set(texts).size, texts.length, "duplicate starter text");
  });

  it("has a unique nudge for every starter that declares one", () => {
    const nudges = STARTERS.filter((s) => s.nudge).map((s) => s.nudge!);
    assert.equal(new Set(nudges).size, nudges.length, "duplicate nudge");
  });

  it("keeps every starter to one short answerable line", () => {
    for (const s of STARTERS) {
      assert.ok(s.text.length > 10, `too short: ${s.text}`);
      assert.ok(s.text.length <= 120, `too long (${s.text.length}): ${s.text}`);
      assert.ok(s.text.trim().endsWith("?"), `not a question: ${s.text}`);
    }
  });

  it("asks for nothing that invites disclosure from a stranger", () => {
    // Deliberately blunt: this list is served to someone you just met, so
    // anything asking for age, exact location, contact details or identity is
    // disqualifying on sight.
    const banned = [
      /\bage\b/i,
      /\bold\b/i,
      /\bwhere exactly\b/i,
      /\baddress\b/i,
      /\bphone\b/i,
      /\binstagram\b|\btiktok\b|\bsnapchat\b|\bwhatsapp\b|\btwitter\b|\bsocial\b|\bhandle\b/i,
      /\bname\b/i,
      /\bwork\b.*\bcompany\b/i,
    ];
    for (const s of STARTERS) {
      for (const pattern of banned) {
        assert.ok(
          !pattern.test(s.text),
          `"${s.text}" matches disallowed pattern ${pattern}`,
        );
      }
    }
  });
});

describe("pickStarter", () => {
  it("cycles deterministically so the choice is testable", () => {
    assert.equal(pickStarter(0).text, STARTERS[0].text);
    assert.equal(pickStarter(1).text, STARTERS[1].text);
    assert.equal(pickStarter(5).text, STARTERS[5].text);
  });

  it("handles negative sequence numbers", () => {
    const a = pickStarter(-1);
    assert.ok(STARTERS.some((s) => s.text === a.text));
  });

  it("never repeats the starter it is told to avoid", () => {
    for (let i = 0; i < 40; i++) {
      const first = pickStarter(i);
      const second = pickStarter(i + 1, first.text);
      assert.notEqual(second.text, first.text, `repeated at sequence ${i}`);
    }
  });

  it("still returns a starter when the avoided text is the whole pool", () => {
    // Degenerate input must not return undefined.
    const only = STARTERS[0].text;
    const result = pickStarter(0, only);
    assert.ok(result && typeof result.text === "string" && result.text.length > 0);
  });

  it("eventually reaches every starter", () => {
    const seen = new Set<string>();
    for (let i = 0; i < STARTERS.length; i++) seen.add(pickStarter(i).text);
    assert.equal(seen.size, STARTERS.length);
  });
});
