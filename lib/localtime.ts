// Estimating a stranger's local time.
//
// There is no timezone database here and no geocoding call, because the app
// deliberately stores nothing and talks to no third party. This derives an
// approximate local hour from longitude alone: the sun crosses 15 degrees of
// longitude per hour, so longitude/15 is the offset from UTC.
//
// It is an ESTIMATE and is labelled as one in the UI. It ignores latitude
// (which shifts daylight hours), the shape of a timezone boundary, and whether
// the person is observing DST. For "roughly what time is it where they are"
// that is accurate enough; it would be wrong to present as their exact clock.
//
// Both coordinates involved are already privacy-offset server-side, so this is
// based on approximate position to begin with.

export type Daypart =
  | "small-hours"
  | "early-morning"
  | "morning"
  | "afternoon"
  | "evening"
  | "night";

export const DAYPART_LABEL: Record<Daypart, string> = {
  "small-hours": "the small hours",
  "early-morning": "early morning",
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
  night: "night",
};

const HOURS_PER_DAY = 24;
const DEGREES_PER_HOUR = 15;

export interface EstimatedLocalTime {
  /** Whole hour, 0–23. */
  hour: number;
  /** Minutes past the hour, 0–59. */
  minute: number;
  daypart: Daypart;
  /** e.g. "roughly 3pm where they are" */
  label: string;
}

export function daypartFor(hour: number): Daypart {
  if (hour < 5) return "small-hours";
  if (hour < 9) return "early-morning";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

// 12-hour clock without a leading zero, so "3pm" rather than "03:00pm".
function formatHour(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${suffix}`;
}

export function estimatedLocalTime(
  lng: number,
  at: Date = new Date(),
): EstimatedLocalTime {
  // Wrap into -180..180 first so a longitude just over the antimeridian does
  // not produce an hour that is wildly out.
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;

  const offsetHours = wrappedLng / DEGREES_PER_HOUR;
  const utcMinutes =
    at.getUTCHours() * 60 + at.getUTCMinutes() + at.getUTCSeconds() / 60;

  let minutes = utcMinutes + offsetHours * 60;
  minutes = ((minutes % (HOURS_PER_DAY * 60)) + HOURS_PER_DAY * 60) % (HOURS_PER_DAY * 60);

  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);

  return {
    hour,
    minute,
    daypart: daypartFor(hour),
    label: `roughly ${formatHour(hour)} where they are`,
  };
}
