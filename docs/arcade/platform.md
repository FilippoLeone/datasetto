# Arcade: platform design

The **Arcade** replaces the old voice-channel minigames with four original games. They work offline against bots with no server, and online with people in your voice channel who choose to join:

| Game | Code id | What it is | Spec |
|---|---|---|---|
| **Lamplight Hold'em** | `lamplight` | No-limit Texas Hold'em: Open Tables (cash), Lamplight Cup (sit-and-go), Firefly Trio (3-player hyper-turbo with a random prize multiplier shown before the deal) | `docs/arcade/lamplight.md` |
| **Glimmerhall** | `glimmer` | Three slot machines (Pocket Orchard, Tidepool Treasures, Ember Vault), a shared hall per voice channel, the Glimmer Pot progressive jackpot and the **Glimmer Dash** timed tournament | `docs/arcade/glimmerhall.md` |
| **Fuseyard** | `fuseyard` | Grid arena for 2–4 Wicks: timed fuse bombs that burst in a cross, destructible blocks, items, last one standing | `docs/arcade/fuseyard.md` |
| **Bellwick: The Silent Bells** | `bellwick` | Top-down action-adventure: a screen-by-screen overworld, the Drowned Bellhouse dungeon with keys, items, enemies and the Old Clapper boss, sword combat. Solo Tale offline, Party Tale co-op online | `docs/arcade/bellwick.md` |

All chips and credits are virtual. Nothing can be bought, sold, transferred or cashed out.

**Base.** The base is the judges' winning proposal, *server-authoritative, budgeted binary*. The server decides every online outcome. A client predicts only its own avatar. Traffic is a few small, paced messages, sent only to people who opted in. One pure TypeScript core runs on the server online and on the device offline. On top of that base, this document grafts the judges' picks from the other two proposals, fixes every must-fix item, and fits the four game specs to one transport.

**What the measurements already settled** (the 600 kbit/s link stands for 3G with a call taking the rest of the downlink):

| Run | What was sent | Chat latency | Game updates |
|---|---|---|---|
| r1 | old full-state JSON, reliable | p50 12.9 s, socket dead at 45 s | 3/s |
| r2 | same, `volatile` | p50 10.7 s, still growing | 7.9/s |
| r3 | same JSON, paced to 1 frame in flight | p50 62 ms, max 629 ms | 5.3/s |
| r4 | 160 B binary snapshot at 15 Hz | p50 16 ms, max 33 ms | 13.8/s |
| r5 | old JSON at 2 Mbit/s | fine | 17.6/s |

Size and pacing are what matter. Encoding comes second, and `volatile` does not help.

---

## 1. Decisions

Each line resolves a disagreement between judges, between a judge and a game spec, or an open question in the base.

| Topic | Decision | Why (one line) |
|---|---|---|
| Base proposal | server-binary | Both judges ranked it first. |
| Action-lane transport | A raw `ws` WebSocket at `/arcade/ws`, upgraded on the existing HTTP server. No second Socket.IO server, no custom parser. | Each message is one binary frame natively, so no parser has to be kept working across Socket.IO upgrades. |
| Table lane | Plain `arcade:*`, `lamplight:*` and `glimmer:*` events on the main socket, not a `/arcade` namespace | On one Manager a namespace isolates nothing, and it would duplicate the auth and limiter wiring. |
| Snapshot deltas | None. Snapshots are absolute, events are reliable, and a keyframe is the base. | Bodies are 22–136 B against 76 B of per-message overhead, and dropping deltas removes the delta-base failure mode entirely (§6.5). |
| Lag compensation | Keep Bellwick's 16-tick hit-claim ring and Fuseyard's in-state dodge grace. Cut the server-side input-timestamp rewind (late-input flame sparing, 200 ms rewind of server-simulated hits). | The two kept are small, deterministic and required by the specs' authority models; the cut part is the edge-case-heavy machinery judge 2 objected to. |
| Fuseyard disconnect or stall | The fighter becomes a frozen, invulnerable **ghost**, not the spec's autopilot | An autopilot that dies for you is "lag killed me", which is the must-fix. |
| Game names | The game specs' names (Lamplight, Glimmerhall, Fuseyard, Bellwick). The base's working names are dropped. | The specs are written, and judge 2 flagged a base name as colliding with a commercial format name. |
| Slots tournament name | **Glimmer Dash**, replacing the slots spec's working title | The working title used a word that commercial jackpot formats use. |
| Poker fairness | Per-card commitments with a proof fetched on demand (§8.1) | It keeps the poker spec's "never expose mucked cards" and the judges' "verify the deck after the hand". |
| Trio economy | The poker spec's table (EV 2.9725 buy-ins, a 0.9 % sink). The admin validator rejects EV ≥ 3. | Slots RTP is the main chip sink, so the jackpot format only has to not print chips. |
| Stub for old shells | Kept for **3** releases | Desktop builds before the updater release do not auto-update. |
| Offline action sims | On the main thread, driven by the frame loop. Poker bot equity runs in a Worker, as the poker spec says. | A step is under 0.3 ms, and pausing along with the frame loop is exactly the wanted hidden behaviour. |
| Spectators | 4 per action match, 8 per poker table, none in Bellwick v1 | VPS egress (§7.4). Tables are tiny JSON. Bellwick per its spec. |
| Bellwick interest management | Per-room routing: heroes roam freely, each client gets only its own room, the server runs at most 4 rooms | It is the spec's design. Per-client cost is one room either way, and server cost is bounded. |
| Snapshot rate ladder | 15 → 10 → 7.5 → 5 Hz (send every 2/3/4/6 ticks of the 30 Hz sim) | Both action specs ask for 15 Hz by default and 10 under pressure, and integral divisors keep the tick maths exact. |
| Sim version skew | Online play needs only the same **codec** version. A different sim version only degrades prediction. | Android APKs and older desktop builds do not auto-update. |
| Determinism enforcement | A grep test over `core/` plus golden replay hashes | `server/` has no ESLint config, and a test needs none. |
| Migration 14 scope | One migration with every Arcade table | The tables are generic `arcade_*` tables and empty ones cost nothing. Later changes go to 15+. |
| Wallet | One chips wallet for poker and slots (as in the slots spec). New accounts get 20,000 and claim daily per the poker spec. | One economy, one ledger, one conservation test. |

---

## 2. Preconditions (phase 0, separate PRs, before the first game)

These are not Arcade code, but the Arcade cannot meet its requirements without them.

### 2.1 Cellular voice cap (must ship with or before the Arcade)

`OPUS_TARGET_BITRATE` defaults to 128,000 (`client/src/services/voice/VoiceService.ts:65`). In a 4-person mesh a phone sends three streams of 128 kbit/s plus about 25 kbit/s of packet overhead each, roughly 460 kbit/s, on a 250 kbit/s 3G uplink. The call alone overflows the link, so "games never delay voice" cannot pass a 3G test until this is fixed.

- **Detection.** The link counts as *constrained* when any of these holds:
  - `navigator.connection.type === 'cellular'` (Android Chrome and WebView);
  - `effectiveType` is `slow-2g`, `2g` or `3g`, or `saveData` is on;
  - `downlink < 2` Mbit/s;
  - `availableOutgoingBitrate` from `getStats()` stays under 400 kbit/s for 5 s.

  Audio settings gain a "Data-saver voice" choice of Auto, On or Off.
- **Own sender.** When constrained, `encoding.maxBitrate = 24000` on every audio sender, applied with `setParameters` (the code at `VoiceService.ts:1748` already does this per sender, so nothing is renegotiated). The next SDP also carries `maxaveragebitrate=24000` (`:1812`). DTX stays on.
- **Per-peer cap.** A constrained client sends `voice:link {constrained}`, relayed to the peers in the channel. Each peer caps only its sender toward that client, at 24 kbit/s. The mesh allows this because every peer has its own sender.
- **Resulting voice cost** for a 3G phone in a 4-person call, while talking:
  - Each stream is 24 kbit/s of Opus plus 50 packets/s × 62 B of IP, UDP, RTP, header extensions and the SRTP tag, about 49 kbit/s.
  - Three streams come to about **147 kbit/s** each way.

### 2.2 Electron window visibility

`backgroundThrottling: false` is set on the overlay window (`desktop/main.js:564`) and on the main window (`:939`). On the main window it keeps the Page Visibility API reporting "visible" while the window is minimized.

- **Main process.** On the main window's `minimize`, `restore`, `hide` and `show` events, and once at `did-finish-load`, `desktop/main.js` sends `window:visibility {visible: mainWindow.isVisible() && !mainWindow.isMinimized()}`.
- **Preload.** `desktop/preload.js` exposes `desktopAPI.onWindowVisibility(cb) → unsubscribe`.
- **Client.** `client/src/services/native/appVisibility.ts` merges four sources into one boolean with listeners:
  - `document.visibilityState`;
  - `pagehide` and `pageshow`;
  - Capacitor `appStateChange`, through one shared listener in the new `services/native/appState.ts`, which `voiceManager.ts:709` also switches to;
  - the Electron IPC.

  The visibility heartbeat (`services/visibilityHeartbeat.ts`) uses it as well, so push notifications also start working for a minimized desktop window.
- **Old shells** lack the IPC and fall back to `document.visibilityState`. A minimized old desktop build therefore keeps drawing. That is accepted, because the new desktop build ships the IPC.
- **Unchanged.** `backgroundThrottling` stays false, because push-to-talk and mic levels need it.

### 2.3 One frame scheduler

`client/src/lib/frames.ts` is the only `requestAnimationFrame` user, about 0.4 KB:

```ts
export interface FrameOpts { maxFps?: number }              // 60 for games; display rate when omitted
export const frames: {
  add(cb: (now: number, dt: number) => void, opts?: FrameOpts): () => void;  // returns unsubscribe
  once(cb: (now: number) => void): void;
  readonly active: number;                                   // subscribers; exported for tests and the dev overlay
};
```

- **Loop.** One rAF loop runs while `active > 0`. With no subscribers, no rAF is requested at all.
- **Frame cap.** `maxFps` skips callbacks less than `1000/maxFps − 1` ms apart. On a 240 Hz desktop the games draw 60 frames per second.
- **Existing users.** `Composer.tsx` moves its one-shot rAF calls to `frames.once`.
- **Dev counter.** In dev builds, `window.__frames` shows the current subscribers by label.

### 2.4 Idle main-thread cost

This is tracked separately; the plan is in §15. It is listed here because the Arcade's "costs nothing when closed" claim is measured against that baseline.

---

## 3. Module layout and build

### 3.1 Shared core: `server/src/arcade/core/`

The shared core is pure TypeScript that the server imports directly and the client imports through an alias.

**Why there.** Keeping it inside `server/src` leaves the server Docker image, its context, `rootDir` (`src`) and `CMD` unchanged. A top-level package would change the server image context and the CI image workflow, so it was rejected.

```
server/src/arcade/core/
  tsconfig.json          # purity check: lib ES2022, types: [], erasableSyntaxOnly, noUnusedLocals/Parameters
  version.ts             # PROTO = 1; CODEC = {fuseyard: 1, bellwick: 1}; SIM = {fuseyard: 1, bellwick: 1}
  bytes.ts               # ByteWriter / ByteReader over DataView, little-endian, varint, wrap-aware u16 compare
  rng.ts                 # mulberry32, xorshift32, xoshiro128** (seeded); no Math.random anywhere in core
  hash.ts                # FNV-1a 32 for replay hashes
  net/
    lane.ts              # action-lane message types, encode/decode of the envelope (§5)
    pacer.ts             # pure pacing logic: token bucket, in-flight cap, ladder, park state machine (§6)
    clock.ts             # tick/clock estimation from PING/PONG (min-RTT filter)
    interp.ts            # tick-based interpolation buffer (render tick, extrapolate ≤ 100 ms, hold)
    budget.ts            # per-game byte budgets as constants used by tests and the sender (§7)
  fuseyard/  rules.ts sim.ts codec.ts bots.ts arenas.ts replay.ts
  bellwick/  content/*.txt.ts sim/{hero,room,party,ai}.ts codec.ts replay.ts
  lamplight/ cards.ts evaluate.ts engine.ts views.ts schedule.ts trio.ts proof.ts bots.ts
  glimmer/   machines.ts evaluate.ts spin.ts feature.ts rtp.ts
```

**Rules for `core/`.** A server test enforces them (§14.1).
- **Imports.** Use `.js` suffixes. NodeNext needs them on the server, and bundler resolution maps them to `.ts` in the client.
- **No enums.** `enum` and `const enum` are banned, through `erasableSyntaxOnly` and the grep test. The specs' `const enum`s become `as const` objects plus union types, because the client builds with `isolatedModules` and dev runs through tsx.
- **No platform APIs.** No DOM or Node types (`types: []`). No `Math.random`, `Date`, `performance`, `setTimeout`, `setInterval`, `crypto` or `for…in`. In `sim/` and `bots/`, no `while` or `do`: every loop is a `for` over a fixed capacity or a pool length (§13.4). The RNG for online poker and slots is *injected* by the server (`crypto.randomInt`), never imported in core.
- **Integer state only** in sims. Float maths is allowed only in client rendering code, which lives outside core.

**Build wiring**

| Where | Change |
|---|---|
| `server/package.json` | `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p src/arcade/core/tsconfig.json --noEmit"`; add `"ws": "~8.21.3"` as a direct dependency (it is already in the tree via engine.io, same version); add `@types/ws` to devDependencies |
| `server/tsconfig.json` | remove `allowJs`, `checkJs` and the `src/**/*.js` include once the old JS engine is gone |
| `client/tsconfig.json` | `"paths": {"@/*": ["./src/*"], "@arcade/core/*": ["../server/src/arcade/core/*"]}` |
| `client/vite.config.js` | `resolve.alias['@arcade/core'] = resolve(dirname, '../server/src/arcade/core')`; `server.fs.allow = [dirname, resolve(dirname, '../server/src/arcade/core')]`; dev proxy `'/arcade/ws': {target: devProxyTarget, ws: true}`; codeSplitting group `{name: 'arcade-runtime', test: /[\/](src[\/]arcade[\/]runtime\|arcade[\/]core[\/](net\|bytes\|rng\|hash))[\/]/}` |
| `client/vitest.config.ts` | the same alias |
| `ops/caddy/Dockerfile` | `COPY server/src/arcade/core /server/src/arcade/core` next to the existing `COPY desktop/games /desktop/games` (line 16), so the client build's `../server/...` resolves at `/server` |
| `ops/caddy/Caddyfile:29` | `@backend path /api/* /socket.io/* /health /arcade/ws` |
| `ops/docker-compose.local.yml` and the Vite dev proxy | nothing else; local dev reaches the same path |
| Desktop and Android builds | nothing: they build the client from the repo checkout, and the game chunks land in `dist` |

Each game is its own lazy chunk (`import('./fuseyard/index.ts')`), and all of them share the `arcade-runtime` group.

**Bundle budgets** (gzip), checked by a small `client/scripts/check-bundle.mjs` after `npm run build`:

| Chunk | Budget |
|---|---|
| Main bundle growth | ≤ 4 KB |
| `arcade-runtime` | ≤ 25 KB |
| Fuseyard | ≤ 45 KB |
| Bellwick | ≤ 60 KB |
| Lamplight | ≤ 50 KB |
| Glimmerhall | ≤ 40 KB |

### 3.2 Server modules: `server/src/arcade/`

```
arcade/
  index.ts         # createArcade(ctx, httpServer, io) → { stop(), onRestarting() }; wired in src/index.ts stoppables
  lane.ts          # ws server: upgrade routing, origin check, HELLO/ticket, heartbeat, per-IP cap, rate limit
  tickets.ts       # HMAC lane tickets (single use) and per-seat resume tokens
  hub.ts           # lobbies, matches, tables, halls; per-channel and server-wide limits; activity summaries
  sender.ts        # per-recipient stream: pacing, parking, keyframes, egress accounting (uses core/net/pacer)
  scheduler.ts     # one drift-corrected 30 Hz loop; runs only while ≥ 1 live action match exists
  watchdog.ts      # per-match step timing, event-loop delay monitor, replay dumps
  rooms/fuseyard.ts rooms/bellwick.ts          # MatchRuntime implementations around core sims
  tables/lamplight.ts tables/cup.ts tables/trio.ts   # event-driven poker tables (no tick)
  halls/glimmer.ts halls/dash.ts               # slots hall and Glimmer Dash
  wallet.ts        # double-entry chip ledger, escrow, claims, jackpots (§11)
  stats.ts         # results, stats, leaderboards (60 s cache)
  saves.ts         # Bellwick save slots
  handlers.ts      # main-socket events through handle() (§5.3)
  settings.ts      # arcade admin settings parser (SettingsService key 'arcade')
  legacy.ts        # stub for old shells' voice:game:* (§12)
```

### 3.3 Client modules

```
client/src/features/arcade/        # Preact shell, in the main bundle (≤ 4 KB gzip)
  ArcadeButton.tsx  ArcadeSheet.tsx  LobbyChip.tsx  InviteChip.tsx  GameStage.tsx  WalletPill.tsx
  state.ts          # coarse signals only (§10.1)
  api.ts bindings.ts
client/src/arcade/                 # lazy, framework-free
  runtime/
    loop.ts         # fixed-step accumulator on lib/frames; dirty-flag drawing
    canvas.ts       # ResizeObserver (lib/useElementSize logic) × DPR, integer scaling, smoothing off
    input/{keyboard,touch,gamepad,map}.ts
    audio.ts        # Web Audio synth voices, one context per open game, suspended when hidden
    sprites.ts font.ts
    net/{laneClient,remoteHost,localHost}.ts
    practiceWallet.ts
    visibility.ts   # subscribes to services/native/appVisibility + IntersectionObserver + stage minimized
  fuseyard/ bellwick/ lamplight/ glimmer/      # one lazy chunk each
```

**Contracts.** The Bellwick spec's `mount`, `pause`, `resume` and `unmount` map onto `GameHandle`. Its `onMessage` is the `onFrame`, `onKeyframe` and `onPhase` callbacks on `MatchHost`.

```ts
// client/src/arcade/runtime/types.ts
export interface GameModule { mount(el: HTMLElement, host: MatchHost, opts: MountOpts): GameHandle }
export interface GameHandle { pause(): void; resume(): void; unmount(): void }   // unmount frees everything
export interface MatchHost {
  readonly mode: 'local' | 'remote';
  sendUp(payload: Uint8Array): void;          // newest-wins input/state
  sendEvent(payload: Uint8Array): void;       // reliable game event
  onWelcome(cb: (w: Welcome) => void): void;
  onFrame(cb: (f: FrameView) => void): void;  // snapshot + events, by server tick
  onKeyframe(cb: (k: KeyframeView) => void): void;
  onPhase(cb: (p: PhaseView) => void): void;
  setVisible(visible: boolean): void;         // drives VIS (§5.2)
  close(): void;                              // closes the lane
}
```

```ts
// server/src/arcade/rooms/types.ts
export interface MatchRuntime {
  readonly game: 'fuseyard' | 'bellwick'; readonly id: string;
  step(): void;                                          // one 30 Hz tick; bounded work
  onUp(slot: number, payload: Uint8Array): void;         // decode errors are dropped silently
  onEvent(slot: number, evSeq: number, payload: Uint8Array): void;
  snapshotFor(r: Recipient): Uint8Array;                 // absolute snapshot body for this recipient's view
  keyframeFor(r: Recipient): Uint8Array;                 // full public view (never hidden state)
  takeEvents(r: Recipient): Uint8Array | null;           // events of this tick visible to r
  setSeat(slot: number, state: 'live' | 'ghost' | 'bot' | 'left'): void;
  handover(): Uint8Array;                                // full state incl. hidden, only for "continue offline" at shutdown
  replay(): Uint8Array;                                  // seed + config + input ring, for dumps
  dispose(): void;
}
```

---

## 4. Transport

| Lane | Carries | Connection | Encoding | Open when |
|---|---|---|---|---|
| **Table lane** | lobbies, invites, activity, wallet, Lamplight, Glimmerhall, leaderboards, saves list | the existing Socket.IO connection, default namespace | JSON, acked, idempotency ids | always (it is the app socket) |
| **Action lane** | Fuseyard and Bellwick matches (players and spectators) | its own WebSocket at `/arcade/ws` | binary, one message per frame | only while that client is in a match, as player or watcher |

**Why the split.** A namespace on the app's Manager shares the engine.io write buffer and the TCP stream with chat, presence and `voice:signal`. At 1 % loss and about 15 segments per second, a lost game segment would stall chat for one RTO (≥ 300 ms) every few seconds. The table lane is fine on the shared stream: it averages 1–3 kbit/s, and its largest burst, about 1.5 KB, adds about 16 ms of queueing at 750 kbit/s.

### 4.1 Action lane endpoint

- **Server.** `new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false, clientTracking: false })`. permessage-deflate stays off: 10–150 B frames do not shrink, and it costs memory on every socket.
- **Upgrade routing.** One `httpServer.on('upgrade')` listener in `lane.ts`:
  - `/arcade/ws` goes to `wss.handleUpgrade`;
  - `/socket.io/…` is left to engine.io;
  - any other path is destroyed at once.

  The Socket.IO `Server` gets `destroyUpgrade: false`. Engine.io's default listener otherwise arms a 1 s timer on every non-matching upgrade and ends the socket if nothing has been written. `ws` writes the 101 synchronously, so the default would survive, but only by accident. With the flag set, the one router owns the decision, and a test covers both upgrades on one server (§14.3).
- **Origin.** The upgrade handler runs the same `createOriginChecker(ctx.config.cors)` as Socket.IO and rejects with 403.
- **Per-IP cap.** At most 12 lane sockets per IP (`arcade.limits.lanePerIp`). A household on one NAT at a LAN evening still fits.
- **Shutdown.** While `ctx.runtime.shuttingDown`, new upgrades get 503.
- **HELLO.** The first frame must be a text frame of at most 512 B, within 5 s, or the server closes with 4408:

  ```json
  {"t":"hello","proto":1,"codec":{"fuseyard":1},"ticket":"<b64url>.<b64url>"}
  {"t":"hello","proto":1,"codec":{"fuseyard":1},"resume":"<b64url 32 B>"}
  ```

  After HELLO, every frame is binary. A text frame then closes the socket with 4400.
- **Tickets.** `arcade:ticket` on the main socket, or the `ticket` field in the `arcade:lobby:join` ack:
  - The body is `{a: accountId, m: matchId, r: 'p'|'s', e: expiresAt, n: nonce}`, signed with HMAC-SHA-256 under a per-process random secret. Matches do not survive restarts, so tickets need not either.
  - TTL is 30 s, and a ticket is single-use: the nonce is kept in a Map until it expires.
  - It is issued only if the account is seated in that match (player), or may watch it (spectator, §9.2).
- **Resume token.** Each WELCOME carries a fresh 32-byte random token bound to that seat. It stays valid while the seat is in its grace period, and each use rotates it. A reconnect therefore does not need the main socket, which may be down at the same moment.
- **Heartbeat.**
  - The server sends a WebSocket ping every 10 s and terminates the socket if the pong has not come back 10 s later. Browsers answer pings themselves.
  - Whenever nothing else went out for 1 s, the server also sends a 3-byte BEAT. A client that sees nothing for 5 s treats the lane as dead.
  - The lane's heartbeat is independent of the app socket's 25 s / 20 s.
- **Reconnect.**
  - `laneClient.ts` reuses `createReconnectScheduler` from `services/socket/backoff.ts` with `{baseMs: 500, maxMs: 4000}`. It resumes with the resume token while the grace lasts, then falls back to a fresh ticket.
  - Close codes 4401 (bad ticket), 4403, 4404 (match gone), 4409 (another tab took the seat) and 4426 (update required) stop retrying.
- **Rate limit.** At most 40 binary messages per second per socket. The normal maximum is 15 UP + 4 ACK + 2 EVT + 0.5 PING. Excess is dropped silently. More than 200 per second for 2 s closes the socket with 4429. Malformed frames are dropped, and the 10th closes the socket with 4400.

**Close codes**

| Code | Meaning |
|---|---|
| 1000 | closed by the client (left the game) |
| 1012 | server restarting |
| 4000 | away or idle too long; grace over |
| 4400 | malformed |
| 4401 | ticket or resume token invalid |
| 4403 | not allowed |
| 4404 | match gone |
| 4408 | HELLO timeout |
| 4409 | seat taken by another tab |
| 4426 | update required (codec mismatch) |
| 4429 | rate |

### 4.2 Table lane rules

- **Handlers.** Every event goes through `handle()` in `socket/context.ts`, with zod schemas, auth, the password-change gate and per-kind limiters. Refusals are acks with `{ok: false, code}`, logged at debug level, with no toast unless it is the sender's own action.
- **Rooms.** Recipients are explicit:
  - `lobby:<id>`: lobby members;
  - `table:<id>`: seated players and watchers;
  - `glimmer:<channelId>`: people who opened that hall;
  - `acct:<accountId>`: hole cards and wallet, through `Broadcaster.toAccount`.

  `io.to(channelId)`, the old broadcast to everyone viewing the channel, is never used for Arcade traffic.
- **Pacing.** Each socket gets a 3 KB/s token bucket with a 6 KB depth for non-ack Arcade emits (`server/src/arcade/handlers.ts`).
  - **Poker.** When the bucket is empty, events wait in an app-side queue (never in engine.io). After 32 queued events or 2 s, the queue is dropped and replaced by one `lamplight:snap`.
  - **Glimmerhall.** Feed and brag events are newest-wins.
  - **Acks** (spin results, action results) are always sent, but they count against the bucket.
- **Chat first, server side.** If the account's main socket has a non-empty `socket.conn.writeBuffer` (chat or signalling waiting in engine.io), non-ack Arcade emits on that socket are deferred by 50 ms. If the condition lasts more than 1 s, that account's action lane is parked with reason `yield` (§6.4).

---

## 5. Wire formats

### 5.1 Conventions

- Little-endian throughout. `T` is a u8 type.
- `seq` and `tick` are u16 on the wire with wrap-aware comparison (serial-number arithmetic). WELCOME and PONG carry a u32 tick as the anchor.
- The sim runs at 30 ticks/s, so one tick is 33.33 ms. `frameSeq` counts frames *sent to one recipient* and is consecutive for that recipient.
- Platform event kinds `0xF0`–`0xFF` are reserved inside every game's event block.
- **Overhead used in every budget.**
  - **Downlink message:** 76 B (WebSocket 2 + TLS 1.3 record 22 + IPv4/TCP with timestamps 52).
  - **Uplink message:** 80 B (the client adds a 4 B mask).
  - **TCP ACKs:** 26 B per message received (one 52 B ACK per 2 segments, worst case).
  - At these payload sizes overhead dominates, so message *count* matters more than payload bytes.

### 5.2 Action lane messages

**Client → server**

| T | Name | Layout | Bytes |
|---|---|---|---|
| `0x01` | UP | `T, u16 upSeq, u16 ackFrame, u8 ackDelay (4 ms units, ≤ 255), payload` | 6 + p |
| `0x02` | ACK | `T, u16 ackFrame, u8 ackDelay` | 4 |
| `0x03` | EVT | `T, u16 evSeq, payload (game event kind + args)` | 3 + p |
| `0x04` | PING | `T, u32 clientMs` | 5 |
| `0x05` | VIS | `T, u8 state` (0 live, 1 away, 2 yield, 3 leaving) | 2 |
| `0x06` | RESYNC | `T, u8 reason` (0 gap, 1 decode error, 2 world mismatch) | 2 |

**Server → client**

| T | Name | Layout | Bytes |
|---|---|---|---|
| `0x80` | WELCOME | `T, u8 proto, u8 game, u8 codec, u8 slot (0xFF = spectator), u8 flags, u32 tick, u8 tickHz (30), u8 divisor, u16 lastEvSeq, 32 B resumeToken, u16 cfgLen, cfg` | 47 + cfg |
| `0x81` | FRAME | `T, u16 frameSeq, u16 tick, u16 ackUp, u8 flags, [snapshot body], [u8 nEv, events]`. flags: b0 snapshot present, b1 events present, b2–3 divisor index (0..3 for 2/3/4/6), b4 `you are lagging` hint | 8 + … |
| `0x82` | KEYFRAME | `T, u16 frameSeq, u16 tick, u16 ackUp, u8 reason (0 join, 1 resume, 2 unpark, 3 round, 4 room, 5 resync), u16 len, body` | 10 + body |
| `0x83` | BEAT | `T, u16 tick` | 3 |
| `0x84` | PONG | `T, u32 clientMs, u32 serverTick, u16 tickPhaseUs` | 11 |
| `0x85` | PHASE | `T, u8 phase (0 lobby, 1 countdown, 2 running, 3 paused, 4 ending, 5 ended), u8 reason, u16 len, body` | 5 + body |
| `0x86` | HANDOVER | `T, u16 simVersion, u32 tick, u16 len, deflate-raw(full state)` | ≤ 8 KB, only at shutdown or overload |
| `0x8F` | BYE | `T, u16 code, u8 len, utf8 reason (≤ 64)`, followed by a close with the same code | ≤ 68 |

**Platform event kinds** (inside a FRAME's event block)

| Kind | Payload | Meaning |
|---|---|---|
| `0xF0` SeatState | `u8 slot, u8 state` (0 live, 1 ghost, 2 bot, 3 left) | ghost and bot transitions (§9.4) |
| `0xF1` Notice | `u8 code` | "server busy, rate lowered", "you are paused so chat can catch up", … |

**Cadence rules**

- **UP:**
  - **Fuseyard:** sent every 2 ticks while any input bit is set, and once more after release.
  - **Bellwick:** sent every 2 ticks while the hero state changed.
  - Nothing is sent while idle. TCP cannot lose UPs, so they are not repeated.
- **ACK.** Sent when at least one frame arrived since the last ack and no UP went out in the last 250 ms. That is about 4 Hz while frames flow and zero when none do. `ackDelay` is the time from receiving `ackFrame` to sending the ACK, so the server can subtract it from its RTT sample.
- **PING.** Five pings at start, then one every 2 s.
- **VIS.** Sent on every change of the merged visibility (§10.3), and on "chat first" yield or resume.
- **EVT.** Sent immediately (game events: Bellwick hit claims, interactions). After a resume, the client resends events above WELCOME's `lastEvSeq`, and the server dedups by `(accountId, matchId, evSeq)`.

### 5.3 Game payloads on the action lane

**Fuseyard** (spec §3, adapted to the envelope)

| Message | Layout | Bytes |
|---|---|---|
| UP payload | `u8 n (1–6), n × u8 input` (bits 0–2 primary dir, 3–5 secondary dir, 6 bomb, 7 detonate). `upSeq` is the seq of the newest input; the older ones are `upSeq − n + 1 …`. n = ticks since the last UP: normally 2, up to 6 after a stall. | 1 + n (UP = 9 B normally) |
| Snapshot body | `u8 n, n × {u8 slot:2\|facing:3\|moving:1\|alive:1\|ice:1, u16 x, u16 y}, u8 m, m × {u16 id, u16 x, u16 y}` (sliding bombs) | 22 with 4 fighters and no slides |
| Events | spec §3.3 table (BombPlaced 7, Explode 8, BlockBroken 3, ItemTaken 4, Died 4, …), plus SeatState | about 100 B/s average |
| Keyframe body | spec §3.3: cells at 4 bits each (no block contents), items, bombs, flames, warns, fighters | typically 340 B, hard cap 512 B |

`ackUp` in FRAME is the spec's `ackSeq`. The server's per-player input FIFO rules (pop one per tick, repeat the direction without press bits for up to 6 ticks, trim a backlog above 4 inputs to 2 while OR-ing press bits) stay as in the spec.

**Bellwick** (spec §4.6, adapted)

| Message | Layout | Bytes |
|---|---|---|
| UP payload (HeroState) | `u8 room, u16 x, u16 y, u8 facing:2\|act:4\|flags:2, u8 actT, u8 hp, u16 seenTick` | 11 (UP = 17 B) |
| EVT payloads | HitClaim `u8 kind, u8 enemyId, u16 seenTick, u8 attack, u8 dir`; DamageTaken; Interact, Push, EnterRoom, Buy, UseBrew, Rest, Emote | 3–7 + 3 |
| Snapshot body | `u8 room, u8 nh, nh × 8 B (other heroes), u8 ne, ne × 7 B (enemies, projectiles, pickups)` | 60–90 typical, ≤ 136 |
| Events | WorldDelta, Damage, Pickup, Spawn, Despawn, Correct, Downed, Revived, BossPhase, Victory (3–10 B); Roster (6 B per hero) once per second | about 6 B/frame |
| Keyframe body | RoomInit (room, tick, seed u32, entities at 6 B each, blocks, room flags) + party flags (32 B) + counters (8 B) | ≤ 300 B |

Snapshots, events and keyframes go only to heroes in that room (§8.3).

### 5.4 Table-lane events (main socket, JSON)

**Platform events.** All acked unless marked S→C. Sizes exclude about 92 B of framing.

| Event | Direction | Shape | Size |
|---|---|---|---|
| `arcade:lobby:create` | C→S | `{ch, game, mode, cfg}` → `{ok, lobby, ticket?}` | 80 / 300 |
| `arcade:lobby:join` | C→S | `{id, as: 'player'\|'spectator', seat?}` → `{ok, lobby, ticket?}` | 50 / 300 |
| `arcade:lobby:leave` / `:start` / `:bots` / `:config` | C→S | `{id, …}` → `{ok}` | 30–80 |
| `arcade:lobby` | S→C, lobby room, ≤ 2 Hz coalesced | `{id, game, ch, st, host, seats:[{a, bot, st}], spec, cfg, v}` | 150–350 |
| `arcade:activity` | S→C, channel viewers, on change, ≤ 1 per 2 s per channel | `{ch, a:[{g, id, st, n, max, w}]}` | 60–150 |
| `arcade:activity:all` | S→C, once after `auth:success` | `{chs:[…]}` | ≤ 1 KB |
| `arcade:ticket` | C→S | `{id}` → `{ok, ticket, exp}` | 30 / 120 |
| `arcade:invite` | C→S | `{id, to}` → `{ok}`; the recipient gets `arcade:invited {id, from, game}` | 50 |
| `arcade:wallet` | S→C, `acct:` room, on change | `{bal, esc, claim}` | 40 |
| `arcade:wallet:claim` | C→S | `{}` → `{ok, bal, got}` | 40 |
| `arcade:board` | C→S | `{game, board}` → `{rows:[…]}` (60 s cache) | ≤ 1.5 KB |
| `arcade:saves` / `:saves:delete` | C→S | `{game}` → `{slots:[…]}` | ≤ 400 |
| `arcade:probe` | C→S | `{}` → `{t}` (the "chat first" probe, §6.4) | 20 |

**Game events.**
- **Lamplight** events (`lamplight:snap`, `hand`, `hole`, `act`, `street`, `bank`, `show`, `end`, `seat`, `level`, `trio`, `cupEnd`, `proof`, plus the C→S `act`, `sit`, `leave`, `sitOut`, `topUp`, `show`, `register`, `emote`) are exactly as in the poker spec §7. Two additions:
  - `hand` gains `cr` (the commitment root, §8.1, 43 chars);
  - `hole` gains `s` (the owner's two card salts).
- **Glimmerhall** events (`glimmer:enter`, `leave`, `spin`, `pick`, `resume`, `feed`, `brag`, `pot`, `react`, `dash:*`) are as in the slots spec §6. The spec's tournament events `sprint:*` become `dash:*`. One addition: `glimmer:away {}` while the hall is hidden (§10.3).

---

## 6. Pacing and flow control

All the logic lives in `core/net/pacer.ts`: pure, clock-injected, and unit-tested in virtual time. `server/src/arcade/sender.ts` applies it to sockets.

### 6.1 Send slots and the ladder

Each recipient has a **divisor** d ∈ {2, 3, 4, 6}, so it gets a send slot every d ticks (15, 10, 7.5 or 5 Hz). The default is 2 for players and 3 for spectators.

At each send slot the sender builds `FRAME = header + absolute snapshot + all events pending for this recipient` and sends it only if all of these hold:

```
tokens      >= wireBytes                                   // bucket: rate = 1.25 × budget.downAvg, depth = keyframeMax + 4 × frameMax
inflight + wireBytes <= inflightCap                        // inflight = wire bytes sent after the frame acked last
ws.bufferedAmount < 2048                                   // Node-side backlog
inflightCap = clamp(deliveryRate × (minRtt + 80 ms) + 600, 800, 6144)   // bytes
```

- `deliveryRate` is the EWMA of acked wire bytes per second over 1 s.
- `minRtt` is the minimum ack RTT over 10 s, where RTT = `now − sentAt(ackFrame) − ackDelay`.
- The in-flight cap allows the bandwidth-delay product plus about 80 ms of queue plus room for one keyframe. That bounds how much the game adds to the shared radio queue, which voice also uses.
- `bufferedAmount` alone reacts too late behind Caddy and the radio queue; that is why `volatile` failed in r2.

If any condition fails, the slot is skipped. The snapshot is dropped (the next one is absolute), and pending events wait for the next slot.

**Ladder**
- **Down one level** (d 2→3→4→6): when `rtt − minRtt > 150 ms` for 1 s, or 3 consecutive slots are skipped by the in-flight cap.
- **Up one level:** after 3 s with `rtt − minRtt < 60 ms` and no skips.
- The divisor index rides in FRAME flags. The client's interpolation delay follows the observed interval (§8).

### 6.2 Recipient state machine (the delta-base rule)

```
CONNECTING ──WELCOME+KEYFRAME──▶ LIVE ◀──KEYFRAME (when inflight < cap/2)── PARKED(reason)
                                  │                                          ▲
                                  └── away | yield | stalled | overflow ─────┘
                                  any state ── socket closed ──▶ GONE (seat grace runs, §9.4)
```

- **Base.** The client's world is the last KEYFRAME plus every event block after it, in order. Snapshots are absolute and only refresh dynamic positions. Nothing ever needs a delta base.
- **Guarantee while LIVE.** `frameSeq` is consecutive per recipient, and every event produced after the keyframe's tick and visible to this recipient is in exactly one FRAME. A gap at the client is a bug, so the client sends RESYNC, which brings a keyframe.
- **Parking.** On entering PARKED, pending events are discarded for that recipient, and new ones are not queued. The next thing it receives is a KEYFRAME. Skipped and stalled paths therefore always reset to a keyframe, and a lagging client never gets a backlog.

| Park reason | Trigger | Leaves PARKED when | Effect on the seat |
|---|---|---|---|
| `away` | client VIS 1 (hidden, minimized, stage collapsed) | VIS 0 | Fuseyard ghost, Bellwick Resting |
| `yield` | client VIS 2 ("chat first", §6.4), or the main-socket writeBuffer non-empty for over 1 s | VIS 0, or the writeBuffer is empty for 2 s | as `away` |
| `stalled` | no ACK or UP progress for 2.5 s while frames are outstanding | an ACK arrives | as `away` |
| `overflow` | pending events over 1 KB, or the oldest pending event over 1.5 s old | automatically, at the next slot with `inflight < cap/2` | none |

- **While PARKED:** `away` gets no application frames at all; the WebSocket ping every 10 s is the only traffic. `yield` and `stalled` get a BEAT at 1 Hz, so the client can tell "slow" from "dead".
- **Away limit.** More than 60 s away (cumulative 90 s per match for Fuseyard) closes the lane with 4000, and the seat follows the grace rules (§9.4).
- **Recovery.** The keyframe goes out as soon as `inflight + size ≤ cap`. A 10 s outage costs one keyframe of at most 512 B, not 10 s of frames.

### 6.3 Idle players stay healthy

A player who stands still sends no UP, but ACKs keep flowing at about 4 Hz while frames arrive (§5.2). The stall rule counts ACK *or* UP progress, so an idle player is never marked as lagging.

### 6.4 "Chat first" guard (client side)

- **Timing.** `socketClient.request()` (`services/socket/client.ts:100`) records each ack's round trip in a small ring that `ackRtt()` exposes. It costs one `performance.now()` per request.
- **Probe.** While an action lane is open and no request went out for 5 s, the client sends `arcade:probe` (acked, about 112 B on the wire, ≤ 0.2/s).
- **Trigger.** If any main-socket ack takes over 2,000 ms, or a probe times out after 3 s, the client:
  1. sends VIS 2 (`yield`);
  2. stops UP (ACKs drop to 1 Hz);
  3. shows "Paused so chat and voice can catch up".
- **Resume.** After two consecutive probes under 600 ms, the client sends VIS 0 and gets a keyframe.

The server-side half is the writeBuffer rule in §4.2.

### 6.5 Server-wide limits

- **Egress.** All lane egress is summed each second. Above `arcade.limits.egressKbps` (default 1,500), the server degrades in this order:
  1. spectators to d = 6;
  2. players' default d to 3;
  3. new spectators refused;
  4. new matches refused.
- **CPU.** `perf_hooks.monitorEventLoopDelay({resolution: 20})` is sampled every 10 s. A p99 above 30 ms triggers the same ladder, and new matches are refused until p99 stays under 20 ms for 30 s.
- **Usage.** Arcade lane bytes are added to the admin Usage section as "Arcade egress" (one counter, persisted with the existing usage months).

---

## 7. Byte budget per client

These numbers are for 3G: 750 kbit/s down, 250 kbit/s up, 300 ms RTT, occasional loss, in a 4-person voice call with the cellular voice cap from §2.1. All figures are wire kbit/s, including the §5.1 overhead.

### 7.1 Per game

| Game | Down: messages | Down kbit/s (typ / peak 1 s) | Up: messages | Up kbit/s (moving / idle) |
|---|---|---|---|---|
| Fuseyard, player | FRAME 15/s × (8 + 22 + ~7 events) = 37 B; PONG 0.5/s | 13.6 frames + 3.1 TCP ACKs + 0.4 = **17 / 24** (round-start keyframe plus a chain) | UP 15/s × 9 B; PING 0.5/s; ACK 4/s when idle | 10.7 + 3.1 + 0.3 = **14 / 6** |
| Fuseyard, spectator (d = 3) | FRAME 10/s | **9.4 / 14** | ACK 2/s | **3.4** |
| Bellwick, player | FRAME 15/s × (8 + 75 + 6) = 89 B typ, 154 B max | 19.8 + 3.1 + 0.4 = **23 / 31** (boss, 12 entities); 16.6 at d = 3 | UP 15/s × 17 B; EVT ≤ 2/s in fights | 11.6 + 3.1 + 1.4 = **16.5 / 6** |
| Lamplight (table lane) | ~0.5 events/s × (100 + 92) | **0.8 / 24** (showdown burst, ≤ 3 KB in any second, ≤ 4 KB per hand) | act 0.1/s | **0.2** |
| Glimmerhall (table lane) | own results 0.5/s, feed ≤ 2/s, pot ≤ 0.5/s | **2.4 / 16** (rare long free-spin result ≤ 5 KB) | spin 0.5/s (≤ 2/s) | **0.6 / 2.4** |
| Lobby and activity | on change only | **≤ 1 / 2** | — | — |
| Arcade closed | 0 | **0** | 0 | **0** |
| Away or hidden | WebSocket ping only | **< 0.1** | pong | **< 0.1** |

**Ceilings** (`core/net/budget.ts`, enforced by tests and logged by the sender when exceeded over 10 s)

| Lane | Down | Up |
|---|---|---|
| Action lane | ≤ 32 kbit/s average, ≤ 40 in any 1 s window | ≤ 20 kbit/s |
| Table lane | ≤ 4 kbit/s average, ≤ 24 in any 1 s window (≤ 3 KB) | ≤ 2.4 kbit/s |

The game specs' own budgets were payload-only. These include framing, which is why Bellwick's uplink is 16.5 kbit/s here rather than the spec's 3.

### 7.2 Does it fit? (worst case: a 3G phone playing Bellwick at the boss, all four people talking)

| | Down (750) | Up (250) |
|---|---|---|
| Voice, 3 streams at 24 kbit/s with overhead | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | ~4 | ~3 |
| Bellwick | 31 | 16.5 |
| **Total** | **182 (24 %)** | **167 (67 %)** |
| Same, without the voice cap | ~495 (66 %) | **~480 (192 %: fails)** |

The 83 kbit/s of uplink headroom absorbs TCP retransmissions and RTCP. Video and screenshare are off on cellular today, and that does not change.

### 7.3 Worse than budget

| Link | What happens |
|---|---|
| 3G as budgeted | 15 Hz, chat unaffected |
| Queueing (RTT +150 ms for 1 s) | the ladder steps down to 10, 7.5, then 5 Hz; the interpolation delay grows to 300 ms |
| Below about 120 kbit/s for the game | the in-flight cap holds frames back, and the oldest events cause an `overflow` park, then a keyframe |
| Outage or tunnel | `stalled` after 2.5 s; the seat becomes a ghost or rests (§9.4); after up to 60 s, reconnect with the resume token and get a keyframe |
| Main-socket acks over 2 s | `yield`: the game pauses itself so chat and voice signalling catch up |

### 7.4 Server egress

| What | Egress |
|---|---|
| One Bellwick match (4 players, peak) | 4 × 31 = 124 kbit/s |
| One Fuseyard match with 4 spectators | 4 × 17 + 4 × 9.4 ≈ 106 kbit/s |
| Server-wide cap: 6 action matches plus tables and halls | ≈ 0.8 Mbit/s, inside the 1.5 Mbit/s degrade threshold |

A 30-minute 4-player match costs about 25 MB of egress.

Channel viewers who are not in the voice call receive only `arcade:activity` (§9.2), and only when it changes.

---

## 8. Authority, prediction, fairness

| Game | Online authority | Client role | Offline |
|---|---|---|---|
| Fuseyard | server runs `step()` (bots, PRNG and hidden items included) | predicts its own fighter with the shared `tryMove`; ghost bomb until `BombPlaced` | local `step()` |
| Bellwick | **hybrid**, per its spec: each client owns its hero's movement; the server owns enemies, the boss, drops, keys, doors, chests, the purse, flags, revival and saves, and checks hero state and hit claims | owns its hero; renders others interpolated | local sim |
| Lamplight | server: shuffle, deal, validation, clocks | renders views, sends intents | local engine, practice chips |
| Glimmerhall | server: stops via `crypto.randomInt`, payout, pot, ledger | animates toward known stops | local engine, practice chips |

### 8.1 Lamplight hidden information and the deck proof

- **Shuffle and views.** The shuffle is Fisher–Yates with `crypto.randomInt(i + 1)`, and cards are integers 0–51. `viewFor(state, seat)` is the only serializer: it strips every hole card except the recipient's own, and the board is sent one street at a time. `hole` goes only to `acct:<accountId>`. Spectators and bots' seats get `null`. Bot cards never leave the server.
- **Commitment.** At the deal the server draws a 32-byte `handSecret` and computes:
  - per position `i`: `salt_i = HMAC-SHA-256(handSecret, i)[0..16]`;
  - per position `i`: `leaf_i = SHA-256(i ‖ card_i ‖ salt_i)`;
  - `root = SHA-256(leaf_0 ‖ … ‖ leaf_51)`.

  `hand` carries `cr = base64url(root)`. `hole` carries the owner's two salts.
- **Proof on demand.** For 30 days, a player seated in that hand may call `lamplight:proof {handId}`. The answer holds all 52 leaves (≈ 2.2 KB base64) plus the cards and salts of the board and of hands shown at showdown. The client checks the root, its own cards, the board and the shown cards.
- **What stays hidden.** Mucked cards and the undealt deck appear only as salted leaf hashes, so they stay hidden, as the poker spec §10 requires. No proof traffic flows unless someone asks.
- **Honest limits.** This proves the deck did not change during the hand. It cannot stop whoever runs the server from choosing the deck, and it cannot stop friends from telling each other their cards on voice. Both are acceptable for play chips, and the hand-history drawer says so.
- **Clocks.** Server deadlines and time banks follow the poker spec §5. Clients count down from `remainingMs`.
- **Bots** see only `viewFor(seat)`, wait a cosmetic 0.6–1.5 s before acting, and have their Monte Carlo capped at 2 ms per decision on the server.

**Firefly Trio.** When the third player registers, the server draws `crypto.randomInt(1_000_000)` and maps it through the admin table (default: the poker spec's table, EV 2.9725). It reveals the multiplier over 3 s, then deals. No commitment is needed, because the value is public before any play.

### 8.2 Glimmerhall

Per the slots spec.
- **One transaction per spin:** debit, draw, evaluate, feature, pot check, credit, stats and receipt. Each spin is idempotent by `(accountId, clientId)` through `arcade_txns.idem`.
- **Limits:** one spin in flight and at most 2 spins/s per account. Excess gets a quiet `{busy: true}`.
- **Pot persistence:** the Glimmer Pot is a ledgered pool (§11), so it survives restarts.
- **Pending feature:** a pending Three Vaults pick survives restarts in `arcade_pending`.

### 8.3 Interest management

- **Recipients.** Action-lane traffic goes only to the match's players and its opted-in watchers.
- **Fuseyard:** `hidden` (items under blocks) has no field in any codec. `BlockBroken` is the first message that names an item.
- **Bellwick:** per-room routing.
  - Each client gets the snapshot, events and keyframes of the room its hero is in, plus a 1 Hz roster of all heroes (6 B each).
  - The server simulates only rooms with an active hero, so at most 4. Per-client cost is one room whether the party stays together or splits.
  - A room change is `EnterRoom` (EVT) answered by a KEYFRAME with reason 4. The 600 ms screen slide hides the RTT.

### 8.4 Ticks, prediction, interpolation

- **Rates.** The sim runs at a fixed 30 Hz on both sides with integer state. Frames go out at 15 Hz (the ladder in §6.1). Rendering is capped at 60 fps.
- **Fuseyard prediction.** On each FRAME the client sets its fighter to the server position and replays its inputs newer than `ackUp` through the shared `tryMove`. Errors under 32 units blend out at 25 % per frame. Larger errors snap. Corner sliding lives in the shared step, so prediction matches the server.
- **Interpolation by server tick**, not arrival time. This replaces the old engine's arrival stamping.
  - Others render at `estServerTick − delay`, where `delay = clamp(2 × interval + jitterP90, 100, 300) ms`.
  - That is about 130 ms on Wi-Fi and 200–300 ms on 3G.
  - Extrapolation is capped at 100 ms, then motion holds.
  - The clock comes from PING and PONG with a min-RTT filter over 8 samples.
- **Kept lag handling (v1):**
  - **Fuseyard dodge grace:** `clamp(round(rtt / 66 ms), 0, 4)` ticks in flame before death. It is set per human at round start and stored in state.
  - **Bellwick hit claims:** checked against a 16-tick (≈ 530 ms) per-room ring of enemy positions, with 4 px of slack. That is 12 enemies × 16 ticks × 4 B = 768 B per room.
- **Cut from v1:** server rewind on input timestamps, flame sparing for late inputs, and rewinding server-simulated hits. Revisit only if playtests ask for it.

---

## 9. Lifecycle

### 9.1 Identity

- Everything is keyed by `accountId`, never by `socket.id`. A seat is `(matchId | tableId, accountId)`.
- One seat has one controlling connection. A newer HELLO for the same seat takes it over. The older connection gets BYE 4409 and its UI shows "Playing in another window · Play here".
- Players are listed by display name, looked up from presence when shown. Display names are never stored in Arcade tables.

### 9.2 Joining is opt-in

- **Lobbies** are per voice channel. They show as a passive **LobbyChip** in the voice header, for example "Fuseyard · 2/4 · Join seat · Watch". The same summary feeds the channel-list badge.
  - No toast, no sound, no change of view.
  - An account with "Hide Arcade" on sees no chips or badges.
- **Who can do what**

  | Action | Who |
  |---|---|
  | Create a lobby, sit as a player | voice members of that channel |
  | Watch | voice members, and anyone with `view` on the channel; up to 4 per action match and 8 per table (none in Bellwick v1) |

  Channel viewers outside the call receive only `arcade:activity` (≤ 150 B, on change, at most once per 2 s) until they press Watch.
- **Invites.** `arcade:invite` pings one named voice member, at most once a minute per pair, and never while they are on Do Not Disturb. It shows as a dismissible InviteChip that expires after 60 s.
- **Late join**
  - Fuseyard: late joiners watch until the next round, then take a free or bot seat.
  - Bellwick: drop in beside the hero who has been in the session longest.
  - Lamplight: dealt in from the next hand, with "post BB now" or "wait for BB".
  - Glimmerhall: any time.
  - Glimmer Dash: only before it starts.

### 9.3 Limits (admin-tunable, `arcade.limits`)

| Limit | Default |
|---|---|
| Action matches per voice channel | 1 (Fuseyard or Bellwick) |
| Tables per voice channel | 2 |
| Halls per voice channel | 1 |
| Action matches server-wide | 6 |
| Tables server-wide | 10 |
| Server bots | 6 poker bots server-wide; Fuseyard bots are free (inside the sim) |
| Spectators | 4 per action match, 8 per table |
| Unstarted lobby | closes after 10 min |

### 9.4 Reconnect, grace, hidden

**Grace and ghost rules.** No grace period ever kills or drops a returning player.

| Game | Trigger (disconnect, `stalled`, `away` or `yield`) | During grace | Back in time | Grace over |
|---|---|---|---|---|
| Fuseyard | after 2.5 s stalled, or at once on away, yield or close | **Ghost:** frozen, drawn translucent with a signal icon; invulnerable (flames ignore it); not solid (fighters and bombs pass through); cannot place bombs (bombs already placed still tick); does not count toward "last one standing", so a ghost never wins a round. If every fighter still alive is a ghost, the round pauses (Closing Time included) until someone returns. | Keyframe, then 45 ticks of invulnerability, and play on | After 60 s per episode, or 90 s cumulative per match, a cautious (Scrapper-level) bot takes the seat. The human may reclaim it at the next round start. |
| Bellwick | the same triggers | **Resting** (spec): seated, invulnerable, ignored by enemies | Restored; a fresh RoomInit keyframe | After 60 s the hero leaves the session. The save keeps their tunic and stats. |
| Lamplight | main-socket disconnect | Poker spec §5: seat and action clock kept, no time bank; sit out after 2 hands | A `snap` with your own cards | Cash: after 5 min disconnected (10 sitting out) the stack goes back to the wallet. Tournaments keep posting blinds and folding. |
| Glimmerhall | main-socket disconnect | Nothing is at stake: spins are settled server-side | `glimmer:resume {id}` answers from the receipt | The hall seat drops after 120 s |
| Lobby (unstarted) | disconnect | The seat is held | Kept | Released after 30 s |

- **Hidden or minimized** (merged visibility, §10.3): the client sends VIS 1 and the server parks it (`away`), so there is no frame traffic (§6.2).
  - Fuseyard and Bellwick treat the player as above.
  - Lamplight seated players keep the tiny event stream, and on their turn get one chime and the attention badge, as in the poker spec.
  - Glimmerhall sends `glimmer:away` and leaves the hall room until it returns.
- **Closing the game** ("Leave") closes the lane with 1000 and releases the seat at once:
  - Fuseyard: a bot takes the seat.
  - Bellwick: the hero leaves.
  - Lamplight: "leave after this hand".
- **"Back to call"** (minimize) counts as `away`.

### 9.5 Idle

- **Action matches**
  - A match ends after 30 s with no human connected, or 120 s with no human input. Bots never keep a match alive.
  - Bellwick saves and ends 60 s after everyone leaves, or after 5 idle minutes, per its spec.
- **Tables** close 2 minutes after the last human leaves, or once all of a cash table's humans have sat out for 5 minutes. Tables never run with only bots.
- **Timers.** The scheduler stops when there is no live action match. A table holds one `setTimeout` for its clock, and only during a hand. With nothing open, the Arcade runs no timers at all.

### 9.6 Deploys, restarts, overload

- **`server:restarting`** (`server/src/shutdown.ts`) calls `arcade.onRestarting()`:
  - **Action matches:** each player gets PHASE 4 (reason "restart") and a HANDOVER with the full state, hidden items included. Results are void from then on, so secrecy no longer matters. The lane then closes with 1012.
  - **Bellwick parties** are saved first.
  - **Lamplight:** the hand in progress is voided. Stacks were escrowed at hand start, so every escrow row is refunded with reason `restart-refund`. Unfinished tournaments are refunded.
  - **Glimmer Dash** buy-ins are refunded. Spins are atomic, and a pending vault survives.
- **On boot**, every leftover `arcade_escrow` row is refunded. That covers crashes without notice.
- **Continue offline.** After PHASE 4, or when the lane cannot be resumed, the stage offers two choices:
  - **"Continue offline vs bots (results won't count)":** a LocalHost (§10) starts from the HANDOVER state, and remote players become bots. If no HANDOVER arrived (a crash), it starts from the last keyframe and events, with hidden block contents re-rolled from a local seed.
  - **"Wait and rejoin"**, once the server is back.

  Bellwick party members continue from a local copy of the save, which never syncs back.
- **Overload** (watchdog, §13.4): the match ends with PHASE 4 reason "overload", a HANDOVER, and the same continue-offline offer.

---

## 10. Client architecture and UI integration

### 10.1 Coarse state only in Preact

`features/arcade/state.ts` holds four signals. Each is written at most about once per second, on lobby, seat or phase changes.

```ts
arcadeActivity: Signal<Map<channelId, ActivitySummary>>   // from arcade:activity
arcadeLobby:    Signal<LobbyView | null>                  // the lobby you are in
arcadeSession:  Signal<{ game; id; role; mode: 'local'|'remote'; status: 'connecting'|'live'|'lagging'|'paused'|'away'|'ended' } | null>
arcadeWallet:   Signal<{ bal; esc; claim } | null>
```

- **Games never write signals per tick.** Frames go straight from `laneClient` into the game module, so VoicePage never re-renders on game traffic. In dev builds, `state.ts` counts writes and warns when a signal is written more than twice a second.
- **HUD** (scores, hearts, timers) is drawn on the canvas.
- **Poker action bar and slots buttons** are small DOM subtrees owned by those game modules (event-driven, never ticked). VoicePage does not read them.
- **Touch controls** are built once at mount and never re-rendered.

### 10.2 Render loop and canvas

- **`runtime/loop.ts`** subscribes to `lib/frames` with `{maxFps: 60}` only while all of these hold:
  - the game is open, not paused and not minimized;
  - the merged visibility is true;
  - an IntersectionObserver says the stage is on screen;
  - something is dirty.
- **Turn-based games draw on demand.** Poker draws when an event arrives or an animation is running. A slots spin animates for about 2 s, then the loop unsubscribes. Paused or still frames draw nothing.
- **Offline action sims** step inside the frame callback with a fixed-step accumulator: at most 4 steps per frame, and the backlog is dropped after a stall. Hidden therefore means paused offline.
- **Canvas.** A ResizeObserver on the stage container (the `useElementSize` logic) sizes it, times DPR capped at 2.
  - Logical size: Fuseyard 240 × 208, Bellwick 192 × 160.
  - Integer device-pixel scaling, fractional below 2×, `imageSmoothingEnabled = false`.
  - The static layer is baked once (Fuseyard pillars and floor, Bellwick room tiles).
- **Unmount** releases everything: the frame subscription, listeners, the gamepad poll, the AudioContext, the lane, and canvases set to 0 × 0. A test asserts that nothing is left (§14.4).

### 10.3 Visibility merger (`runtime/visibility.ts`)

The game counts as **visible** only when all of these hold:
- `appVisibility` (§2.2) is visible;
- the stage is not minimized ("Back to call");
- the IntersectionObserver reports at least 10 %.

Every change calls `host.setVisible`. Remote, that sends VIS. Local, it pauses the loop and suspends audio.

### 10.4 Input

- **Sampling.** Input is sampled once per sim tick into a byte (Fuseyard) or a hero action (Bellwick). Presses are latched between samples, so a 10 ms tap is never lost.
- **Keyboard**

  | Action | Keys |
  |---|---|
  | Move | arrows or WASD |
  | A (bomb, sword) | Space or J |
  | B (detonate, item) | K or Shift |
  | Pause | Esc or P |

  Keys are captured only while the canvas has focus, and the existing `isTyping` guard applies. The configured push-to-talk key and the app shortcuts (Ctrl+K, Ctrl+Shift+M/D/comma, Alt+C, Escape outside the canvas, F12, Ctrl+Shift+I) are never bound.
- **Touch** (`(pointer: coarse)`), drawn on an overlay built once:
  - a floating stick with a 12 px dead zone and 48 px radius, as in the Fuseyard spec §6.3;
  - two buttons, 56 px and 76 px, placed in the safe area;
  - pointer capture, `touch-action: none`, and release on `pointercancel` or blur;
  - a 10 ms vibration on Android, off by default;
  - a D-pad option.
- **Gamepad** (standard mapping, 0.3 dead zone; A = 0, B = 1 or 2, Start = 9) is polled only inside the frame callback.

### 10.5 Audio and art

- **Audio.**
  - Effects are synthesized with Web Audio (oscillators, noise, envelopes), and short effects are pre-rendered with an `OfflineAudioContext` when the game opens.
  - One context per open game, created on the first in-game gesture, suspended when hidden, closed on unmount.
  - Master volume is 40 %, below voice, because speaker audio leaks into the mic. Music is off by default online.
- **Art.** Sprites are palette-indexed text grids rasterized once into an `ImageBitmap` atlas per game, and the bitmap font is 5 × 7. Everything is original: no assets are downloaded, and nothing is traced.

### 10.6 Where it shows up

- **Voice page.**
  - The old Minigames header button (`VoicePage.tsx:337–343`) becomes **Arcade**, a gamepad IconButton that opens `ArcadeSheet`. On phones there is the same button in `VoiceDock`.
  - The sheet is a `Sheet` on phones and a `Menu` popover on desktop. It lists this channel's lobbies (Join, Watch), "Start a game", "Solo vs bots", the wallet pill and the daily claim.
  - **Starting or joining** replaces the video grid *on your own screen only*. The voice tiles collapse to a strip (the existing immersive layout), and the header gets "Back to call", which minimizes.
  - A minimized running game shows as a chip, "Fuseyard running · Return".
- **Channel list.** `ChannelList.tsx:138` keeps its Gamepad2 badge, now driven by `arcadeActivity` instead of `currentMinigame`.
- **Global entry.** "Arcade" in the user menu opens solo play (LocalHost) even while online. It costs the server nothing, and results don't count.
- **Offline entry.** "Play offline" on the login screen, on the ConnectionBanner while offline, and on the desktop and Android server-unreachable screens (§12).
- **Phone.**
  - Action games prefer landscape and use the existing immersive mode (Capacitor SystemBars on Android).
  - In portrait the canvas takes the top 60 % and the controls the bottom 40 %. Poker and slots are portrait-first.
  - `useBackClose`: Android back opens the pause menu, and a second back minimizes.
  - Wake Lock (`navigator.wakeLock`) is held while an action game is live and visible. It is supported in WebView 84+; without it, nothing happens.
- **Desktop.** Gamepads work, and the push-to-talk key is excluded (§10.4). There is no pop-out window in v1.
- **Settings.**
  - Account: "Hide Arcade" (the slots spec's self-exclusion, generalized to all games, with per-game toggles).
  - Device: control layout, vibration and volume, stored in `lib/storage` under `datasetto.arcade.prefs.v1`.

---

## 11. Persistence: migration 14, wallet, stats

### 11.1 Migration 14 (`server/src/db/migrations.ts`, append-only; migration 1 is not edited)

```sql
-- version: 14, name: 'arcade'
DROP TABLE IF EXISTS leaderboard;                       -- old minigame scores (migration 1)

CREATE TABLE arcade_wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL CHECK (balance >= 0),
  claim_day  TEXT,                                      -- UTC 'YYYY-MM-DD' of the last daily claim
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per chip movement; its ledger rows sum to zero (double entry).
CREATE TABLE arcade_txns (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,   -- grant, claim, buyin, cashout, prize, spin, feature, pot_seed, refund, restart-refund, admin, fold
  ref        TEXT,            -- table / tournament / spin / match id
  actor      TEXT,            -- account that caused it; NULL for system
  idem       TEXT,            -- client idempotency key (spin id, action id)
  result     TEXT,            -- compact JSON receipt returned on a retry (cleared after 24 h)
  created_at INTEGER NOT NULL,
  UNIQUE (actor, idem)
);

CREATE TABLE arcade_ledger (
  txn_id        INTEGER NOT NULL REFERENCES arcade_txns(id),
  account       TEXT NOT NULL,   -- 'w:<accountId>' wallet | 'e:<ref>:<accountId>' escrow | 'p:<scope>' pot | 'house'
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind          TEXT NOT NULL,   -- copy of arcade_txns.kind, for leaderboard queries without a join
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (txn_id, account)
);
CREATE INDEX arcade_ledger_account_time ON arcade_ledger(account, created_at);

CREATE TABLE arcade_ledger_months (       -- rows older than 90 days fold here
  account TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL,
  delta INTEGER NOT NULL, rows INTEGER NOT NULL,
  PRIMARY KEY (account, month, kind)
);

CREATE TABLE arcade_escrow (
  ref        TEXT NOT NULL,              -- 'lamplight:<tableId>' | 'cup:<id>' | 'trio:<id>' | 'dash:<id>'
  account_id TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  kind       TEXT NOT NULL,              -- 'stack' | 'buyin'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ref, account_id)
);

CREATE TABLE arcade_jackpots (
  scope       TEXT PRIMARY KEY,          -- 'glimmer'
  pool        INTEGER NOT NULL CHECK (pool >= 0),                      -- whole chips, ledgered as 'p:<scope>'
  carry_e4    INTEGER NOT NULL DEFAULT 0 CHECK (carry_e4 BETWEEN 0 AND 9999),  -- sub-chip remainder (house-owned)
  last_winner TEXT, last_amount INTEGER, last_won_at INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE arcade_pending (            -- open features (Ember Vault pick) that survive restarts
  account_id TEXT NOT NULL, game TEXT NOT NULL, kind TEXT NOT NULL,
  txn_id INTEGER NOT NULL REFERENCES arcade_txns(id),
  data TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, game)
);

CREATE TABLE arcade_stats (
  account_id TEXT NOT NULL, game TEXT NOT NULL, stat TEXT NOT NULL,
  value INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, game, stat)
);

CREATE TABLE arcade_results (
  id INTEGER PRIMARY KEY, game TEXT NOT NULL, mode TEXT NOT NULL, channel_id TEXT,
  humans INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  summary TEXT NOT NULL                  -- compact JSON: multiplier, rounds, clear time, …
);
CREATE INDEX arcade_results_game_time ON arcade_results(game, ended_at);
CREATE TABLE arcade_result_players (
  result_id INTEGER NOT NULL REFERENCES arcade_results(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, place INTEGER, score INTEGER,
  chips_delta INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (result_id, account_id)
);
CREATE INDEX arcade_result_players_account ON arcade_result_players(account_id, result_id);

CREATE TABLE arcade_poker_hands (        -- hand history + deck proof; pruned after 30 days, ≤ 2,000 per table
  id INTEGER PRIMARY KEY, table_ref TEXT NOT NULL, hand_no INTEGER NOT NULL, format TEXT NOT NULL,
  seats TEXT NOT NULL,                   -- JSON account ids seated (who may fetch the proof)
  commit_root BLOB NOT NULL,             -- 32 B
  hand_secret BLOB NOT NULL,             -- 32 B (salts derive from it)
  deck BLOB NOT NULL,                    -- 52 B card order
  record TEXT NOT NULL,                  -- ~1 KB JSON history
  created_at INTEGER NOT NULL
);
CREATE INDEX arcade_poker_hands_table ON arcade_poker_hands(table_ref, id);
CREATE INDEX arcade_poker_hands_time ON arcade_poker_hands(created_at);

CREATE TABLE arcade_saves (              -- Bellwick progress flags, not sim state
  owner_id TEXT NOT NULL, game TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
  version INTEGER NOT NULL,
  data BLOB NOT NULL CHECK (length(data) <= 4096),
  members TEXT NOT NULL DEFAULT '[]',    -- account ids who played in it
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, game, slot)
);
```

**Mapping from the game specs.**

| Spec table | Platform table |
|---|---|
| `poker_wallets` | `arcade_wallets` |
| `poker_ledger` | `arcade_txns` + `arcade_ledger` |
| `poker_escrow` | `arcade_escrow` |
| `poker_hands` | `arcade_poker_hands` |
| `poker_results` | `arcade_results` + `arcade_result_players` |
| `glimmer_pot` | `arcade_jackpots` |
| `glimmer_pending` | `arcade_pending` |
| `glimmer_last` | `arcade_txns.result` |
| `glimmer_stats` | `arcade_stats` |

Nothing about the old games needs migrating:
- no channel rows (there was no minigame channel type);
- no settings keys;
- `currentMinigame` lived only in memory.

### 11.2 Wallet (`server/src/arcade/wallet.ts`)

- **`transfer(kind, ref, actor, idem, legs[])`** is the only way chips move. Each leg is an account and a delta. It runs in one `db.transaction`:
  1. If `(actor, idem)` already exists, it returns the stored receipt and does nothing else.
  2. It checks that the legs sum to zero.
  3. It applies every leg:
     - a wallet leg as `UPDATE arcade_wallets SET balance = balance + ? WHERE account_id = ? AND balance + ? >= 0`, which must report `changes === 1`;
     - an escrow leg as an upsert, deleting the row at 0;
     - a pot leg on `arcade_jackpots.pool`;
     - `house` is unconstrained and may go negative: it mints and burns.
  4. It inserts one ledger row per leg with `balance_after`.
- **Rules** (from the poker spec):
  - A new account is granted 20,000 on first wallet read (`grant`, house → wallet).
  - The daily claim (`claim`) gives `max(2000, 10000 − (balance + escrow))` once per UTC day.
  - No transfers between players, no purchases, no cash value.
- **Glimmer Pot.** Each online base spin adds `bet × 75` e4-units to `carry_e4`. Whole chips move from house to `p:glimmer` as one leg of the spin's txn. The pot is seeded with 7,500 (`pot_seed`, house → pot) when the row is first created and after every win.
- **Firefly Trio prize.** The prize is `buyIn × multiplier`. The buy-ins come out of escrow, and the house mints the rest at payout.
- **Retention.** A daily job moves ledger rows older than 90 days into `arcade_ledger_months`. Conservation holds over the sum of both tables. Receipts (`arcade_txns.result`) are cleared after 24 h. Poker hands are pruned after 30 days, or beyond 2,000 per table.

**Invariant (tested, §14.1):**
- every txn's legs sum to 0;
- every `w:` account's ledger sum (detailed plus folded) equals `arcade_wallets.balance`;
- every `e:` account's sum equals its escrow row;
- every `p:` account's sum equals its jackpot `pool`;
- no wallet, escrow or pot balance is ever negative.

### 11.3 Stats and leaderboards (`stats.ts`, 60 s cache per board)

| Board | Query |
|---|---|
| Lamplight weekly net | `SUM(delta)` over `w:<id>` rows from the last 7 days, with kind not in (grant, claim, admin, refund, restart-refund), using `arcade_ledger_account_time` |
| Lamplight Cup wins, biggest Trio multiplier, biggest pot | `arcade_results` and `arcade_result_players` |
| Fuseyard wins, Bellwick fastest clear, Glimmerhall best win | `arcade_stats` |

Only games with at least 2 humans count, per the poker spec. Offline and solo results stay on the device.

### 11.4 Admin settings

These go in SettingsService under the key `arcade`, with a zod parser, edited in a new **Admin › Arcade** section:

| Setting | Values | Notes |
|---|---|---|
| `enabled` | bool | |
| `games` | per-game bools | Turning a game off ends its rooms and refunds escrow |
| `startChips` | number | |
| `claimFloor` and `claimMin` | numbers | the daily claim formula |
| `trioTable` | multiplier table | the validator rejects EV ≥ 3 buy-ins or weights not summing to 1,000,000 |
| `slotsMaxBet` | number | |
| `serverBots` | bool | |
| `limits` | §9.3 values, plus `egressKbps` and `lanePerIp` | |

- **Admin actions:** reset a wallet (an `admin` txn), void a table, and a ledger view of each account's last 100 txns.
- **Delivery to clients:** public flags (`enabled`, `games`) go out with `GET /api/config` and `auth:success`. Offline, everything is enabled.

---

## 12. Offline mode

- **One interface, two hosts.**
  - `remoteHost.ts` wraps the action lane, or the table lane for poker and slots.
  - `localHost.ts` runs the same `core/<game>` sim or engine in the client. Its bots are the same pure functions the server uses, `decide(view, rng)`. They get the same filtered view a client gets, so they cannot cheat by construction.
  - Offline, the client simply has authority. It does no prediction and no reconciliation, and that path has its own tests.
- **What runs where offline**

  | Part | Where |
  |---|---|
  | Fuseyard and Bellwick sims | main thread, inside the frame loop (pauses when hidden) |
  | Lamplight engine | main thread, event-driven, with `setTimeout` clocks |
  | Lamplight bot Monte Carlo | a Worker started on demand and terminated on close, per the poker spec |
  | Glimmerhall | main thread |
- **Seeds.** Seeds come from `crypto.getRandomValues`. Poker uses xoshiro128** and keeps the seed in hand history. Slots use rejection sampling.
- **Practice wallet** (`runtime/practiceWallet.ts`):
  - It holds practice chips for poker and slots in `localStorage` under `datasetto.arcade.practice.v1`.
  - Every access is wrapped in try/catch with an in-memory fallback.
  - It never syncs and never converts in either direction, and practice chips are badged "PRACTICE".
  - A free refill to 10,000 is always available when the balance is below the minimum bet.
- **Bellwick Solo Tale** has 3 local save slots under `datasetto.arcade.bellwick.saves.v1`, with the same 4 KB format as `arcade_saves`.
- **Where it works with no network**

  | Platform | Offline |
  |---|---|
  | Desktop shell | yes: it loads the bundled client from `file://` |
  | Android shell | yes: Capacitor's local server |
  | Web, warm (page already open, game chunk already loaded) | yes, after the network drops |
  | Web, cold start | no: `sw.js` has no fetch handler; out of scope |

  The Arcade shell must not depend on the socket, `/api/config` or a signed-in account when started from "Play offline". It mounts with defaults.
- **Offline stats** are kept in `localStorage` and never uploaded.

---

## 13. Server internals

### 13.1 Scheduler (`scheduler.ts`)

- One drift-corrected loop at 33.33 ms, using `setTimeout` with `process.hrtime.bigint()` for the target time. It catches up at most 3 steps, then drops the backlog.
- It is started by the first live action match and stopped when the last one ends.
- Each tick runs `step()` for every match, then the sender's slot processing for every recipient.

### 13.2 Budgets

- All matches together get at most 2 ms per tick (p99), measured with `perf_hooks.createHistogram`.
- Old-engine ticks took 0.01–0.1 ms. Fuseyard's spec budget is 0.2 ms per match tick, and Bellwick's is ≤ 4 rooms.
- Worker threads are not justified for v1. `MatchRuntime` is an interface, so a room can move to a worker later if the event-loop rule keeps firing.

### 13.3 Limiters (new LimiterKinds; the old `game` kind is removed)

| Kind | Budget | Applies to |
|---|---|---|
| `arcade` | 20 per 10 s | lobby, ticket, invite, board and saves events |
| `arcadeAct` | 4 per second | Lamplight actions (poker spec §7) |
| `spin` | 2 per second, plus one in flight | Glimmerhall spin and pick |
| `arcadeProbe` | 1 per 2 s | the "chat first" probe |
| invite pair | 1 per minute per (from, to) | `arcade:invite`, kept in the hub |

Excess is refused quietly (`{ok: false, code: 'busy'}`, debug log).

### 13.4 Runaway-sim safety (the shared event loop carries chat)

`try/catch` alone does not stop an infinite loop, so there are four layers:

1. **Bounded loops by construction.** No `while` or `do` in `core/*/sim` or `core/*/bots`; the grep test enforces it. Every loop runs over a fixed capacity:

   | Game | Pools |
   |---|---|
   | Fuseyard | 195 cells, 32 bombs, an explosion queue of at most 32, BFS over at most 195 cells |
   | Bellwick | per room: 12 enemies, 16 projectiles, 12 pickups, 6 blocks; raycasts of at most 12 tiles |
   | Poker bots | Monte Carlo capped at 200 samples |

   Pools are preallocated, and spawning past a cap is refused.
2. **Per-step timing.** Each `step()` is timed. A match whose step exceeds 20 ms once, or 4 ms on 3 consecutive ticks, is ended with reason "overload" (§9.6).
3. **Replay dump.** An exception or an overload logs a pino warn with the base64 replay: seed, config, and an input ring of the last 30 s, at most 8 KB. `{seed, inputLog}` reproduces the bug in a unit test.
4. **Event-loop delay.** A p99 above 30 ms lowers rates, then refuses new matches (§6.5).

### 13.5 Shutdown

`createArcade` returns `{ stop(), onRestarting() }`. `stop()` joins the stoppables in `src/index.ts`, in place of `minigames`. It clears the scheduler, the table clocks and the reapers, and it persists saves and escrow refunds before the database closes.

---

## 14. Removal of the old games

Work through every item below. The list consolidates the reader findings.

**Server**
1. Delete `server/src/minigames/` (`MinigameManager.js`, `support.js`, `pacmanMaps/index.js`).
2. Delete `server/assets/pacman-maps/{classic,crossroads,gauntlet,nebula}.json`. `assets/` is then empty, so delete both `COPY assets` lines in `server/Dockerfile` (lines 13 and 31), or the image build fails.
3. Delete `server/src/socket/handlers/minigame.ts` (`registerMinigameHandlers`, `Minigames`, `GAME_TYPES`, the schemas).
4. `server/src/socket/index.ts`:
   - remove the MinigameManager import and construction (lines 5, 11, 124–134), `SocketServer.minigames`, the `registerMinigameHandlers` call, the `minigames` argument to `registerAuthHandlers`, `registerVoiceHandlers` and `teardownSocket`, and `return { io, minigames }`;
   - add `destroyUpgrade: false` and `createArcade(…)`.
5. `server/src/index.ts`: remove `minigames` from the destructuring (line 18) and from the stoppables (line 73), replacing it with `arcade`.
6. `server/src/socket/lifecycle.ts`: remove the `minigames` parameter of `leaveVoiceRoom` and `teardownSocket`, the `handleVoiceMemberLeft` call (line 22) and the doc comment. Add `arcade.onVoiceLeft(accountId, channelId)`, which starts that account's grace rules.
7. `server/src/socket/handlers/voice.ts`: remove the `Minigames` import and parameter, `handleVoiceMemberLeft` in `forceLeaveVoice` (line 61), and `getState` plus the `voice:game:state` emit in `voice:join` (lines 124–125).
8. `server/src/socket/handlers/auth.ts`: remove the `Minigames` import (line 10), the parameter (line 58) and `teardownSocket(sctx, minigames)` (line 188).
9. `server/src/socket/context.ts`: remove the `game` LimiterKind (line 9), its RateLimiter (line 54) and the `options.limiter !== 'game'` clause (line 129). Add the kinds in §13.3.
10. `server/src/services/presence.ts`: remove the `MinigameSummary` import, the `minigames` Map (line 92), `setMinigame` and `getMinigame` (lines 515–524), the delete in `forgetChannel` (line 279), `currentMinigame` in `channelView` (line 551) and the doc comment (line 82).
11. `server/src/types.ts`: remove `MinigameSummary` (lines 325–333) and `ChannelView.currentMinigame` (line 356).
12. Delete `server/src/services/leaderboard.ts`, and remove `AppContext.leaderboard` and its import and construction in `server/src/context.ts` (lines 7, 72, 126).
13. Database: migration 14 drops `leaderboard` (§11.1). Do not edit migration 1.
14. `server/tsconfig.json`: remove `allowJs`, `checkJs` and the `src/**/*.js` include.
15. `server/test/search.test.ts:373`: switch the cross-bucket probe to another generic-limiter acked event (`arcade:board`). Update the `TestServer.sockets` type in `server/test/helpers.ts`.
16. Add `server/src/arcade/legacy.ts`. For **3 releases** it answers old shells' `voice:game:start` and `voice:game:join` with `voice:game:error {message: 'Games moved to the Arcade. Update the app to play.'}`, which old shells already show as a toast. All other `voice:game:*` events are ignored. These event names are never reused.

**Client**

17. Delete `client/src/features/minigames/` (`MinigamePanel.tsx`, `engine.ts`).
18. `client/src/features/voice/VoicePage.tsx`: remove the `MinigamePanel` and `minigameState` imports (lines 16 and 41), `showGame`, `game` and `gameOpen` (lines 292–294), the `&& !gameOpen` immersive clause (line 328), the Minigames button (lines 337–343) and the panel branch (lines 346–347). Replace them with ArcadeButton and GameStage. Keep the Gamepad2 import (the PeerTile "Playing …" activity, line 98).
19. `client/src/state/misc.ts`: remove the `minigameState` signal and the `VoiceMinigameState` import (lines 14, 27–28).
20. `client/src/services/socket/bindings.ts`: remove the `voice:game:*` listeners (lines 530–545) and the imports (lines 56, 86).
21. `client/src/services/socket/api.ts`: remove `startGame`, `joinGame`, `leaveGame`, `endGame`, `sendGameInput` and `leaderboard` (lines 168–177), and the `MinigameType` and `LeaderboardEntry` imports.
22. `client/src/types/protocol.ts`: remove `MinigameSummary` (lines 94–102), `Channel.currentMinigame` (line 129), and the minigame block `VoiceMinigame*`, `MinigameType`, `PacmanState`, `FighterState` and `LeaderboardEntry` (lines 647–753).
23. `client/src/features/channels/ChannelList.tsx:138`: drive the badge from `arcadeActivity`.
24. `client/src/features/channels/CreateChannelModal.tsx:11`: replace the "play minigames" hint with "play Arcade games together".

**Docs and marketing**

25. Update `README.md` (lines 11, 20, 39), `client/README.md` (lines 26, 57), `server/README.md` (lines 44, 47, 50, 103, 124: the event table gets the `arcade:*` events and `/arcade/ws`), `ops/README.md` (line 477, the rate-limit bucket; line 493, the backup list, which now lists the Arcade tables), the comment at `ops/gcp/config.sh:9` and `.github/copilot-instructions.md` (lines 4, 15).
26. `client/public/landing.html`: update lines 7, 19, 27, 44, 56 and 337 (copy, meta, JSON-LD), line 373 (the chat mock that mentions an old game) and lines 416–417 (the minigames card becomes an Arcade card). `client/scripts/brand-assets.py:80`: change the chip from "Minigames" to "Arcade", then regenerate `client/public/og-image.png`.
27. Add `docs/arcade/platform.md` (this document) and the four game specs.

**Keep.** These are unrelated, so leave them as they are: `desktop/games/` (the process catalogue and matcher behind "Playing <game>"), `features/activity/*`, `state/activity.ts`, `GameActivitySection.tsx`, `presence:activity`, `User.activity`, and the `activity:*` IPC.

---

## 15. Tests and verification

**Verification time budget.** This answers the owner's complaint about 20-minute measurement runs. The old failure was obvious by 22 s (chat 11.7 s late) and the socket was dead at 45 s (r1), and a healthy link settles in under 5 s. So:

| Check | Where | Wall time cap |
|---|---|---|
| Core, codec, pacer, wallet, poker, slots suites | `server` `npm test` | ≤ 20 s added |
| Virtual-clock link simulator, all scenarios | `server` `npm test` | ≤ 1 s per scenario, ≤ 5 s total |
| Socket and lane integration | `server` `npm test` | ≤ 15 s |
| Client runtime and shell | `client` `npm test` | ≤ 5 s added |
| Real shaped smoke (manual, before a release or after transport changes) | `ops/bench/arcade-netbench.mjs` | 3 scenarios × 45 s, ≤ 4 min including setup |
| CPU and idle traces (manual) | the same bench, through CDP | 15 s per state, ≤ 2 min |
| Desktop CDP smoke and Android hidden check | existing recipes | ≤ 1 min each |

**Rules:**
- No single run may exceed 60 s, and there are no soak runs.
- A scenario aborts as soon as its pass or fail is certain.
- A full pre-release pass takes at most 10 minutes of wall time.
- Every browser launched for verification uses `--mute-audio` (plus `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`).

### 15.1 Server unit suites (Vitest, node)

- **Purity** (`core.purity.test.ts`): greps `server/src/arcade/core/**` for:
  - `Math.random`, `Date`, `performance`, `setTimeout`, `setInterval`, `crypto`, `for (… in`, `enum`;
  - `while (` or `do {` in `sim/` and `bots/`;
  - imports outside core.

  It also runs `tsc -p src/arcade/core/tsconfig.json` as part of `typecheck`.
- **Codec round-trips with size assertions**, so CI fails on budget creep:

  | Message | Limit |
  |---|---|
  | Fuseyard FRAME, 4 fighters, no events | ≤ 32 B |
  | Fuseyard keyframe | ≤ 512 B; typical arena ≤ 360 B |
  | Fuseyard UP | ≤ 9 B with n = 2 |
  | Bellwick snapshot body | ≤ 136 B with 12 entities |
  | Bellwick keyframe | ≤ 300 B |
  | Bellwick UP | ≤ 17 B |
  | WELCOME | ≤ 64 B + cfg |
  | Lamplight `snap` | ≤ 1.5 KB |
  | a 6-max hand | ≤ 4 KB |
  | a Glimmerhall spin ack | ≤ 400 B, except free-spin runs at ≤ 5 KB |
- **Golden replays.** For each game, `{seed, inputLog} → FNV-1a hash` at ticks 300 and 1,800. A changed hash fails until `SIM` is bumped in `core/version.ts`.
- **Fuzz and soak.**
  - 10,000 ticks of random inputs per game with no exception and bounded step time.
  - 1,000 headless Fuseyard bot matches in under 5 s, all of which must finish.
  - Bellwick: 200 bot runs through the dungeon script.
- **Delta-base fuzz.** A random schedule of skipped slots, parks (all four reasons), unparks and reconnects, applied through the real sender to a decoding client. After every keyframe-plus-events sequence, the client's world must equal the server's public view for that recipient.
- **Pacer** with synthetic ack traces:
  - the ladder steps down within 1 s of +150 ms queueing and up after 3 s calm;
  - an idle player sending only ACKs is never `stalled`;
  - after a 10 s silence, recovery costs one keyframe.
- **Poker.**
  - The evaluator over all 2,598,960 five-card hands (category counts), plus 100k seeded 7-card hands against brute force.
  - Side pots, min-raise and chip-conservation fuzz.
  - **Hidden-card scan:** scripted hands with three sockets. Every emit to every socket is structurally scanned: no other seat's hole cards before showdown, and no mucked cards ever. A proof request reveals only the board and shown cards.
  - **Deck proof:** verifying the root and the revealed cards passes, and tampering with one card fails.
- **Trio multiplier.** An exhaustive mapping of all 1,000,000 draw values reproduces the table exactly (under 50 ms), so EV < 3 is exact. The admin validator rejects bad tables.
- **Slots.** Exact RTP from the strips for each machine, plus 1M Monte Carlo spins within ±0.5 % (about 2 s). Retried spins are idempotent.
- **Chip conservation** (property test with a seeded random operation generator): 5,000 random grants, claims, buy-ins, cashouts, spins, pot wins, refunds, restart refunds and folds into months. The invariant in §11.2 must hold after every operation.
- **Fuseyard hidden items.** Decode every frame and keyframe sent to every recipient. No item code may appear for a cell before its `BlockBroken`.

### 15.2 Virtual-clock lossy-link simulator (`server/test/arcade/lossyLink.ts`)

The simulator models one client's bottleneck link in virtual time:
- downlink and uplink rates with a finite queue (64 KB);
- one-way delay of RTT/2 with jitter;
- loss modelled the way TCP experiences it: a lost segment and every byte behind it are delayed by `RTO = max(200 ms, 2 × RTT)`, which is head-of-line blocking;
- a constant non-backpressured voice flow of 147 kbit/s each way;
- a chat flow on the main-socket stream of one 200 B message per second, plus a `request()` every 2 s.

It drives the real `core/net/pacer`, the real codecs, the real `sender` logic with the clock injected, and the client's `interp` and Fuseyard predictor. Each scenario runs 60 simulated seconds in under 1 s.

| Scenario | Link | Pass |
|---|---|---|
| Wi-Fi | 20 Mbit/s, 30 ms | 15 Hz; prediction error p95 < 0.1 tile |
| 3G | 750 / 250, 300 ms, ±50 ms | chat one-way p95 < 300 ms; ≥ 13 frames/s; bytes/s within §7 ceilings; game queue ≤ 8 KB |
| 3G + 1 % loss | as above | chat p95 < 450 ms (RTT + 150); ≥ 10 frames/s; prediction error p95 < 0.25 tile |
| Collapse | 3G, then 120 kbit/s for 20 s, then back | ladder down within 1 s; ≥ 5 frames/s or a clean `overflow` park; recovery to 15 Hz within 5 s; no chat ack over 2 s |
| Tunnel | 10 s outage | `stalled` at 2.5 s → ghost; resume with one keyframe ≤ 512 B; client world equals the server's |
| Main-socket backlog | inject a 3 s ack delay | `yield` within 2.5 s, game paused, resumes after 2 probes |

### 15.3 Integration (`startTestServer`, accounts through `ctx.accounts.register` plus `ctx.sessions.create`, ≤ 15 s total)

- `/socket.io/` and `/arcade/ws` both upgrade on one server, and an unknown upgrade path is destroyed at once.
- A ticket is single-use and expires after 30 s. A bad Origin is rejected. HELLO times out after 5 s. Payloads over 4 KB close the socket.
- **Reconnect:** kill the lane mid-round, resume with the token within the grace, and keep the slot. After the grace a bot holds the seat, and the human reclaims it at the next round.
- **Takeover:** a second tab gets the seat, and the first gets 4409.
- **Hidden:** VIS 1 means the client receives nothing but pings. VIS 0 brings a keyframe.
- **Idle reapers:** 30 s with no humans, 120 s without input, a 2 min empty table. The timers are injected so the tests run in milliseconds.
- **Restart:** `onRestarting()` sends PHASE 4 and a HANDOVER, refunds escrow and saves Bellwick. A boot with leftover escrow refunds it.
- **Tick exception** ends only that match. An injected 25 ms step ends it with "overload" and a replay dump.
- **Old-shell stub:** `voice:game:start` gets `voice:game:error`.

### 15.4 Client (Vitest, jsdom)

- **Zero cost when closed.** Mount and unmount `ArcadeSheet` and `GameStage`, with each game module behind a fake host. Afterwards:
  - `frames.active === 0`;
  - no live `setInterval` or `setTimeout` (spied);
  - no open `WebSocket` (spied constructor);
  - no window, document or key listeners left (spied);
  - the AudioContext is closed.
- **Signals.** Feeding 100 frames per second into a game module writes no signals. VoicePage renders once.
- **Visibility merger:** document, IPC, Capacitor and IntersectionObserver fakes combine to the right VIS sequence.
- **Input mapping:** keyboard (PTT key and shortcuts excluded, `isTyping`), touch stick axis rules, pointercancel, gamepad dead zone.
- **Practice wallet** with a throwing `localStorage` falls back to memory.

### 15.5 Real shaped smoke (manual, bounded)

`ops/bench/arcade-netbench.mjs` is promoted from the existing measurement harness: a userland TCP shaper with rate, one-way delay and a finite buffer, whose backpressure reaches the server as on a real mobile link. Chrome's own network emulation does not delay WebSocket frames, so the shaper is a proxy.
- **Setup.** One process starts a test server with the Arcade. It adds 3 unshaped Node bot clients (`socket.io-client` + `ws`) and **one shaped client**, headless Chrome (`--mute-audio`, fake media), running the real client through the shaper. A chat prober sends a server-originated message every second and a `request()` every 2 s.
- **Link.** The shaper carries the non-voice share of 3G: 600 kbit/s down and 100 kbit/s up, which is 750/250 minus the capped voice, as in r1–r6. Head-of-line loss is injected as in §15.2.
- **Scenarios**, 45 s each, aborting early on failure:
  1. 3G;
  2. 3G with 1 % head-of-line loss;
  3. 3G with a 20 s collapse to 120 kbit/s in the middle.

  Pass criteria are as in §15.2, plus no ping timeout on either socket and lane `bufferedAmount` < 8 KB.
- **Real packet loss.** One optional 45 s `tc netem` run on the Docker test box, only if the head-of-line model and the bench disagree.

### 15.6 CPU (manual, bounded; CDP, 4× CPU throttle via `Emulation.setCPUThrottlingRate`)

Each state gets a 15 s trace, inside the bench's Chrome or the desktop CDP smoke:

| State | Pass |
|---|---|
| Idle voice page, Arcade closed | main-thread busy equal to the same build without the Arcade, ± 1 point; `frames.active === 0`; no `/arcade/ws` socket |
| Fuseyard vs 3 bots, open | main thread < 35 %; no long task over 50 ms; frame p95 < 16.7 ms at the 60 fps cap |
| Fuseyard minimized or hidden (Electron: `window:visibility` false) | 0 rAF callbacks; 0 Arcade timers; lane traffic at most the ping |
| Glimmerhall reels still | 0 frames scheduled |

Android: one WebView DevTools check that a backgrounded Fuseyard draws no frames and the server parked it, under 1 minute. If the emulator hits the known WHPX access error, the check is reported as blocked.

---

## 16. Idle main-thread cost (tracked item, phase 0)

**Symptom.** With nothing happening, the main thread is 20–23 % busy at 240 fps on desktop, and 94 % busy under 4× slowdown. Something renders every frame. This predates the Arcade, so it is fixed separately, but the Arcade's "0 % when closed" check (§15.6) is measured against the fixed baseline.

**Investigation** (≤ 3 minutes, `--mute-audio`)
1. **Snapshot the running animations.** On the idle voice page, CDP `Runtime.evaluate`:
   ```js
   document.getAnimations()
     .filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
     .map(a => [a.animationName, a.effect.target?.className])
   ```
   This lists every infinite animation that is running, instantly, with no trace needed.
2. **Snapshot the timers.** A dev-only probe wraps `setInterval` to list intervals of 100 ms or less and their stacks.
3. **One 10 s trace each:**
   - **at native refresh:** voice page idle, nobody speaking;
   - **at 4× throttle:** the same page;
   - **in a call:** one fake peer speaking.

   Categories: devtools.timeline and frame. Attribute paint and style per frame to selectors.

**Suspects confirmed present in the repo**

| Suspect | Where | Why it costs |
|---|---|---|
| `speaking-pulse`, infinite, animates `box-shadow` | `client/src/styles/app.css:193` (`.speaking-ring`, `Avatar.tsx:27`) | main-thread paint on every frame while anyone is "speaking" (240 paints/s) |
| `shimmer`, infinite, animates `background-position` | `app.css:201` (`.skeleton`, `MessageList.tsx:690`, `SearchPanel.tsx:134`) | paint on every frame while a skeleton is mounted, including ones left on screen |
| `pulse-dot`, infinite | `app.css:212` (`.live-dot`: `MainArea.tsx:41`, `ChannelList.tsx:137`, `UsageSection.tsx:69`) | runs whenever any stream channel is live, even in the sidebar |
| `animate-pulse` on the Clips indicator | `VideoTile.tsx:246, 272`, `HlsPlayer.tsx:357, 403` while `clip.recording` | Clips stays on in reused profiles, so this can run all session |
| Reconnect spinners | `Sidebar.tsx:13`, `ConnectionBanner.tsx:52` | only while reconnecting; verify they unmount |
| A 50 ms interval per remote peer | `services/voice/PeerAudioManager.ts:67` | N timers × 20 Hz of analyser reads |
| Mic meter at `MIC_LEVEL_INTERVAL_MS = 50` | `services/voice/AudioService.ts:687`, writing the `micLevel` signal 20×/s (`voiceManager.ts:674`) | 20 signal writes per second; any subscriber re-renders |

**Fix direction** (separate PR, confirmed by the trace before landing):
- Animate only `opacity` and `transform` on pseudo-elements, which the compositor handles, or stop after 3 iterations. Shimmer runs only while the skeleton is in view.
- The Clips indicator becomes a static dot with one pulse when recording starts.
- One shared speaking-detection timer for all peers, at 100 ms.
- `micLevel` is written only while a meter is mounted (subscriber count) and only on a change of more than 2 %. The overlay and PTT feedback paths keep their own feed while minimized.

**Acceptance.** Idle voice page, nobody speaking, no skeletons:
- `getAnimations()` shows no running infinite animations;
- no interval of 100 ms or less exists outside a call;
- main-thread busy is under 3 % at native refresh and under 10 % at 4× throttle in a 10 s trace.

A client test asserts that idle shell components register no infinite CSS animations: a class check against an allowlist in jsdom.

---

## 17. Changes this design makes to the game specs

The spec owners apply these when the specs move to `docs/arcade/`.

| Spec | Change |
|---|---|
| All | Shared code lives in `server/src/arcade/core/<id>/`, imported as `@arcade/core/<id>/…`. Replace `const enum` with `as const` objects. Budgets are restated with framing (§7). Opt-in, lobby and visibility rules follow §9 and §10. |
| Fuseyard | The "autopilot after 3 s" rule becomes the ghost rule (§9.4). The hidden client's `watching=false` is the platform VIS. The input batch keeps its layout with n = ticks since the last batch. Events and keyframes ride the FRAME and KEYFRAME envelopes. |
| Bellwick | Its two kinds of channel map to UP/EVT up and FRAME/KEYFRAME down on the action lane. The uplink is 16.5 kbit/s with framing, not 3. Per-room routing and a 4-room cap as specified. Saves go to `arcade_saves` (3 slots, ≤ 4 KB). Late join beside the longest-present hero. No spectators in v1. |
| Lamplight | The wallet and tables are the `arcade_*` tables (§11.1). §10 "No deck reveal" becomes the per-card proof (§8.1), which still never reveals mucked cards. "Chips separate from slots credits" becomes one shared chips wallet. The platform's queue is the §4.2 bucket and the §6.4 guard. |
| Glimmerhall | `poker_wallets` and the `glimmer_*` tables become the `arcade_*` tables. The timed tournament is renamed **Glimmer Dash** (`dash:*` events). "Hide Glimmerhall" becomes the Arcade-wide setting with per-game toggles. A hidden hall sends `glimmer:away`. |

---

## 18. Naming and wording rules

- **Names.** Every name, sprite, sound and line of text is original. Code, docs, commits, PRs, branch names and the old-shell stub text never mention the commercial products these games are inspired by, their formats or heroes, or the chat app this project is an alternative to. Branches use `arcade/<topic>`.
- **Pre-release name check.** Before the first public release, check each name in the EUIPO and USPTO trademark searches and in the app stores: Arcade (as a feature name), Lamplight Hold'em, Open Tables, Lamplight Cup, Firefly Trio, Glimmerhall, Pocket Orchard, Tidepool Treasures, Ember Vault, Glimmer Pot, Glimmer Dash, Fuseyard, Wicks, Bellwick, Old Clapper. Rename anything that collides.
- **Automated scan without naming anything.**
  - `server/test/naming.test.ts` holds only **SHA-256 hashes** of lower-cased words and word pairs on a deny list. It tokenizes `client/src`, `server/src`, `docs/`, the READMEs and `landing.html`, and fails on a hash match.
  - The maintainer keeps the plain list outside the repo. `node ops/scripts/name-hashes.mjs <file>` prints the hashes, and `--git` scans commit messages before a release.

---

## 19. Delivery phases and risks

**Phases.** Each phase ships on its own. Following the repo's practice: one VPS redeploy and one release per wave, and a PR only after web, server, ops, desktop and Android all work.

| Phase | Contents |
|---|---|
| 0 | Cellular voice cap (§2.1), `window:visibility` (§2.2), `lib/frames.ts` (§2.3), idle-cost fix (§16) |
| 1 | Remove the old games (§14); platform core (lane, tickets, hub, sender, scheduler, watchdog, wallet, migration 14, the Arcade shell, LocalHost, practice wallet); **Fuseyard**, which proves the action lane |
| 2 | **Lamplight Hold'em**, which proves the table lane, escrow and hidden information |
| 3 | **Glimmerhall**, which proves the jackpot, receipts and Glimmer Dash |
| 4 | **Bellwick**, which proves per-room routing, saves and the hybrid authority |

**Where this design is weak (honest)**

1. **It is still TCP.** Under loss the game stutters for about one RTO while chat does not. Unreliable data channels would suit action games better, but they would touch `createPeerConnection`, the most fragile voice code, so they are not planned.
2. **Shared event loop.** The small VPS runs chat and sims on one event loop. Bounded loops, step timing and the event-loop rule contain a bad sim, but they cannot preempt a truly infinite loop. That is why the loops are structural.
3. **Deploys end action matches.** "Continue offline" softens it, and Bellwick progress survives in saves.
4. **Bellwick's hybrid authority** trusts clients with their own hero. Server checks bound it, which is acceptable among friends with nothing of value at stake.
5. **The operator can always cheat** at poker and slots. The deck proof covers in-hand tampering only.
6. **Old desktop shells** without the visibility IPC keep drawing while minimized, until they are updated.
7. **The web build cannot start offline**, only the desktop and Android shells can.
8. **Scope is large.** The phases are ordered so that each one proves one platform piece before the next game depends on it.
