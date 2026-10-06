import { describe, it } from "node:test";
import assert from "node:assert/strict";
type Pt = { lat: number; lng: number };

import {
  bandColor,
  BAND_LABEL,
  BAND_THRESHOLDS_KM,
  distanceBand,
  haversineKm,
  type DistanceBand,
} from "../lib/distance.ts";

describe("distanceBand", () => {
  it("bands on the documented thresholds", () => {
    assert.equal(distanceBand(0), "very-near");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[0] - 0.01), "very-near");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[0]), "near");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[1] - 0.01), "near");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[1]), "regional");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[2] - 0.01), "regional");
    assert.equal(distanceBand(BAND_THRESHOLDS_KM[2]), "far");
    assert.equal(distanceBand(7999), "far");
    assert.equal(distanceBand(8000), "ocean");
  });

  it("is monotonic: distance never maps to a closer band", () => {
    const order: DistanceBand[] = ["very-near", "near", "regional", "far", "ocean"];
    let previous = -1;
    for (let km = 0; km < 12000; km += 7) {
      const index = order.indexOf(distanceBand(km));
      assert.ok(index >= previous, `band went backwards at ${km}km`);
      previous = index;
    }
  });

  it("handles nonsense input without throwing", () => {
    assert.equal(distanceBand(-5), "very-near");
    assert.equal(distanceBand(NaN), "ocean");
    assert.equal(distanceBand(Infinity), "ocean");
  });

  it("gives every band a distinct colour and a label", () => {
    const bands: DistanceBand[] = ["very-near", "near", "regional", "far", "ocean"];
    const colors = bands.map(bandColor);
    assert.equal(new Set(colors).size, bands.length, "colours must be distinct");
    for (const b of bands) assert.ok(BAND_LABEL[b].length > 0);
  });
});

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    assert.equal(haversineKm({ lat: 48.85, lng: 2.35 }, { lat: 48.85, lng: 2.35 }), 0);
  });

  it("matches known city distances", () => {
    const manila = { lat: 14.5995, lng: 120.9842 };
    const shanghai = { lat: 31.2304, lng: 121.4737 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const london = { lat: 51.5074, lng: -0.1278 };

    const manilaShanghai = haversineKm(manila, shanghai);
    assert.ok(manilaShanghai > 1800 && manilaShanghai < 1900, `got ${manilaShanghai}`);

    const parisLondon = haversineKm(paris, london);
    assert.ok(parisLondon > 330 && parisLondon < 350, `got ${parisLondon}`);

    // Cross-validate against the spherical law of cosines, an independent
    // formula. An earlier version of this test asserted a Tokyo-Lima distance I
    // had guessed from memory (16-17.5k km); the correct value is ~15,495 km and
    // both formulas agree on it exactly.
    const tokyo = { lat: 35.6762, lng: 139.6503 };
    const lima = { lat: -12.0464, lng: -77.0428 };
    const lawOfCosines = (a: Pt, b: Pt) => {
      const R = 6371;
      const r = (d: number) => (d * Math.PI) / 180;
      const p1 = r(a.lat);
      const p2 = r(b.lat);
      const dl = r(b.lng - a.lng);
      return (
        R *
        Math.acos(
          Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)),
        )
      );
    };
    const half = haversineKm(tokyo, lima);
    assert.ok(Math.abs(half - lawOfCosines(tokyo, lima)) < 0.5, `disagreement: ${half}`);
    assert.ok(half > 15000 && half < 16000, `got ${half}`);

    for (const [a, b] of [
      [paris, london],
      [paris, { lat: 31.2304, lng: 121.4737 }],
      [{ lat: 89.9, lng: 0 }, { lat: 89.9, lng: 180 }],
      [{ lat: -33.8688, lng: 151.2093 }, { lat: 51.5074, lng: -0.1278 }],
    ] as [Pt, Pt][]) {
      assert.ok(
        Math.abs(haversineKm(a, b) - lawOfCosines(a, b)) < 0.5,
        `formulas disagree for ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
      );
    }
  });

  it("is symmetric", () => {
    const a = { lat: 35.68, lng: 139.69 };
    const b = { lat: -33.87, lng: 151.21 };
    assert.ok(Math.abs(haversineKm(a, b) - haversineKm(b, a)) < 1e-9);
  });

  it("handles the poles without producing NaN", () => {
    const d = haversineKm({ lat: 89.9, lng: 0 }, { lat: 89.9, lng: 180 });
    assert.ok(Number.isFinite(d), `got ${d}`);
    assert.ok(d >= 0);
  });

  it("puts real example pairs in a sensible band", () => {
    const paris = { lat: 48.8566, lng: 2.3522 };
    const london = { lat: 51.5074, lng: -0.1278 };

    // ~4km apart across Paris -> closest band.
    assert.equal(distanceBand(haversineKm(paris, { lat: 48.89, lng: 2.33 })), "very-near");
    // 343km: within the 50-500km "regional" band, not "near".
    assert.equal(distanceBand(haversineKm(paris, london)), "regional");
    // 9250km -> effectively unreachable.
    assert.equal(distanceBand(haversineKm(paris, { lat: -33.8688, lng: 151.2093 })), "ocean");
    // Same city, opposite sides -> closest band.
    assert.equal(distanceBand(haversineKm(paris, paris)), "very-near");
  });
});
