"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";

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

function dotColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360}, 70%, 60%)`;
}

export default function WorldMap({
  peers,
  me,
  onPeerClick,
  canConnect,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
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
        if (!marker) {
          const el = document.createElement("button");
          el.className = "pulse-dot";
          el.style.background = dotColor(peer.id);
          el.title = "Tap to connect";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (canConnectRef.current) onPeerClickRef.current(peer.id);
          });
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        }
        marker.getElement().style.opacity = peer.busy ? "0.35" : "1";
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

      {/* Online count */}
      <div className="absolute bottom-4 left-4 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur">
        {peers.length} online
      </div>

      {/* Manual re-frame. Auto-fit deliberately runs only once, so this is how
          you get the "where is everyone" view back after panning away. */}
      {!MISSING_TOKEN && peers.length > 0 && (
        <button
          type="button"
          onClick={() => void fitToPeers()}
          className="absolute bottom-4 right-4 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur transition hover:bg-zinc-800 hover:text-zinc-100"
        >
          Fit to people
        </button>
      )}
    </div>
  );
}
