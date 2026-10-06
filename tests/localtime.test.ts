import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DAYPART_LABEL,
  daypartFor,
  estimatedLocalTime,
  type Daypart,
} from "../lib/localtime.ts";

describe("daypartFor", () => {
  it("covers every hour of the day exactly once", () => {
    const seen = new Set<Daypart>();
    for (let h = 0; h < 24; h++) seen.add(daypartFor(h));
    assert.equal(seen.size, Object.keys(DAYPART_LABEL).length);
    for (const h of Object.keys(DAYPART_LABEL) as unknown as Daypart[]) {
      assert.ok(DAYPART_LABEL[h].length > 0);
    }
  });

  it("maps the intuitive boundaries", () => {
    assert.equal(daypartFor(0), "small-hours");
    assert.equal(daypartFor(4), "small-hours");
    assert.equal(daypartFor(5), "early-morning");
    assert.equal(daypartFor(11), "morning");
    assert.equal(daypartFor(12), "afternoon");
    assert.equal(daypartFor(17), "afternoon");
    assert.equal(daypartFor(18), "evening");
    assert.equal(daypartFor(21), "evening");
    assert.equal(daypartFor(22), "night");
    assert.equal(daypartFor(23), "night");
  });

  it("is monotonic through the day", () => {
    const order: Daypart[] = [
      "small-hours",
      "early-morning",
      "morning",
      "afternoon",
      "evening",
      "night",
    ];
    let previous = -1;
    for (let h = 0; h < 24; h++) {
      const index = order.indexOf(daypartFor(h));
      assert.ok(index >= previous, `daypart went backwards at ${h}`);
      previous = index;
    }
  });
});

describe("estimatedLocalTime", () => {
  // 2024-01-01T12:00:00Z is the reference instant for all of these.
  const noon = new Date("2024-01-01T12:00:00Z");

  it("returns UTC time at longitude 0", () => {
    const t = estimatedLocalTime(0, noon);
    assert.equal(t.hour, 12);
    assert.equal(t.minute, 0);
    assert.equal(t.label, "roughly 12pm where they are");
  });

  it("shifts by 15 degrees per hour", () => {
    // 15° east is +1h, 30° east +2h, 45° west -3h.
    assert.equal(estimatedLocalTime(15, noon).hour, 13);
    assert.equal(estimatedLocalTime(30, noon).hour, 14);
    assert.equal(estimatedLocalTime(-45, noon).hour, 9);
    assert.equal(estimatedLocalTime(90, noon).hour, 18);
    assert.equal(estimatedLocalTime(-90, noon).hour, 6);
  });

  it("wraps past midnight in both directions", () => {
    assert.equal(estimatedLocalTime(180, noon).hour, 0); // +12h
    assert.equal(estimatedLocalTime(-180, noon).hour, 0); // -12h
    assert.equal(estimatedLocalTime(170, noon).hour, 23);
  });

  it("treats longitudes differing by 360 as the same meridian", () => {
    // The invariant matters more than any hand-computed hour. An earlier draft
    // of this test asserted specific hours for 190 and -190 that I derived by
    // mental arithmetic and got wrong: 190 wraps to -170, which is 11h20m
    // behind UTC, so noon becomes 00:40 — not 11am.
    for (const base of [-170, -90, 0, 37, 90, 170, 180]) {
      const expected = estimatedLocalTime(base, noon);
      for (const lng of [base + 360, base - 360, base + 720]) {
        const actual = estimatedLocalTime(lng, noon);
        assert.equal(actual.hour, expected.hour, `${lng} vs ${base}`);
        assert.equal(actual.minute, expected.minute, `${lng} vs ${base}`);
      }
    }
  });

  it("handles out-of-range longitudes without exploding", () => {
    // Sanity-check a few real values rather than deriving them in the test.
    assert.equal(estimatedLocalTime(180, noon).hour, 0); // +12h
    assert.equal(estimatedLocalTime(-180, noon).hour, 0); // -12h
    assert.equal(estimatedLocalTime(190, noon).hour, 0); // == -170, so late
    assert.equal(estimatedLocalTime(-190, noon).hour, 23); // == 170, so late
    assert.equal(estimatedLocalTime(540, noon).hour, 0); // == 180
  });

  it("carries minutes through", () => {
    const t = estimatedLocalTime(0, new Date("2024-01-01T12:34:00Z"));
    assert.equal(t.hour, 12);
    assert.equal(t.minute, 34);
  });

  it("handles a half-hour offset zone correctly", () => {
    // 52.5° east is +3.5h, so 12:00Z is 15:30 local.
    const t = estimatedLocalTime(52.5, noon);
    assert.equal(t.hour, 15);
    assert.equal(t.minute, 30);
  });

  it("always yields a valid hour and minute", () => {
    for (let lng = -180; lng <= 180; lng += 7) {
      for (const iso of [
        "2024-01-01T00:00:00Z",
        "2024-01-01T12:00:00Z",
        "2024-06-30T23:59:59Z",
      ]) {
        const t = estimatedLocalTime(lng, new Date(iso));
        assert.ok(Number.isInteger(t.hour) && t.hour >= 0 && t.hour <= 23, `hour ${t.hour} at ${lng}`);
        assert.ok(Number.isInteger(t.minute) && t.minute >= 0 && t.minute <= 59, `minute ${t.minute}`);
        assert.ok(typeof t.label === "string" && t.label.includes("where they are"));
      }
    }
  });

  it("uses a 12-hour clock with no leading zero", () => {
    assert.equal(estimatedLocalTime(0, new Date("2024-01-01T00:00:00Z")).label, "roughly 12am where they are");
    assert.equal(estimatedLocalTime(0, new Date("2024-01-01T09:00:00Z")).label, "roughly 9am where they are");
    assert.equal(estimatedLocalTime(0, new Date("2024-01-01T13:00:00Z")).label, "roughly 1pm where they are");
  });

  it("is monotone eastward within a single day", () => {
    let previous = estimatedLocalTime(-180, noon).hour;
    for (let lng = -175; lng <= 180; lng += 5) {
      const hour = estimatedLocalTime(lng, noon).hour;
      // Hours advance by 0 or 1 as longitude increases, wrapping at midnight.
      const delta = (hour - previous + 24) % 24;
      assert.ok(delta === 0 || delta === 1, `jumped by ${delta} at ${lng}`);
      previous = hour;
    }
  });
});
