"use client";

// Reusable centered prompt for "someone wants to connect" and
// "someone wants to start video".
import { useEffect, useId, useRef } from "react";

export default function ConnectionPrompt({
  title,
  subtitle,
  acceptLabel,
  declineLabel,
  onAccept,
  onDecline,
  tone = "default",
}: {
  title: string;
  subtitle?: string;
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;
  onDecline: () => void;
  // "video" gets an accent so a media request is not visually identical to a
  // connection request — they used to look the same despite meaning different
  // things.
  tone?: "default" | "video";
}) {
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    // Move focus into the dialog so keyboard and screen-reader users land on
    // the decision instead of staying on the map behind it.
    acceptRef.current?.focus();
    return () => {
      // Return focus where it came from rather than dropping it on <body>.
      const el = previouslyFocused.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onDecline();
        return;
      }
      if (e.key !== "Tab") return;

      // Minimal focus trap: this is a modal, so Tab must not escape to the map
      // underneath it.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>("button");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDecline]);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        className="w-full max-w-xs rounded-2xl bg-zinc-900 p-6 text-center text-zinc-100 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {subtitle && (
          <p id={subtitleId} className="mt-1 text-sm text-zinc-400">
            {subtitle}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            onClick={onDecline}
            className="min-h-11 flex-1 rounded-full border border-zinc-700 px-4 text-sm font-medium text-zinc-300 hover:border-zinc-500"
          >
            {declineLabel}
          </button>
          <button
            ref={acceptRef}
            onClick={onAccept}
            className={
              tone === "video"
                ? "min-h-11 flex-1 rounded-full bg-sky-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-sky-300"
                : "min-h-11 flex-1 rounded-full bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
            }
          >
            {acceptLabel}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-zinc-500">Esc to decline</p>
      </div>
    </div>
  );
}
