// Distance banding.
//
// Both coordinates in any comparison are already privacy-offset server-side, so
// the underlying number is approximate by construction. Presenting it as bands
// rather than a precise figure is therefore both the honest reading and the
// more private one — "a few km away" does not narrow anyone's location.
//
// Bands are deliberately coarse. Finer gradations would imply a precision the
// data does not have.
export type DistanceBand = "very-near" | "near" | "regional" | "far" | "ocean";

export const BAND_THRESHOLDS_KM = [10, 50, 500] as const;

export const BAND_LABEL: Record<DistanceBand, string> = {
  "very-near": "A few km away",
  near: "Within ~50 km",
  regional: "Same region",
  far: "Far away",
  ocean: "Other side of the world",
};

// Ordered coolest-to-warmest so the map reads as a gradient of reachability.
const BAND_COLOR: Record<DistanceBand, string> = {
  "very-near": "#34d399", // emerald — closest
  near: "#a3e635", // lime
  regional: "#fbbf24", // amber
  far: "#fb923c", // orange
  ocean: "#94a3b8", // slate — effectively unreachable
};

export function distanceBand(km: number): DistanceBand {
  if (km < BAND_THRESHOLDS_KM[0]) return "very-near";
  if (km < BAND_THRESHOLDS_KM[1]) return "near";
  if (km < BAND_THRESHOLDS_KM[2]) return "regional";
  if (km < 8000) return "far";
  return "ocean";
}

export function bandColor(band: DistanceBand): string {
  return BAND_COLOR[band];
}

// Great-circle distance in km. Clamps latitude so a poleward coordinate cannot
// produce a longitude blow-up.
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
