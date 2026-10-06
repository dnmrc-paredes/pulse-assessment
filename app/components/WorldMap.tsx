"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import {
  BAND_LABEL,
  bandColor,
  distanceBand,
  haversineKm,
  type DistanceBand,
} from "@/lib/distance";

// Read the token from the environment only — never hardcode a `pk.` value or
// fall back to a placeholder. A placeholder looks like a real token to
// Mapbox's own checks, so the map fails closed as a blank canvas with no error
// instead of reaching the "set NEXT_PUBLIC_MAPBOX_TOKEN" state below.
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const MISSING_TOKEN = !TOKEN || TOKEN.startsWith("pk.your_");

// Viewport clamping for auto-fit. maxZoom stops a single nearby peer from
// slamming the camera to street level; minZoom stops a globally-spread peer
// set from zooming out to a featureless globe.
const FIT_PADDING = 72;
const FIT_MAX_ZOOM = 11;
const FIT_MIN_ZOOM = 1;
const FIT_DURATION_MS = 700;

// Colour now encodes distance band rather than a hash of the session id.
// Previously each dot got an arbitrary hue with no legend, which looked
// meaningful and was not — so the colour has to be derived from something the
// user can actually reason about.
function dotColor(band: DistanceBand): string {
  return bandColor(band);
}

export default function WorldMap({
  peers,
  me,
  onPeerClick,
  canConnect,
  compact = false,
  presenceState = "populated",
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
  // True while a panel covers the lower half of the screen on mobile.
  compact?: boolean;
  // "loading" until the first poll returns, then "empty" or "populated". Kept
  // distinct so the app does not claim nobody is online before it has checked.
  presenceState?: "loading" | "empty" | "populated";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const meMarkerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  // Marker click handlers are bound once, so read the live click handler +
  // connectability through refs (synced in an effect, never during render).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
  });

  // Band a peer relative to our own published position. Without a known
  // position every peer reads as "far", which would be misleading rather than
  // merely unhelpful.
  function describeBand(peer: PeerDot): DistanceBand {
    const origin = meRef.current;
    if (!origin) return "far";
    return distanceBand(haversineKm(origin, { lat: peer.lat, lng: peer.lng }));
  }

  // Live mirrors of the props, so the viewport helpers below don't need to be
  // rebuilt (and re-triggered) every time a peer list changes.
  const peersRef = useRef(peers);
  const meRef = useRef(me);
  // Set once the camera has framed the user *and* at least one peer. After
  // that the viewport belongs to the user — otherwise every peer join/leave
  // would yank the map out from under them mid-pan.
  const hasFittedRef = useRef(false);

  useEffect(() => {
    peersRef.current = peers;
    meRef.current = me;
  });

  const fitToPeers = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const mapboxgl = (await import("mapbox-gl")).default;

    const points: [number, number][] = [];
    const mePoint = meRef.current;
    if (mePoint) points.push([mePoint.lng, mePoint.lat]);
    for (const p of peersRef.current) points.push([p.lng, p.lat]);

    if (points.length === 0) return;
    if (points.length === 1) {
      map.easeTo({ center: points[0], zoom: 6, duration: FIT_DURATION_MS });
      return;
    }
    const bounds = new mapboxgl.LngLatBounds();
    for (const pt of points) bounds.extend(pt);
    map.fitBounds(bounds, {
      padding: FIT_PADDING,
      maxZoom: FIT_MAX_ZOOM,
      minZoom: FIT_MIN_ZOOM,
      duration: FIT_DURATION_MS,
    });
  }, []);

  // Frame the user and their peers the first time anyone shows up. Without
  // this, two people on opposite sides of the planet are simply unreachable:
  // the map opens centred on you at zoom 4, and a peer 1850km away sits
  // roughly 1300px outside the viewport with no way to know they exist.
  useEffect(() => {
    if (!ready || hasFittedRef.current || peers.length === 0) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fitToPeers();
      hasFittedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, peers.length, fitToPeers]);

  // Initialise the map once.
  useEffect(() => {
    if (MISSING_TOKEN || !containerRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/dark-v11",
        // Open centered on the user if we know where they are, else world view.
        center: me ? [me.lng, me.lat] : [0, 20],
        zoom: me ? 4 : 1.4,
        attributionControl: true,
      });
      map.on("load", () => {
        if (!cancelled) {
          // A fresh map starts un-fitted, so the first peer to appear frames
          // the view again (relevant when the map is torn down and remounted).
          hasFittedRef.current = false;
          setReady(true);
        }
      });
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      markers.forEach((m) => m.remove());
      markers.clear();
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // `me` is only read for the initial center; we don't want to re-init on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The map is created before we know where the server placed us (that only
  // arrives with the first poll), so it initialises on a world view and then
  // drops in. Doing this once also avoids snapping the camera on every poll.
  const hasCentredRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me || hasCentredRef.current) return;
    hasCentredRef.current = true;
    map.easeTo({ center: [me.lng, me.lat], zoom: 5, duration: 900 });
  }, [me, ready]);

  // Show / move the user's own "you are here" pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!meMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "pulse-me";
        el.title = "You are here";
        el.innerHTML = `<span class="pulse-me-label">Me</span>📍`;
        // anchor "bottom" → the pin's tip sits on the exact coordinate.
        meMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
      } else {
        meMarkerRef.current.setLngLat([me.lng, me.lat]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me, ready]);

  // Reconcile markers whenever the peer list changes (or the map becomes ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const markers = markersRef.current;
      const seen = new Set<string>();

      for (const peer of peers) {
        seen.add(peer.id);
        let marker = markers.get(peer.id);
        const band = describeBand(peer);
        if (!marker) {
          const el = document.createElement("button");
          el.className = "pulse-dot";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (canConnectRef.current) onPeerClickRef.current(peer.id);
          });
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        }
        // Re-applied on every pass rather than only at creation. The band
        // depends on our own published position, which can arrive after the
        // first markers are created — setting colour once at creation would
        // bake in the no-position fallback and never correct it.
        const el = marker.getElement();
        el.style.setProperty("--dot-color", dotColor(band));
        el.title = `${BAND_LABEL[band]} — tap to connect`;
        // The dot is an icon-only control, so it needs an accessible name.
        el.setAttribute("aria-label", `Connect to someone ${BAND_LABEL[band].toLowerCase()}`);
        el.dataset.busy = peer.busy ? "true" : "false";
      }

      // Drop markers for peers that went offline / got filtered out.
      for (const [id, marker] of markers) {
        if (!seen.has(id)) {
          marker.remove();
          markers.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-zinc-900" />

      {MISSING_TOKEN && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="max-w-md rounded-lg bg-zinc-800 p-4 text-sm text-zinc-200">
            Set{" "}
            <code className="text-emerald-400">NEXT_PUBLIC_MAPBOX_TOKEN</code> in{" "}
            <code>.env</code> to load the map.
          </p>
        </div>
      )}

      {/* Empty / loading state.

          On a fresh deployment nobody is ever online, so without this the first
          thing anyone sees is a blank map and a "0 online" pill — which reads as
          broken rather than as "waiting". Loading and confirmed-empty are
          distinguished: showing "nobody here yet" before the first poll returns
          would be a lie, and would flicker.
          aria-live because this is genuinely status information. */}
      {!MISSING_TOKEN && presenceState !== "populated" && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-6"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          role="status"
          aria-live="polite"
        >
          <div className="max-w-xs rounded-2xl border border-zinc-800 bg-zinc-950/85 px-6 py-7 text-center backdrop-blur-sm">
            <div
              aria-hidden="true"
              className={`mx-auto mb-4 h-10 w-10 rounded-full border-2 border-emerald-400/70 ${
                presenceState === "loading" ? "pulse-loader" : "pulse-idle"
              }`}
            />
            <p className="font-semibold text-zinc-100">
              {presenceState === "loading"
                ? "Finding people near you"
                : "Nobody else is here yet"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {presenceState === "loading" ? (
                <>One moment — checking who&rsquo;s around.</>
              ) : (
                <>
                  You&rsquo;re on the map. Keep this tab open and you&rsquo;ll
                  appear as soon as someone else joins.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Online count. Lifted above the home indicator, and hidden on mobile
          while the conversation sheet is open (the parent tells us via
          `compact`) so it does not sit behind the sheet. */}
      <div
        className={`absolute left-4 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur ${
          compact ? "hidden md:block" : ""
        }`}
        style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {peers.length} online
      </div>

      {/* Manual re-frame. Auto-fit deliberately runs only once, so this is how
          you get the "where is everyone" view back after panning away. */}
      {!MISSING_TOKEN && peers.length > 0 && (
        <button
          type="button"
          onClick={() => void fitToPeers()}
          className={`absolute right-4 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur transition hover:bg-zinc-800 hover:text-zinc-100 ${
            compact ? "hidden md:block" : ""
          }`}
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          Fit to people
        </button>
      )}
    </div>
  );
}
