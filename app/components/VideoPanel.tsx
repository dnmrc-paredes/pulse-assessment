"use client";

import { useEffect, useRef } from "react";

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onEnd: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== remoteStream) {
      remoteRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-black">
      <div className="relative flex-1">
        {/* Remote (full screen) */}
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          aria-label="Stranger's video"
          className="h-full w-full bg-zinc-900 object-cover"
        />
        {!remoteStream && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
            Waiting for stranger&rsquo;s video…
          </div>
        )}
        {/* Local (picture-in-picture) */}
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          aria-label="Your camera"
          className="absolute h-32 w-24 rounded-lg border border-zinc-700 bg-zinc-800 object-cover sm:h-40 sm:w-28"
          style={{
            bottom: "max(1rem, env(safe-area-inset-bottom))",
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        />
      </div>
      <div
        className="flex justify-center bg-zinc-950 px-4 pt-4"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <button
          onClick={onEnd}
          className="min-h-11 rounded-full bg-red-500 px-8 font-semibold text-white hover:bg-red-400"
        >
          End video
        </button>
      </div>
    </div>
  );
}
