"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_CHAT_CHARS } from "@/lib/validate";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
}

export default function ChatPanel({
  messages,
  connected,
  videoBusy,
  peerTyping,
  onDraftChange,
  onSend,
  onStartVideo,
  onEnd,
}: {
  messages: ChatMessage[];
  connected: boolean;
  videoBusy: boolean;
  peerTyping: boolean;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStartVideo: () => void;
  onEnd: () => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    onSend(text);
    setDraft("");
  }

  return (
    // Mobile-first: a bottom sheet that leaves the map visible above it, so you
    // can still see who you are talking to. From md up it becomes the
    // full-height side panel, which is what it always was.
    //
    // dvh rather than vh so the sheet tracks the collapsing browser toolbar,
    // and max-h keeps it usable in landscape instead of filling the screen.
    <aside
      aria-label="Conversation with stranger"
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[75dvh] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl
                 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-full md:max-w-md md:rounded-none md:border-t-0 md:border-l"
    >
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">Stranger</p>
          {/* The handshake used to go from a bare "Connecting…" straight to a
              silently-appearing chat panel, so nothing acknowledged that the
              connection actually succeeded. Live region, because the state
              change is the whole point of this moment. */}
          <p
            className="flex items-center gap-1.5 text-xs text-zinc-500"
            role="status"
            aria-live="polite"
          >
            {connected ? (
              <>
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"
                />
                Connected
              </>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="conn-spinner inline-block h-2.5 w-2.5 rounded-full border border-zinc-500 border-t-emerald-400"
                />
                Connecting&hellip;
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {/* min-h-11 keeps these at a 44px touch target; they were ~30px. */}
          <button
            onClick={onStartVideo}
            disabled={!connected || videoBusy}
            className="min-h-11 rounded-full border border-zinc-700 px-4 text-sm hover:border-zinc-500 disabled:opacity-40"
          >
            Video
          </button>
          <button
            onClick={onEnd}
            className="min-h-11 rounded-full bg-red-500 px-4 text-sm font-medium text-white hover:bg-red-400"
          >
            End
          </button>
        </div>
      </header>

      {/* min-h-0 is required: a flex child with overflow-y-auto will not shrink
          below its content height without it, so the sheet grows past 75dvh and
          the input row gets pushed off screen. */}
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        tabIndex={0}
      >
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-zinc-500">
            Say hello. Messages are peer-to-peer and never stored.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.mine ? "justify-end" : "justify-start"}`}
          >
            <span
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                m.mine
                  ? "bg-emerald-400 text-zinc-950"
                  : "bg-zinc-800 text-zinc-100"
              }`}
            >
              {/* Who said it is implied by alignment alone, so a screen reader
                  needs it stated. */}
              <span className="sr-only">
                {m.mine ? "You said: " : "They said: "}
              </span>
              {m.text}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Typing indicator. Announced politely so it reaches a screen reader
          without stealing focus. */}
      <div
        className="h-5 px-4 text-xs text-zinc-500"
        role="status"
        aria-live="polite"
      >
        {peerTyping ? (
          <span className="inline-flex items-center gap-1">
            typing
            <span aria-hidden="true" className="typing-dots">
              <i />
              <i />
              <i />
            </span>
          </span>
        ) : null}
      </div>

      {/* pb uses max() so the row clears the home indicator on notched devices
          while still looking right where there is no inset. text-base on the
          input stops iOS Safari zooming the viewport on focus. */}
      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-zinc-800 p-3 pt-3"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onDraftChange(e.target.value);
          }}
          // Capped well under the SCTP max message size — an oversized frame
          // is dropped by the transport rather than delivered.
          maxLength={MAX_CHAT_CHARS}
          placeholder={connected ? "Type a message…" : "Connecting…"}
          disabled={!connected}
          aria-label="Message"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-full bg-zinc-900 px-4 text-base outline-none placeholder:text-zinc-600 focus:ring-1 focus:ring-emerald-400 disabled:opacity-50 sm:text-sm"
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim()}
          className="min-h-11 shrink-0 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-zinc-950 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </aside>
  );
}
