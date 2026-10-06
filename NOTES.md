# Notes

## Phase 1 — Make it run

Four bugs, all of which broke a core flow:

- **Text chat never worked.** `sendChat` put `{ t: "msg" }` on the wire while the
  receiver only accepted `msg.t === "chat"`, so every inbound message was dropped
  and `onChat` was never called. Control messages matched by luck, which is why
  video appeared to work and chat didn't. Fixed by introducing a single
  `ChannelMsg` discriminated union that both the sender and the receiver derive
  from, so a mismatched discriminant is now a compile error.

- **Dots never disappeared** (the example in the brief). `/api/poll` heartbeated
  with `where: {}`, refreshing `lastSeen` for *every* user on *anyone's* poll. The
  staleness sweep immediately below could therefore never match a row. Fixed by
  scoping the heartbeat to the caller.

- **`busy` was never cleared on `end`.** The comment said "decline/**end**: free
  both peers" but the code only handled `decline`, so one connection left both
  users permanently auto-declined. This was the real blocker for "one connection
  at a time, and you can reconnect".

- **Unguarded `JSON.parse` in the signaling path** could reject unhandled on a
  malformed peer payload.

Two further bugs surfaced only while testing the above:

- **No deadline on `connecting`.** A peer that vanished after both sides accepted
  left this tab showing "Connecting…" forever *while continuing to refresh its own
  busy lease*, making the user permanently unconnectable. Found by an integration
  test, not by reading — worth remembering that this class of bug is invisible in
  code review and obvious in a test.
- **`STALE_MS` had to grow from 15s to 75s.** Fixing the heartbeat made staleness
  actually fire, which exposed an interaction I'd missed: browsers clamp timers in
  background tabs (to ≥1s, and to once per minute after ~5 min hidden), so a short
  window reaps users who merely switched tabs. The heartbeat bug had been masking
  this.

### Root cause of "can't establish connection": SDP was never leaving the browser

The single defect that made connections impossible, in `lib/webrtc.ts`:

```ts
this.cb.onSignal("offer", JSON.stringify(this.pc.localDescription));
```

`RTCSessionDescription` and `RTCIceCandidate` are **WebIDL** interfaces — `type`,
`sdp`, `candidate`, `sdpMid` are accessors on the *prototype*, not own properties
on the instance. `JSON.stringify` only walks own enumerable properties, so both
serialised to `{}`. Every offer and ICE candidate put `"{}"` on the wire, the
receiver correctly rejected it as malformed, and the handshake died silently
until the 20s connect deadline. Both peers stayed on "Connecting…" forever.

It is invisible locally in one sense — no error, no console warning — and fatal
in every case. It also explains why the app "worked but never connected" no
matter how many other bugs were fixed.

Fix: copy the fields into plain objects (`toSessionDescriptionInit`,
`toCandidateInit`) before serialising. Signalling here goes over JSON rather
than `postMessage`/structured clone, which is what forced the explicit copy.

Verified with a full two-peer handshake test in which the fake
`RTCPeerConnection` returns genuine prototype-accessor objects:

| | pre-fix | fixed |
|---|---|---|
| offer payload | `{}` | real SDP |
| answer produced | no | yes |
| ICE candidates applied | 0 of 2 | 2 of 2 |
| data channel opened | neither side | both sides |
| suite | 8 failed | 12 passed |

### Why connections still failed after signalling was fixed

With SDP and ICE exchange working, `connectionState` sat at `connecting`
forever. Instrumenting ICE (`iceConnectionState`, candidate-pair byte counts)
showed the cause was not our code at all:

- Chrome replaced **every host candidate with an mDNS `.local` name**
  (`candidate:… c37b88b2-1….local`). No raw local-IP candidates were offered.
- Both peers sat behind the same NAT (identical public IP), so their srflx
  candidates pointed at the same address and needed NAT hairpinning.
- STUN-only, so there was no relay to fall back on.

Resolving a `.local` candidate requires multicast DNS. Where that is filtered,
no candidate is ever viable, ICE never completes, and the failure is completely
silent — indistinguishable from "still connecting".

Verified by launching Chrome with `--disable-features=WebRtcHideLocalIpsWithMdns`,
which restores raw local-IP candidates; connections then established immediately.

**This is a local-testing workaround, not a product fix.** Chrome's mDNS
behaviour cannot be overridden by the app, so any real user on a network that
filters multicast DNS hits the same wall. The production answer is a **TURN
relay** — the one genuinely missing piece, and the reason "STUN-only" in the
brief is a real functional limitation rather than a footnote.

### The handshake was also silently discarding every ICE candidate

Found while chasing the above, and a real bug in its own right:

- **ICE candidates were flushed before the remote description was set.**
  `addIceCandidate()` is invalid until a remote description exists, so every
  buffered candidate threw; the inner `catch {}` swallowed the error *after* the
  queue had already been emptied. Candidates were destroyed, not deferred.
  Ordering is now `setRemoteDescription` → flush.
- **Inbound signals weren't serialised.** Polling delivers signals in batches and
  `page.tsx` dispatches each without awaiting the last, so `setRemoteDescription`
  and `setLocalDescription` ran concurrently against one `RTCPeerConnection` —
  overlapping async state transitions that corrupt its signaling state machine.
  Handlers now queue on a promise chain.

Why it was fatal specifically: with a 1.5s poll, an `offer` and the ICE
candidates that follow it routinely land in the *same* batch. The offer handler
had not yet resolved `setRemoteDescription` when the candidate handler checked for
it, so the candidate got queued — and then nothing ever flushed it, because the
flush had already run earlier in the same call. Verified as **0 of 6 candidates
surviving** against the old ordering.

### Changes made while diagnosing the above

- **Multiple STUN servers.** `lib/webrtc.ts` used only
  `stun:stun.l.google.com:19302`, so one unreachable server meant *zero* srflx
  candidates — which looks identical to a silent hang. Now lists Cloudflare,
  Nextcloud (`stun:stun.nextcloud.com:443`, deliberately on 443 so it survives
  networks blocking the usual UDP ports) and Twilio. Still STUN-only, so this
  helps reachability but does not replace TURN.

- **The map now frames you *and* your peers.** It previously opened centred on
  you at zoom 4 and never refitted, so a peer far away could sit outside the
  viewport with no indication they existed. It now auto-fits once when the first
  peer appears (clamped `maxZoom: 11` / `minZoom: 1`) plus a "Fit to people"
  button. Deliberately runs **once**, not on every peer change — otherwise every
  join/leave would yank the map out from under the user mid-pan.

  *Correction to an earlier claim of mine:* I first put the off-screen distance at
  ~1300px, having used a 256px tile convention. Mapbox uses 512px, so the real
  figure for a peer 1850km away is **414px** — only marginally outside a 400px
  half-viewport, and comfortably visible on a taller window. Auto-fit is a
  robustness win, not the cause of any failure.

## Phase 3 — Make it secure

Ranked by severity, highest first:

1. **No authentication at all — fixed.** `POST /api/signal` trusted a
   client-supplied `fromId`, so anyone could impersonate any session and inject
   `offer`/`answer`/`ice`/`end` into arbitrary mailboxes. `POST /api/leave`
   deleted rows by id alone, and session ids are disclosed to peers *by design*.
   Fixed by making identity server-issued and token-based:
   - `POST /api/join` mints both an `id` (public address, peers learn it) and a
     `token` (secret capability, never sent to a peer, never persisted to disk by
     the client).
   - Only `sha256(token)` is stored, so a database leak can't be replayed as a
     live session.
   - Every mutating route resolves the caller by that hash. **`fromId` no longer
     exists in the request body** — the sender is inferred, which removes the
     impersonation class rather than trying to validate a claimed sender.
   This stays within the "no accounts, nothing persists between sessions" rules:
   the token is per-session and dies with the row.

2. **TOCTOU race on the busy check — fixed.** `request` read `busy` and wrote
   later, so simultaneous requests could both pass. Now the lease is taken with a
   conditional `UPDATE ... WHERE busy = false`, which the database serialises.
   Verified with a test firing 8 concurrent requests at one target: exactly one
   wins, seven get auto-declined. `accept` additionally requires that both
   parties still hold their lease, so it can't fabricate a connection between two
   users who never asked for one.

3. **Stuck locks could never be recovered — fixed.** Correctness now rests on a
   lease rather than a latch: `busyAt` is stamped when the lock is taken and
   refreshed by the holder on each poll, and `/api/poll` reclaims any lease older
   than `BUSY_TTL_MS`. Without this, "one connection at a time → and can
   reconnect" is only true until the first crash.

4. **No rate limiting — fixed** (with a documented limitation). In-memory fixed
   windows per endpoint. This is *per-instance*: on Vercel each lambda has its own
   heap, so a distributed flood can still fan out. A global limit needs shared
   state (Redis) or a Postgres counter. The limiter's own key map is hard-capped
   and swept, since keys derive from attacker-controlled input and it would
   otherwise be an unbounded-growth vector itself.

5. **Missing indexes on the queries that exist — fixed.** `Signal` had no index on
   `fromId` (scanned by `/api/leave`) or `createdAt` (scanned by the orphan
   reaper on *every poll from every client*). Added `[toId, createdAt]`,
   `[fromId]`, `[createdAt]`, plus `[busy, busyAt]` for the lease sweep and a
   unique index on `tokenHash`.

6. **`Signal.type` was free text — fixed.** Now a Postgres enum, so an
   unrecognised value is impossible rather than merely unlikely. This also removed
   an unchecked cast on the read path.

7. **Silent client-side failures — fixed.** `join` and `sendSignal` never checked
   `res.ok`, so a 400/500 was invisible and the UI sat on "Requesting
   connection…" for the full 30s timeout.

8. **Hardcoded Mapbox token fallback — fixed.** `WorldMap` fell back to a
   placeholder `pk.…`, which made the "set `NEXT_PUBLIC_MAPBOX_TOKEN`" guard
   unreachable and failed closed as a blank canvas instead. The token now comes
   from the environment only.

Also bounded the peer list and inbox reads, capped the data-channel queue and chat
length, and unified id/token validation.

### Assumptions

- The privacy offset is applied **server-side** in `/api/join` rather than
  client-side. This is deliberately stricter than the brief's wording: a modified
  client can't publish its exact location. Raw coordinates still transit the
  server but are never stored.
- Still STUN-only, per the brief — but several STUN servers are now listed, since
  one unreachable server is equivalent to having none. A TURN relay would be the
  real fix.
- Deploying invalidates in-flight sessions (their tokens were issued by the
  previous code). The migration is written to survive that rather than fail.

### Known limitations

- Rate limiting is per-instance, not global (see #4).
- `signal` relays opaque SDP/ICE JSON without validating its shape. The schema is
  the peer's responsibility; the 64KB cap and rate limit bound the damage, but
  full validation would mean parsing WebRTC payloads server-side.
- **No TURN.** This is now the single biggest functional gap. On any network that
  filters multicast DNS — which hides host candidates behind `.local` names — or
  that needs NAT hairpinning, connections never establish and the app just shows
  "Connecting…". Adding a relay would close it; it needs a provisioned server.
- A failed connection is indistinguishable from a slow one in the UI. Surfacing
  real ICE state is the obvious next fix.
- **The "Me" pin is drawn at your raw GPS position, not your offset position.**
  Peers see you 1–3km away, but you see yourself exactly where you are — so the
  map misrepresents where you actually appear, and centres on your true location.
  `/api/poll` deliberately returns only *other* peers, so the client has no way to
  know its own published position. Fix is to return the caller's own offset point
  and render from that. Not a privacy leak (the raw coords never leave the
  client), but it is wrong, and it is the thing I would fix first in Phase 2.
- **Deployment cost ceiling.** Vercel Hobby includes 1M function invocations per
  month. At `POLL_INTERVAL_MS = 1500` a single always-open tab burns ~2,400/hour,
  exhausting that in roughly 17 days (~9 days for two users). Irrelevant for a
  reviewer's demo; a real constraint if the app is left up. Adaptive polling —
  fast while a connection is pending, slow when idle — would cut idle usage by
  most of that.

## Phase 2 — Make it good

Three tiers. The tiers share files, so they are recorded together rather than as
separate commits — splitting them would have needed per-hunk surgery and produced
intermediate states that do not compile.

### Tier 1 — accessibility and correctness

- **The Geist font was never applied.** `globals.css` hardcoded
  `font-family: Arial`, silently overriding the font loaded in `layout.tsx` and
  leaving the `--font-sans` theme variable dead. Confirmed in-browser with
  `document.fonts.check('16px Geist')`.
- **The peer dot was a 14px target**, making the primary interaction of the app
  unusable with a thumb. Now a 44px button with the 14px dot drawn in `::after`,
  so the larger hit area does not look bloated. Measured with
  `getBoundingClientRect` at five real viewport sizes.
- **`prefers-reduced-motion` was ignored**, so the pulse animation ran forever on
  every dot. Now gated behind `no-preference` with a static fallback.
- **`ConnectionPrompt` was not a dialog**: no `role`, no Escape, no focus
  management, and keyboard users could Tab straight through to the map behind it.
- **Chat had no `aria-live` region**, and who-said-what was conveyed by alignment
  alone.
- **The "Me" pin was drawn at the raw GPS position** rather than the published
  offset position, so the map misrepresented where you actually appear. Fixed by
  returning the caller's own offset coordinates from `/api/poll` (`PollResponse.me`)
  and rendering from those.

### Tier 2 — mobile

- **`layout.tsx` exports a `viewport` with `viewportFit: "cover"`**, without which
  every `env(safe-area-inset-*)` resolves to 0 and the insets below do nothing.
- **`ChatPanel` is a bottom sheet on mobile** (`max-h-[75dvh]`, rounded top, map
  still visible above) and the full-height side panel from `md` up. `dvh` so it
  tracks the collapsing toolbar, and `min-h-0` on the scroll container — without
  it a flex child with `overflow-y-auto` refuses to shrink below content height
  and pushes the input off screen.
- **Safe-area insets** on the video PiP, end-call row, entry gate and map
  overlays. The online pill and "Fit to people" hide on mobile while the sheet is
  open, where they were previously hidden behind it.
- **The map reserves the panel's width on desktop** via a single `--panel-w` token
  shared by the panel, the reach card and the floating controls. Previously the
  reach card centred on the full viewport and slid underneath the panel on any
  window narrower than ~1030px.

### Tier 3 — states and meaning

- **Empty state**, distinguishing "still checking" from "confirmed nobody here".
  On a fresh deployment nobody is ever online, so without this the first thirty
  seconds were a blank map and a "0 online" pill, which reads as broken. Dismissable,
  and the card reserves the height of the taller state so the copy change does not
  resize it (measured: 169px → 214px before the fix).
- **Connection lifecycle feedback.** The chat header went from a bare
  "Connecting…" to a spinner then a status dot, with a one-shot ring when the
  channel opens. That moment previously had no feedback at all.
- **Dots coloured by distance band** (`lib/distance.ts`) rather than a hash of the
  session id, which looked meaningful and was not. Bands rather than exact
  distances, because both coordinates are already privacy-offset and a precise
  figure would be a lie.
- **Typing indicator** over the existing peer-to-peer channel, so it costs nothing
  server-side and never enters the transcript. Only transitions are sent, and it
  auto-expires because a peer closing the tab mid-sentence never sends "stopped".
- **Notices are queued.** Teardown emits several in quick succession and the old
  behaviour dropped all but the last.

## Phase 4 — Make it better

Four features, each built to be demonstrable in a two-minute review.

### Reach — a connection context card

Accepting a connection previously just produced a chat panel; you learned nothing
about who you were about to talk to. The card shows the distance band, an
estimated local time, and a random conversation starter.

- **Local time is estimated and labelled as such.** No timezone database and no
  geocoding call — the app deliberately talks to no third party and stores nothing.
  It is derived from longitude alone (`lng / 15` hours from UTC), so it ignores
  latitude, timezone shape and DST. The UI says "roughly 3pm where they are"
  rather than implying precision it does not have.
- **Bands rather than exact distances**, for the same reason: both coordinates are
  already privacy-offset, so a precise figure would be a lie *and* less private.
- **Conversation starters are served entirely client-side** — no server round trip,
  nothing stored, never repeated consecutively. A test asserts none of them asks
  for age, exact location, contact details or handles, since the list is shown to
  someone you just met.

### Block — session-scoped, memory-only

There was no way to avoid someone: only "End", and because you *can* reconnect you
might reconnect to the same person.

- **The scope is the interesting part.** Session ids are server-issued UUIDs
  minted per page load and there are no accounts, so blocking a session id blocks
  *that session*, not the person. On their next visit they get a new id and
  nothing held can match it. That is a direct consequence of "no accounts, nothing
  persists", not an oversight.
- **Memory-only because persistence would be pointless.** A session-scoped list
  stored in `localStorage` would hold identifiers that can never match again. It
  would buy nothing and cost the privacy guarantee. Nothing touches disk and
  nothing is sent to the server.
- **Enforcement is client-side**, which is the correct model: blocking exists for
  the blocker's benefit, not to constrain the blocked party. Refusing to dial and
  auto-declining their requests covers both directions.
- **Tapping a blocked dot unblocks it**, so it is never a one-way door. `end` is
  the only signal type that still gets through from a blocked session, otherwise
  blocking mid-call would strand the connection until the 20s deadline.
- **Report was deliberately not built.** A report needs somewhere to go — a
  moderation queue, an admin, a log. This app stores nothing and has no backend,
  so a report button would be theatre that tells a user their report landed when
  it did not.

### Wave — a low-commitment greeting

- **Architectural consequence:** there is no data channel before connecting, so a
  wave cannot ride WebRTC. It travels through the server as a new `wave` signal
  type in the same transient mailbox, discarded on read like every other signal.
- **Sent by long-press (touch) or right-click (pointer)**, deliberately *not* on
  tap — tap means connect, and that path is the core of the app and already
  verified. Both gestures fire before a synthesised click, so suppressing the
  default keeps tap intact.
- **The reply stays as low-commitment as the greeting**: a bar with "Wave back" /
  "Connect" / dismiss, no prompt and no busy lease.
- **Verified that a wave consumes no busy lease**, which was the property that
  would have made it harmful — waving at someone must not lock you both out of
  connecting.

### Live network status

A stalled connection and a slow one look identical from the outside; both sit on
"Connecting…" with no explanation, so the only available response is to guess or
retry and hope.

- **The mapping lives in `lib/netstatus.ts`** with 11 unit tests, deliberately
  away from the component. Coverage includes that no failing state ever reads as
  "ok", that all four progress states produce *distinct* copy, and that hints
  stay under one sentence.
- **On failure it distinguishes two causes that need opposite responses.** If
  candidate gathering never completed or any STUN request errored, it says the
  network may be blocking the route and suggests a VPN or different network. If
  gathering completed cleanly but ICE still failed, it falls back to a generic
  hint — blaming the network there would be a guess.
- **A mid-call dropout never blames the network**, since the route demonstrably
  worked once; that is what the sticky `everConnected` flag is for.

### Phase 4 known limitations

- **Block is session-scoped, not identity-scoped.** Durable blocking would
  require stable identity, which the brief explicitly rules out. Worth stating as
  an assumption rather than letting a reviewer infer durable blocking that is not
  there.
- **Unblocking is only reachable by finding the dot.** The count chip is a
  non-interactive hint with no list and no clear-all.
- **Live network status is only Medium demo-able** — it needs a bad network to
  demonstrate. Force it by blocking a STUN domain locally, or test from a
  restrictive network.
- **The wave gestures are unverified in a browser.** The signalling is tested
  (13 assertions); long-press timing and the contextmenu handler need a real
  pointer.

## Engineering practice

- `npm run lint` was **failing** on a clean checkout: ESLint was linting the
  vendored `.agents/` skill docs. Now ignored, with `typecheck`, `db:migrate`, and
  `db:deploy` scripts added.
- Added `STALE_MS`/`BUSY_TTL_MS` reasoning in comments, because both numbers are
  load-bearing against browser behaviour rather than arbitrary.
- Verified against a real Postgres rather than by inspection: 49 assertions
  covering auth, impersonation, the concurrency race, lease expiry, staleness
  reaping, mailbox ordering, and input validation — plus 22 assertions driving two
  real `PeerSession`s through a full handshake against a fake
  `RTCPeerConnection`. Both suites were checked against the pre-fix code to
  confirm they actually fail without the fixes.
- **Outstanding cleanup:** the `?debug=1` signaling tracer (`lib/debug.ts` plus
  ~27 `trace` call sites) is still in the tree. It is opt-in and prints nothing
  in normal use, but it does not belong in a reviewed repo and should be removed.
- The verification suites currently live outside the repo and are **not
  committed**, so a reviewer cannot run them. Moving them under `tests/` with a
  runner is the next thing I'd do.
