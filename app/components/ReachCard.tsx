"use client";

import { useEffect, useRef } from "react";
import { BAND_LABEL, type DistanceBand } from "@/lib/distance";
import { DAYPART_LABEL, type EstimatedLocalTime } from "@/lib/localtime";
import type { Starter } from "@/lib/icebreakers";

const DISMISS_AFTER_MS = 11_000;

// The moment right after a connection is established is the one place where
// telling someone who they just reached actually helps. Shown once per
// connection, then it gets out of the way and the context lives in the chat
// header from then on.
export default function ReachCard({
  band,
  localTime,
  starter,
  onDismiss,
}: {
  band: DistanceBand;
  localTime: EstimatedLocalTime;
  starter: Starter;
  onDismiss: () => void;
}) {
  const timer = useRef<number | null>(null);

  useEffect(() => {
    timer.current = window.setTimeout(onDismiss, DISMISS_AFTER_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [onDismiss]);

  // Escape closes it, matching the dialog behaviour elsewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    // Top-anchored rather than centred: on mobile the chat sheet occupies the
    // bottom 75dvh, so a centred card would land underneath it.
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 md:right-[var(--panel-w)]"
      style={{ paddingTop: "max(4.5rem, calc(env(safe-area-inset-top) + 4rem))" }}
    >
      <div
        className="reach-in pointer-events-auto w-full max-w-sm rounded-2xl border border-zinc-700/80 bg-zinc-950/95 p-4 shadow-2xl backdrop-blur"
        role="region"
        aria-label="Who you connected with"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">
              {BAND_LABEL[band]}
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {localTime.label} · {DAYPART_LABEL[localTime.daypart]} for them
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="mt-3 border-t border-zinc-800 pt-3">
          {starter.nudge && (
            <p className="text-[11px] uppercase tracking-wide text-zinc-600">
              {starter.nudge}
            </p>
          )}
          <p className="mt-1 text-sm leading-relaxed text-zinc-200">
            {starter.text}
          </p>
        </div>
      </div>
    </div>
  );
}
