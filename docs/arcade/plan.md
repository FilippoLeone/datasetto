# Arcade rework: implementation plan

This plan turns the platform design (`docs/arcade/platform.md`, cited as **P§n**) and the four fitted game specs (Lamplight Hold'em **L§n**, Glimmerhall **S§n**, Fuseyard **F§n**, Bellwick **B§n**) into work packages that can be built in parallel git worktrees.

- **Nothing new was measured for this plan.** The r1–r6 link runs already settle the transport question (size and pacing matter, `volatile` does not). Every byte figure below is computed from the specs and the P§5.1 overhead model.
- **Verification is time-boxed throughout.** No single run takes longer than 60 s. The automated suites gain about 1 minute of CPU time in all. The manual pass is at most 10 minutes per release wave. Nothing soaks for minutes, and every measurement stops as soon as its pass or fail is certain (§3.0).
- File paths are relative to the repository root and were checked against `main` at `386e570`.

---

## 1. Scope and decisions

### 1.1 Scope

- **Remove** the three old minigames in full: the server engine, the handlers, the client panel and engine, the protocol types, the leaderboard service and table, the map assets, and docs and marketing copy (P§14). For 3 releases a stub answers old shells.
- **Phase 0 preconditions.** Four small, separate PRs:
  - a cellular voice cap;
  - Electron window visibility and an attention request;
  - one frame scheduler;
  - the idle main-thread cost fix.
- **Platform:**
  - one pure shared core, used by the server online and by the device offline;
  - two lanes: the existing socket for table games, and `/arcade/ws` for action games;
  - pacing and parking;
  - the server game host;
  - the wallet and migration 14;
  - the client shell, runtime and launcher UI;
  - offline hosts;
  - the admin section, test harnesses, a bounded bench, and docs.
- **Four games:**

  | Package | Game | Lane | Highlights |
  |---|---|---|---|
  | G1 | Lamplight Hold'em | table | Open Tables, Lamplight Cup, Firefly Trio |
  | G2 | Glimmerhall | table | three machines, Glimmer Pot, Glimmer Dash |
  | G3 | Fuseyard | action | the arena game |
  | G4 | Bellwick: The Silent Bells | action | Solo Tale and Party Tale |

  Every game works offline against bots with no server. Online, it works with voice-channel members who opt in.

### 1.2 Decisions the owner should know about

1. **Voice cap.** Phase 0 caps voice at 24 kbit/s per stream on cellular or slow links ("Data-saver voice: Auto / On / Off"). Without it, a 4-person call alone needs about 480 kbit/s of a 250 kbit/s 3G uplink.
2. **Old games and scores are deleted.** Migration 14 drops the old `leaderboard` table.
3. **Old shells.** For 3 releases, old desktop and Android builds that try to start an old game get "Games moved to the Arcade. Update the app to play.", and then the stub goes.
4. **Second connection.** Action games open a second connection, `/arcade/ws`, only while you are in a match. The Caddy config gains that path in the same redeploy.
5. **One wallet.** Poker and slots share one virtual chips wallet: 20,000 at the start, plus a daily claim. Nothing can be bought, sold, transferred or cashed out. Offline play uses Practice chips that never sync.
6. **Slots returns.** The machines return 94.2–94.8 % offline and 95.7–96.4 % online (the Glimmer Pot adds 1.5 %). Each machine shows its return on its "How it works" page. Slots are the economy's main chip sink.
7. **Firefly Trio economy.** The multiplier averages 2.9725 buy-ins against 3 paid in. Admins may edit the table, but not to an average of 3 or more.
8. **Online bots cannot be farmed.** Poker cash-table bots sit only at Pebble and Cobble, with capped rebuys. Cup bots never take prizes. The Trio and slots have no online bots.
9. **Poker fairness.** The server deals and hides cards. A per-hand deck proof shows the deck did not change during the hand. It cannot stop the operator choosing a deck, or friends sharing cards on voice, and the hand history says so.
10. **Opt-in only.** People in the call see a passive chip: no toast, no sound, no change of view. "Hide Arcade", with per-game toggles, hides everything. For slots it also acts as self-exclusion: turning it back off takes effect after 24 h.
11. **Lag never kills in Fuseyard.** A dropped player becomes a frozen, invulnerable ghost. After 60 s a cautious bot holds the seat until the next round.
12. **Deploys end action matches.** Players may "continue offline vs bots", and those results don't count. A poker hand in progress is voided and its chips refunded. Bellwick progress is saved first.
13. **Bellwick saves.** Party Tale saves belong to the host, and members cannot continue a shared tale without the host in v1. Bellwick has no spectators in v1.
14. **Offline start.** The desktop and Android apps start with no network at all. The web app plays offline only if it was already open.
15. **Server limits** (admin-tunable in a new Admin › Arcade section):
    - 6 action matches, at most 3 of them Bellwick;
    - 10 poker tables;
    - per voice channel: 1 action match, 2 tables, 1 hall.

    Admins can also switch off the Arcade or any single game, which refunds escrow.
16. **Verification time is capped** (§3.0, §4.2): no run over 60 s, and at most 10 minutes of manual checks per wave.
17. **Trademark search before the first public release.** The owner checks every game, place and item name (list in P§18 and B§15.15). The repo holds only SHA-256 hashes of the deny list.
18. **Releases come in waves:**

    | Wave | Contents |
    |---|---|
    | R0 | phase 0 |
    | R1 | platform + Fuseyard |
    | R2 | Lamplight + Glimmerhall |
    | R3 | Bellwick |
    | later | stub removal |

    Each wave gets one VPS redeploy and one release (§4.4).
19. **Bellwick trust.** Bellwick trusts each client with its own hero, so a modified client can cheat in co-op. Nothing of value is at stake. Its fastest-clear board can be gamed, and admins can reset stats.

### 1.3 Conflicts between the specs, resolved (one line each)

| # | Topic | Resolution |
|---|---|---|
| 1 | Ack shape | Arcade table-lane acks are `{ok: true, …}` / `{ok: false, code}`. `handle()` gains `refusal: 'arcade'`, so limiter refusals ack `{ok: false, code: 'busy'}` and never emit `error` (S§19.12). The rest of the app keeps `{success}`. |
| 2 | Host interfaces | `GameModule<H>` is generic. P ships `MatchHost` and one generic `TableHost`. Glimmerhall's `GlimmerHost` lives in its own chunk on top of `TableHost` (L§19.1, S§19.9). |
| 3 | Offline action play | Each action game exports a pure `CoreMatch` from its core. The server wraps it, and `createLocalMatchHost` steps it on the device, delivering one frame per tick with interpolation delay 0. Game modules keep one code path. |
| 4 | Runtime outputs | `CoreMatch.takeHostEvents()` carries phases (ordered after that tick's events), applied seat changes, rekeys, round starts, persist and end. It replaces a separate `takeRekeys()` and the ordered-PHASE hook (F§13.2, F§13.5, B§15.2). |
| 5 | Budget numbers | The game specs win over P§7.1 and P§15.1: Bellwick snapshot ≤ 91 B, keyframe ≤ 384 B, UP 16 B; Fuseyard spectator 10.7 down / 5.2 up kbit/s; a Glimmerhall free-spin ack ≤ 1.2 KB. |
| 6 | Fuseyard soak | 60 + 12 bot rounds in ≤ 6 s replace P§15.1's "1,000 matches in 5 s", which is about 100× too fast (F§12). |
| 7 | Bench scenario length | Steady scenarios run 25 s (5 s settle plus 20 s of measurement), and the collapse scenario 45 s, for every game. B and S asked for 45 s each, F for 25 s. |
| 8 | Ghost timing | "At once on away" becomes "at the first safe tick, after at most 45 ticks" (the danger lock, F§1.7). |
| 9 | Away limit | Per game: Fuseyard 60 s per episode and 90 s per match; Bellwick 600 s. |
| 10 | Canvas | Fuseyard's logical size is 240 × 224 (it has a HUD strip). `runtime/canvas.ts` gains a `pixelated` CSS-upscale mode, with a DPR cap of 3 for the blit fallback. |
| 11 | Leaderboards | Boards read `arcade_stats` counters (Lamplight weekly net, Glimmerhall best win), never ledger deny-lists (L§19.9, S§19.5). |
| 12 | Poker bot timing | Think times follow L§13 (700–2,200 ms; Trio 400–1,000 ms; offline fast mode 150 ms). Server Monte Carlo is ≤ 2 ms per decision, in slices of ≤ 200 trials. |
| 13 | Hidden spectators | Generic `arcade:away` / `arcade:back` hold the slot for 60 s. Glimmerhall keeps `glimmer:away`, because leaving the hall feed is hall-specific. Both share one server helper. |
| 14 | Low-rate polling | Gamepad polls on static screens (F§8.4) and in Glimmerhall use `lib/frames` low-rate mode: when every subscriber asks for ≤ 15 fps, it schedules with `setTimeout` plus one rAF. Lamplight polls inside its existing 10 Hz turn-ring timer. |
| 15 | Self-exclusion storage | Migration 14 also creates `arcade_prefs` (hidden flag, per-game toggles, re-enable time). The platform's table list had no home for it. |
| 16 | System txns | Use actor `'system'`, not NULL, because SQLite `UNIQUE` treats NULLs as distinct (L§19.8). |
| 17 | Ledger retention | By kind: `spin` and `feature` rows fold after 7 days, and their txn rows are then deleted. All other kinds fold after 90 days (S§19.6). |
| 18 | Wallet helpers | `transfer()` gains a `min` guard, because spin legs are net. The account fan-out gains `except`, plus a 2 s trailing coalesce for `arcade:wallet` (S§19.4, S§19.8). |
| 19 | HANDOVER and replay | Bodies are opaque per game: Fuseyard sends its canonical dump plus records; Bellwick sends SaveV1 plus hero placement; poker sends nothing. |
| 20 | Version and budget constants | They live in game-owned `core/<id>/version.ts` and `core/<id>/budget.ts`. P's `core/version.ts` and `core/net/budget.ts` only re-export them, so a SIM bump never touches a P file. |
| 21 | `voice:link` | Rides the existing `voice:signal` relay as `data: {link: {constrained}}`. The server already relays opaque `data` inside the channel. Old shells ignore it, because their `onSignal` acts only on `sdp` and `candidate`. |
| 22 | Mic meter demand | `micLevel` is gated through the signal's `watched` / `unwatched` options (@preact/signals-core 1.14.4), so the idle fix needs no edit to the voice settings modal. |
| 23 | Lobby options | One generic form, driven by each game's `meta.ts` (`choice`, `toggle`, `saveSlot` fields). No game code enters the main bundle. |
| 24 | Join and host rules | `MatchGameDef` fields: Fuseyard queues late joiners to the next round and passes the host role to the lowest seat; Bellwick allows drop-in and passes it to the longest-present hero. |
| 25 | Scheduler | Runs only while some match is not `idle`, or some recipient is parked as `yield` or `stalled` (those need the 1 Hz BEAT). |

---

## 2. Work packages and file ownership

### 2.1 Packages, order and branches

| Pkg | Scope | Size | May start | Must merge after | Branch |
|---|---|---|---|---|---|
| P0a | Cellular voice cap (P§2.1) | S | now | — | `arcade/voice-cap` |
| P0b | Window visibility and attention IPC (P§2.2, L§19.5) | S | now | — | `arcade/window-visibility` |
| P0c | One frame scheduler, with low-rate mode (P§2.3, S§19.10) | XS | now | — | `arcade/frames` |
| P0d | Idle main-thread cost (P§16) | S–M | now | — | `arcade/idle-cost` |
| P | Platform (§2.4) | L | now, coding against the P0 signatures in §2.6.1 | P0b, P0c (P0a before release) | `arcade/platform` |
| G3 | Fuseyard | M | at tag `arcade-p-m1` | P | `arcade/fuseyard` |
| G1 | Lamplight Hold'em | L | at `arcade-p-m1` | P | `arcade/lamplight` |
| G2 | Glimmerhall | M | at `arcade-p-m1` | P | `arcade/glimmerhall` |
| G4 | Bellwick | L | at `arcade-p-m1` | P | `arcade/bellwick` |

```
P0a P0b P0c P0d ─────────────────────────────► R0
P ── M1 (interfaces + offline runtime, tag arcade-p-m1) ── M2 (online) ── M3 (ship) ─┐
        ├── G3 Fuseyard   offline → online on M2 ──────────────────────────────────┴─► R1
        ├── G1 Lamplight  offline → online on M2 ───────────────────┐
        ├── G2 Glimmerhall offline → online on M2 ──────────────────┴──────────────► R2
        └── G4 Bellwick   Solo Tale → Party Tale on M2 ─────────────────────────────► R3
```

Games build offline-first against P-M1: engine, bots, rendering, input, sound and LocalHost. Each game rebases onto `arcade-p-m2` for its online parts. Because the files are disjoint (§2.2), those rebases are mechanical.

### 2.2 Ownership rules

1. **One owner per file.** Every file has exactly one owning package at a time, and no two packages edit the same file in parallel.
2. **Handover stubs.** P creates every file a game later owns:
   - the server registry entries;
   - `meta.ts` and `index.ts` for each game chunk;
   - `core/<id>/version.ts` and `core/<id>/budget.ts`.

   Ownership of each stub passes to its game at tag `arcade-p-m1`. Because of the stubs, P's shared lists never change when a game lands.
3. **Shared lists are pre-filled by P from the specs:**
   - limiter kinds, admin settings keys and limits, and txn kinds;
   - migration 14;
   - Vite chunk groups and bundle budgets;
   - purity-test tokens, including F§2.4's extras;
   - the naming hashes and the Caddy path;
   - the docs index and the server README event table.
4. **Discovery by directory, not by registry.** Test files, soak entries and bench plugins are found by path (`server/test/arcade/<id>/**`, `ops/bench/games/<id>.mjs`), so adding one never edits a shared file.
5. **No game edits a P file.** A game that needs a platform change opens a small `arcade/platform-<topic>` PR, which merges first, and the game rebases. Every request in the four specs is already folded into P (§2.7), so none are expected.
6. **Interface freeze.** The signatures in §2.6 freeze at P-M1. Any change after that is a platform PR with a one-line note in `docs/arcade/platform.md`.

### 2.3 Phase 0 packages

| Pkg | Owns (edit or new) | Must not touch |
|---|---|---|
| P0a voice cap | new `client/src/services/voice/linkConstraint.ts` (+ test); `client/src/services/voice/VoiceService.ts` (+ `VoiceService.test.ts`); `client/src/features/voice/voiceManager.ts` (link signal, per-peer cap, and the switch to `appState` at :709 once P0b has merged); `client/src/features/voice/AudioSettingsModal.tsx` ("Data-saver voice"); `client/src/state/settings.ts` (the preference field) | anything on the server: no change is needed (§1.3 #21) |
| P0b visibility | `desktop/main.js`, `desktop/preload.js` (`window:visibility`, `requestAttention`); `client/src/services/native/desktop.ts` (typings); new `client/src/services/native/appVisibility.ts` and `appState.ts` (+ tests); `client/src/services/native/capacitorApp.ts`; `client/src/services/visibilityHeartbeat.ts` (+ test) | `voiceManager.ts` (P0a does the swap) |
| P0c frames | new `client/src/lib/frames.ts` (+ test, low-rate mode, dev `window.__frames`); `client/src/features/chat/Composer.tsx` (three rAF calls become `frames.once`) | — |
| P0d idle cost | `client/src/styles/app.css`; `client/src/components/Avatar.tsx`; `client/src/features/voice/VideoTile.tsx`; `client/src/features/stream/HlsPlayer.tsx`; `client/src/features/chat/MessageList.tsx`; `client/src/features/search/SearchPanel.tsx`; `client/src/app/layout/MainArea.tsx`; `client/src/services/voice/PeerAudioManager.ts` (+ test); `client/src/services/voice/AudioService.ts`; `client/src/state/voice.ts` (`micLevel` watched / unwatched); new `client/src/test/idleAnimations.test.ts`; new dev-only `client/src/lib/devTimerProbe.ts` | `Sidebar.tsx`, `ConnectionBanner.tsx`, `ChannelList.tsx`, `UsageSection.tsx` (fix those in CSS only, or hand the fix to P); `voiceManager.ts` and `AudioSettingsModal.tsx` (P0a) |

The old game engine's rAF calls go away with P's deletion, so after P0c and P, `lib/frames.ts` is the only `requestAnimationFrame` user.

### 2.4 Package P: platform

P is the largest package. It ships through three internal milestones:

| Milestone | Contents | Unblocks |
|---|---|---|
| **P-M1** (tag `arcade-p-m1`) | Removal of the old games (all of P§14); `core/` scaffolding and the purity test; every interface file in §2.6 in its final form; registries and handover stubs; migration 14; the client runtime (loop, canvas, input, audio, sprites, font, visibility, store, practice wallet, wake lock, attention); `createLocalMatchHost` and `createLocalTableHost`; the offline shell (Arcade sheet with "Solo vs bots", overlay, offline entry points, catalogue, generic lobby form); `legacy.ts`; the docs skeleton | all offline game work |
| **P-M2** (tag `arcade-p-m2`) | Lane, tickets, hub, sender and pacer, scheduler, watchdog; wallet, stats, results, boards, saves, prefs and the daily job; the table-lane paced emitter, `arcadeHandle` and limiters; settings and Admin › Arcade; remote hosts, `laneClient` and the chat-first guard; lobby, activity and invite UI; the Caddy route and Dockerfiles; the test harness (lossy link, delta fuzz, probe runtime, arcade test server); the bench with a probe game | online game work |
| **P-M3** | Docs, the READMEs, landing page and og image, the naming scan, the bundle check, full verification, the PR | release |

**Server: new files (P)**

```
server/src/arcade/index.ts lane.ts tickets.ts hub.ts sender.ts scheduler.ts watchdog.ts clock.ts
server/src/arcade/wallet.ts stats.ts saves.ts prefs.ts maintenance.ts handlers.ts settings.ts legacy.ts games.ts
server/src/arcade/rooms/types.ts rooms/wrap.ts tables/types.ts
server/src/arcade/core/tsconfig.json version.ts bytes.ts rng.ts hash.ts
server/src/arcade/core/net/lane.ts events.ts match.ts pacer.ts clock.ts interp.ts budget.ts
server/test/arcade/*.test.ts                      # platform suites only (top level of the folder)
server/test/arcade/harness/**                     # arcade test server, lane/table clients, lossyLink, deltaFuzz, probe runtime, withWallCap
server/test/arcade/soak.mts                       # on-demand runner; discovers server/test/arcade/<id>/soak.mts
server/test/naming.test.ts
```

**Handover stubs that P creates and the games then own**

| Stub | Owner from P-M1 |
|---|---|
| `server/src/arcade/rooms/fuseyard.ts`, `server/src/arcade/core/fuseyard/{version,budget}.ts`, `client/src/arcade/fuseyard/{meta,index}.ts` | G3 |
| `server/src/arcade/rooms/bellwick.ts`, `server/src/arcade/core/bellwick/{version,budget}.ts`, `client/src/arcade/bellwick/{meta,index}.ts` | G4 |
| `server/src/arcade/tables/lamplight.ts`, `server/src/arcade/core/lamplight/{version,budget}.ts`, `client/src/arcade/lamplight/{meta,index}.ts` | G1 |
| `server/src/arcade/halls/glimmer.ts`, `server/src/arcade/core/glimmer/{version,budget}.ts`, `client/src/arcade/glimmer/{meta,index}.ts` | G2 |

What the stubs contain:
- **Server stubs:** `export default null`. The registry skips a null game, and `/api/config` then reports it as unavailable.
- **Client stubs:** `meta.ready = {offline: false, online: false}`, so the shell hides the tile. The chunk exports a "coming soon" module.
- **Constant stubs:** the spec numbers from §2.6.8.

**Server: edited by P**

| Area | Files |
|---|---|
| Entry and lifecycle | `server/src/index.ts` (the Arcade replaces `minigames` in the stoppables); `server/src/shutdown.ts` (`arcade.onRestarting()`) |
| Context and types | `server/src/context.ts` (drop `leaderboard`); `server/src/types.ts` |
| Socket layer | `server/src/socket/index.ts` (`destroyUpgrade: false`, `createArcade`); `socket/context.ts` (limiter kinds, `refusal: 'arcade'`); `socket/lifecycle.ts`; `socket/handlers/auth.ts`; `socket/handlers/voice.ts` (removal only) |
| Services | `server/src/services/presence.ts`; `services/usage.ts` (the "Arcade egress" counter) |
| HTTP and database | `server/src/http/routes/config.ts` (`arcade` public config); `server/src/db/migrations.ts` (migration 14) |
| Packaging | `server/package.json` and `package-lock.json` (`ws ~8.21.3`, `@types/ws`, `typecheck`, `test:soak`); `server/tsconfig.json` (drop `allowJs`, `checkJs` and the `.js` include); `server/Dockerfile` (drop both `COPY assets` lines) |
| Docs and tests | `server/README.md`; `server/test/search.test.ts`; `server/test/helpers.ts` |

**Server: deleted by P.** `server/src/minigames/` and `server/assets/` (whole directories), `server/src/socket/handlers/minigame.ts`, `server/src/services/leaderboard.ts`.

**Client: new files (P)**

```
client/src/features/arcade/  ArcadeButton.tsx ArcadeSheet.tsx ArcadeOverlay.tsx GameStage.tsx LobbyChip.tsx InviteChip.tsx
                             LobbyForm.tsx WalletPill.tsx BoardsPanel.tsx ArcadePrefs.tsx state.ts api.ts bindings.ts (+ tests)
client/src/features/admin/ArcadeSection.tsx
client/src/arcade/catalog.ts
client/src/arcade/runtime/   types.ts loop.ts canvas.ts audio.ts sprites.ts font.ts visibility.ts store.ts practiceWallet.ts
                             wakeLock.ts attention.ts chatFirst.ts input/{keyboard,touch,gamepad,map,index}.ts
                             net/{laneClient,remoteHost,localHost}.ts (+ tests)
client/scripts/check-bundle.mjs
```

**Client: edited by P**

| Area | Files |
|---|---|
| Voice and channels | `client/src/features/voice/VoicePage.tsx`; `features/voice/VoiceDock.tsx`; `features/channels/ChannelList.tsx` (the badge comes from `arcadeActivity`); `features/channels/CreateChannelModal.tsx` (hint text) |
| Auth and account | `features/auth/AuthScreen.tsx` ("Play offline"); `features/auth/ProfileModal.tsx` ("Hide Arcade" and the per-game toggles) |
| Admin | `features/admin/AdminModal.tsx`; `features/admin/UsageSection.tsx` |
| App shell | `client/src/app/App.tsx` (overlay mount outside the auth gate); `app/ConnectionBanner.tsx` ("Play offline"); `app/layout/Sidebar.tsx` (the Arcade button next to Clips) |
| State | `client/src/state/misc.ts`; `state/ui.ts` |
| Socket layer and types | `client/src/services/socket/bindings.ts`, `api.ts`, `client.ts` (the `ackRtt()` ring); `client/src/types/protocol.ts` |
| Build config | `client/tsconfig.json`; `vite.config.js` (alias, `fs.allow`, `/arcade/ws` proxy, chunk groups); `vitest.config.ts`; `client/package.json` (`build` gains `node scripts/check-bundle.mjs`) |
| Marketing | `client/scripts/brand-assets.py`; `client/public/landing.html`; `client/public/og-image.png`; `client/README.md` |

**Client: deleted by P.** `client/src/features/minigames/`.

**Ops and docs (P).** `ops/caddy/Dockerfile` (copies `server/src/arcade/core`); `ops/caddy/Caddyfile:29` (adds `/arcade/ws`); `ops/README.md`; `ops/gcp/config.sh`; new `ops/bench/arcade-netbench.mjs`, `ops/bench/lib/**` (shaper, CDP driver, chat prober, report) and `ops/bench/games/probe.mjs`; new `ops/scripts/name-hashes.mjs`; `README.md`; `.github/copilot-instructions.md`; `docs/arcade/platform.md`; `docs/arcade/README.md` (index).

### 2.5 Game packages: file ownership

Every game owns its core directory, its server runtime files, its test directory, its client chunk, its bench plugin and its doc. Nothing else.

| Pkg | Server (inside `server/src/arcade/`) | Tests | Client | Ops and docs |
|---|---|---|---|---|
| G1 Lamplight | `core/lamplight/**` (cards, evaluate, engine, views, schedule, payouts, trio, proof, bots, ranks169, ranges, settings schema, version, budget); `tables/lamplight.ts` (def), `tables/cup.ts`, `tables/trio.ts`; new `server/scripts/gen-lamplight-ranks.mjs` | `server/test/arcade/lamplight/**` (incl. `soak.mts`) | `client/src/arcade/lamplight/**` (meta, index, table, render/, bar.tsx, input, audio, proofView, local/ with `bots.worker.ts`; tests alongside) | `docs/arcade/lamplight.md` (no bench plugin: poker gets the simulator scenario only, L§18.3) |
| G2 Glimmerhall | `core/glimmer/**` (machines, evaluate, spin, feature, rtp, wire, bots, version, budget); `halls/glimmer.ts` (def), `halls/dash.ts` | `server/test/arcade/glimmer/**` | `client/src/arcade/glimmer/**` (meta, index, hall, reels, effects, art/, sounds, auto, paytable, hosts/{remote,local}) | `ops/bench/games/glimmer.mjs`, `docs/arcade/glimmerhall.md` |
| G3 Fuseyard | `core/fuseyard/**` (rules, arenas, sim, danger, bots, view, codec, replay, runtime, version, budget); `rooms/fuseyard.ts` | `server/test/arcade/fuseyard/**` | `client/src/arcade/fuseyard/**` (meta, index, render, atlas, predict, controls, menus, sound) | `ops/bench/games/fuseyard.mjs`, `docs/arcade/fuseyard.md` |
| G4 Bellwick | `core/bellwick/**` (rules, content/*, sim/*, bots/hero, codec, replay, runtime, version, budget); `rooms/bellwick.ts` | `server/test/arcade/bellwick/**` | `client/src/arcade/bellwick/**` (meta, index, online, offline, render, camera, hud, dialogue, menu, audio, controls, localSaves) | `ops/bench/games/bellwick.mjs` (Node bot-hero clients), `docs/arcade/bellwick.md` |

Rules for all four:
- **Golden replays** run in both Node and jsdom. Each game's jsdom copy lives in its own chunk directory, for example `client/src/arcade/fuseyard/golden.test.ts`.
- **Device storage keys** belong to their game:

  | Game | Key |
  |---|---|
  | Fuseyard | `datasetto.arcade.fuseyard.stats.v1` |
  | Bellwick | `datasetto.arcade.bellwick.saves.v1` |
  | Glimmerhall | `datasetto.arcade.glimmer.v1` |

  P owns `datasetto.arcade.prefs.v1` and `datasetto.arcade.practice.v1`.

### 2.6 P's public interfaces

These are frozen at P-M1. Everything a game imports from the platform is listed here; anything else is internal to P.

#### 2.6.1 Phase 0 interfaces (consumed by P)

```ts
// client/src/lib/frames.ts (P0c)
export interface FrameOpts { maxFps?: number; label?: string }      // ≤ 15 fps on every subscriber → setTimeout + one rAF
export const frames: {
  add(cb: (now: number, dt: number) => void, opts?: FrameOpts): () => void;
  once(cb: (now: number) => void): void;
  readonly active: number;                                          // no rAF and no timer at all while 0
};

// client/src/services/native/appVisibility.ts (P0b)
export const appVisibility: { readonly visible: boolean; subscribe(cb: (visible: boolean) => void): () => void };
// client/src/services/native/appState.ts (P0b)
export function onAppStateChange(cb: (active: boolean) => void): () => void;   // one shared Capacitor listener
// desktop/preload.js → client/src/services/native/desktop.ts typings (P0b)
interface DesktopAPI { onWindowVisibility?(cb: (visible: boolean) => void): () => void; requestAttention?(on: boolean): void }

// client/src/services/voice/linkConstraint.ts (P0a)
export const linkConstrained: ReadonlySignal<boolean>;              // after the Auto / On / Off preference is applied
```

#### 2.6.2 Shared core (`server/src/arcade/core/`, imported in the client as `@arcade/core/*`)

```ts
// bytes.ts — little-endian
export class ByteWriter {
  constructor(capacity: number);                    // preallocated; RangeError past capacity (an encoder bug, never input)
  u8(v: number): this; i8(v: number): this; u16(v: number): this; i16(v: number): this; u32(v: number): this;
  varint(v: number): this; bytes(b: Uint8Array): this;
  readonly length: number; reset(): this;
  view(): Uint8Array;                               // no copy; valid until the next reset()
  copy(): Uint8Array;
}
export class ByteReader {
  constructor(buf: Uint8Array, offset?: number, end?: number);
  readonly ok: boolean;                             // false after any read past the end; later reads return 0
  readonly offset: number; readonly remaining: number;
  u8(): number; i8(): number; u16(): number; i16(): number; u32(): number; varint(): number;
  bytes(n: number): Uint8Array; skip(n: number): void;
}
export function seqNewer(a: number, b: number): boolean;           // u16 serial-number arithmetic
export function seqDelta(a: number, b: number): number;            // signed, in [-32768, 32767]
export function b64url(bytes: Uint8Array): string;
export function fromB64url(s: string): Uint8Array | null;

// rng.ts — no Math.random anywhere in core; seeds are injected by the host
export const MULBERRY_INC = 0x6d2b79f5;
export function mulberry32Out(s: number): number;   // the caller advances: s = (s + MULBERRY_INC) | 0, then reads mulberry32Out(s)
export function xorshift32(s: number): number;      // returns the next state, which is also the output (s ≠ 0)
export function xoshiro128ss(state: Uint32Array): number;          // 4-word state, mutated in place
export function seedXoshiro(seed: number, out?: Uint32Array): Uint32Array;
export type RandInt = (n: number) => number;                       // uniform integer in [0, n)
export function randInt(nextU32: () => number, n: number): number; // rejection sampling, no modulo bias

// hash.ts
export function fnv1a32(bytes: Uint8Array, h?: number): number;
export function fnvMix(h: number, v: number): number;

// version.ts (P) — re-exports game-owned constants
export type GameId = 'lamplight' | 'glimmer' | 'fuseyard' | 'bellwick';
export type ActionGameId = 'fuseyard' | 'bellwick';
export const PROTO = 1;
export const WIRE_GAME: { readonly fuseyard: 1; readonly bellwick: 2 };
export const CODEC: { readonly fuseyard: number; readonly bellwick: number };  // from core/<id>/version.ts
export const SIM:   { readonly fuseyard: number; readonly bellwick: number };
export const DEFS:  { readonly glimmer: number };
export const TABLE_PROTO: { readonly lamplight: number };
// core/<id>/version.ts (game-owned): export const VERSION = { codec: 1, sim: 1 } as const   (lamplight: { proto: 1 }, glimmer: { defs: 1 })
```

```ts
// net/lane.ts — envelopes of P§5.2, as-const objects (no enums)
export const C2S = { UP: 0x01, ACK: 0x02, EVT: 0x03, PING: 0x04, VIS: 0x05, RESYNC: 0x06 } as const;
export const S2C = { WELCOME: 0x80, FRAME: 0x81, KEYFRAME: 0x82, BEAT: 0x83, PONG: 0x84, PHASE: 0x85, HANDOVER: 0x86, BYE: 0x8f } as const;
export const VIS = { live: 0, away: 1, yield: 2, leaving: 3 } as const;
export const PHASE = { lobby: 0, countdown: 1, running: 2, paused: 3, ending: 4, ended: 5 } as const;
export const KEY_REASON = { join: 0, resume: 1, unpark: 2, round: 3, room: 4, resync: 5 } as const;
export const CLOSE = { left: 1000, restart: 1012, away: 4000, malformed: 4400, ticket: 4401, forbidden: 4403,
  gone: 4404, helloTimeout: 4408, takenOver: 4409, update: 4426, rate: 4429 } as const;
export const DIVISORS = [2, 3, 4, 6] as const;
export type Divisor = (typeof DIVISORS)[number];
export const TICK_HZ = 30;

export interface Welcome { proto: number; game: number; codec: number; slot: number /* 0xff spectator */; queued: boolean;
  tick: number /* u32 */; tickHz: number; divisor: Divisor; lastEvSeq: number; resumeToken: Uint8Array; cfg: Uint8Array }
export interface EventBlock { count: number; r: ByteReader; tick: number }
export interface FrameView { local: boolean; frameSeq: number; tick: number; ackUp: number; divisor: Divisor | 1;
  lagging: boolean; snapshot: ByteReader | null; events: EventBlock | null }
export interface KeyframeView { frameSeq: number; tick: number; ackUp: number; reason: number; body: ByteReader }
export interface PhaseView { phase: number; reason: number; body: ByteReader }
// Views and their readers are valid only during the callback that receives them.

export type ClientMsg =
  | { t: 'up'; upSeq: number; ackFrame: number; ackDelayMs: number; payload: Uint8Array }
  | { t: 'ack'; ackFrame: number; ackDelayMs: number } | { t: 'evt'; evSeq: number; payload: Uint8Array }
  | { t: 'ping'; clientMs: number } | { t: 'vis'; state: number } | { t: 'resync'; reason: number };
export function readClient(msg: Uint8Array): ClientMsg | null;     // null on any malformed frame, never throws
export function readServer(msg: Uint8Array): ServerMsg | null;     // ServerMsg mirrors the S2C table
// plus one write* function per message: writeUp, writeAck, writeEvt, writePing, writeVis, writeResync,
// writeWelcome, writeFrame, writeKeyframe, writeBeat, writePong, writePhase, writeHandover, writeBye

// net/events.ts — platform event kinds inside every FRAME event block
export const PEV = { SeatState: 0xf0, Notice: 0xf1, At: 0xf2 } as const;   // At: u8 back = events below happened at frame.tick − back
export type PlatformEvent = { k: 'seat'; slot: number; state: 0 | 1 | 2 | 3 } | { k: 'notice'; code: number };
/** Walks a block. `game` returns false for an unknown kind or bad length; the walk then stops and returns false (client sends RESYNC 1). */
export function forEachEvent(block: EventBlock,
  game: (kind: number, r: ByteReader, tick: number) => boolean,
  platform: (e: PlatformEvent, tick: number) => void): boolean;
```

```ts
// net/match.ts — the pure match runtime that each action game implements in core/<id>/runtime.ts
export interface RecipientView { slot: number /* 0xff spectator */; view: number /* routing key: Bellwick room id, else 0 */ }
export interface EventChunk { bytes: Uint8Array; count: number }   // one tick, game wire format, no At marks
export type SeatCmd = 'live' | 'ghost' | 'bot' | 'left' | 'reclaim';
export interface MatchResult { mode: string; humans: number; summary: unknown;
  players: readonly { slot: number; place: number | null; score: number | null }[];
  stats: readonly { slot: number; stat: string; op: 'add' | 'max'; value: number }[] }
export type HostEvent =
  | { t: 'phase'; phase: number; reason: number; body: Uint8Array }        // sent after this tick's events, in order
  | { t: 'seat'; slot: number; state: 'live' | 'ghost' | 'bot' | 'left' }   // a change actually applied (ghost after its danger lock)
  | { t: 'rekey'; slot: number; reason: 4 | 5; view: number }              // drop pending events, send a KEYFRAME for `view`
  | { t: 'roundStart' }                                                     // queued joiners and reclaims may take seats now
  | { t: 'persist'; data: Uint8Array }                                      // Bellwick autosave (SaveV1)
  | { t: 'end'; reason: 'done' | 'idle' | 'host'; result: MatchResult | null };
export interface CoreMatch {
  readonly idle: boolean;                         // true → the scheduler may skip this match
  readonly tick: number;
  step(): void;                                   // one 30 Hz tick, bounded work, no allocation
  onUp(slot: number, payload: Uint8Array): void;  // malformed → dropped silently
  onEvent(slot: number, payload: Uint8Array): void;   // evSeq is already deduplicated by the platform
  ackUp(slot: number): number;
  setSeat(slot: number, cmd: SeatCmd): void;      // 'ghost' is a request; a 'seat' host event confirms it
  setRtt(slot: number, rttMs: number): void;      // dodge grace is read at round start
  welcomeCfg(): Uint8Array;
  snapshotFor(r: RecipientView): Uint8Array | null;   // null: unchanged or frozen; the sender then sends nothing
  keyframeFor(r: RecipientView): Uint8Array;          // public view only, never hidden state
  takeEvents(r: RecipientView): EventChunk | null;    // this tick's events visible to r
  takeHostEvents(): readonly HostEvent[];             // drained after every step()
  dump(): Uint8Array;                                 // canonical full state incl. hidden (hash, HANDOVER source)
}
```

```ts
// net/pacer.ts — pure, clock injected; used by server/src/arcade/sender.ts and by the lossy-link simulator
export type ParkReason = 'away' | 'yield' | 'stalled' | 'overflow';
export interface PacerConfig { budget: GameBudget; defaultDivisor: Divisor; stallMs: 2500 }
export interface Pacer {
  readonly divisor: Divisor; readonly minRttMs: number; readonly rttMs: number;
  readonly inflight: number; readonly inflightCap: number; readonly park: ParkReason | null;
  slotDue(tick: number): boolean;
  admit(nowMs: number, wireBytes: number, bufferedAmount: number): boolean;   // bucket ∧ inflight ∧ bufferedAmount < 2048
  sent(nowMs: number, frameSeq: number, wireBytes: number): void;
  acked(nowMs: number, ackFrame: number, ackDelayMs: number): void;
  upProgress(nowMs: number): void;
  setPark(reason: ParkReason | null): void;
  poll(nowMs: number): 'none' | 'stalled' | 'stepDown' | 'stepUp';
}
export function createPacer(cfg: PacerConfig, nowMs: number): Pacer;

// net/clock.ts and net/interp.ts — client use; floats allowed (they are not sims)
export function createTickClock(): { onPong(sentMs: number, nowMs: number, serverTick: number, phaseUs: number): void;
  serverTickAt(nowMs: number): number; readonly rttMs: number; readonly jitterP90Ms: number; readonly ready: boolean };
export function interpDelayMs(divisor: Divisor | 1, jitterP90Ms: number): number;   // clamp(2 × interval + jitter, 100, 300); 0 when local
export function createTickRing(capacity: number): { push(tick: number): number /* slot index */;
  bracket(renderTick: number): { a: number; b: number; t: number; mode: 'interp' | 'extrap' | 'hold' } | null };
```

#### 2.6.3 Server: action games (`server/src/arcade/rooms/types.ts`, `rooms/wrap.ts`)

```ts
export interface MatchRuntime extends CoreMatch {
  readonly game: ActionGameId; readonly id: string;
  handover(): Uint8Array;            // HANDOVER body (opaque per game)
  replay(): Uint8Array;              // ≤ 8 KB deflated, for watchdog dumps
  dispose(): void;
}
export interface SeatInit { slot: number; accountId: string | null; bot: boolean; botLevel: number }
export interface MatchCreateCtx {
  id: string; channelId: string; cfg: unknown; seed: number; seats: readonly SeatInit[];
  save: { ownerId: string; slot: number; data: Uint8Array | null } | null;   // Bellwick
  log: Logger;
}
export interface MatchGameDef {
  readonly game: ActionGameId; readonly wireId: 1 | 2;
  readonly seats: { min: number; max: 4 }; readonly spectators: number;        // Fuseyard 4, Bellwick 0
  readonly join: 'nextRound' | 'dropIn'; readonly host: 'lowestSeat' | 'longestPresent';
  readonly grace: { episodeMs: number; matchMs: number | null; awayLimitMs: number; after: 'bot' | 'leave' };
  readonly idle: { noHumanMs: number; noInputMs: number };                      // Fuseyard 30 s / 120 s, Bellwick 60 s / 300 s
  readonly sender: { skipUnchanged: boolean; budget: GameBudget };
  readonly serverLimit: number | null;                                           // Bellwick 3
  readonly botFill: boolean;
  readonly cfgSchema: ZodType<unknown>;
  create(ctx: MatchCreateCtx): MatchRuntime;
  persist(e: Extract<HostEvent, { t: 'persist' | 'end' }>, api: PersistApi): void;   // runs inside one db transaction
  summarizeSave?(data: Uint8Array): SaveSummary;                                 // ≤ 400 B list rows
  readonly boards?: readonly BoardDef[];
}
export function wrapCore(game: ActionGameId, id: string, core: CoreMatch,
  extra: { handover(): Uint8Array; replay(): Uint8Array; dispose?(): void }): MatchRuntime;

// server/src/arcade/games.ts (P) — static registry over the handover stubs
export const MATCH_GAMES: readonly (MatchGameDef | null)[];   // [rooms/fuseyard.ts, rooms/bellwick.ts]
export const TABLE_GAMES: readonly (TableGameDef | null)[];   // [tables/lamplight.ts, halls/glimmer.ts]
```

**What the platform does around `MatchRuntime`.**
- **Lane and tickets.** HELLO, tickets and resume tokens (P§4.1).
- **Sending.** Per-recipient pacing, the ladder and parking (P§6). The sender inserts `At` marks when it merges several ticks into one FRAME.
- **Seats.** The seat grace and away limits from the def, and takeover (4409).
- **Joining and hosting.** The late-join queue, reclaim, and re-sending WELCOME on a role change (F§13.3).
- **Events.** `evSeq` deduplication.
- **Lifecycle.** The idle reapers, the restart and overload flow (PHASE 4, then HANDOVER, then 1012), the watchdog and replay dumps, and the egress and event-loop degrade ladders.

#### 2.6.4 Server: table games, wallet, persistence (`server/src/arcade/tables/types.ts`, `wallet.ts`, `stats.ts`, `saves.ts`)

```ts
export interface CallerCtx { accountId: string; socketId: string; voiceChannelId: string | null }
export interface EmitOpts {
  queue: 'lamplight' | 'glimmer';                     // the per-game queue in the socket's paced emitter (3 KB/s, 6 KB depth)
  coalesce?: string;                                  // newest-wins key (emotes, feed, wallet)
  stamp?(data: unknown, sentAtMs: number): unknown;   // send-time fields, e.g. ms left from an absolute deadline
  onSent?(waitedMs: number): void;                    // queue-wait report (Lamplight turn credit)
  sub?: { rateBps: number; depth: number };           // per-game sub-bucket (Glimmerhall pushes: 200 B/s, 800 B)
}
export interface QueuePolicy { maxEvents: number; maxAgeMs: number;                    // Lamplight 32 / 2,000
  onOverflow(socketId: string): { ev: string; data: unknown } | null }                  // e.g. a fresh lamplight:snap
export interface TableApi {
  on<T>(event: `${'lamplight' | 'glimmer'}:${string}`,
    opts: { schema: ZodType<T>; limiter: 'arcade' | 'arcadeAct' | 'spin'; acked: boolean; voiceMember?: boolean },
    fn: (c: CallerCtx, payload: T) => unknown | Promise<unknown>): void;               // ack is the return value; refusals are quiet
  queuePolicy(queue: 'lamplight' | 'glimmer', p: QueuePolicy): void;
  emit(socketId: string, ev: string, data: unknown, opts: EmitOpts): void;              // paced; waits while the main writeBuffer is non-empty
  emitAccount(accountId: string, ev: string, data: unknown, opts: EmitOpts & { except?: string }): void;
  emitRoom(room: string, ev: string, build: (socketId: string) => unknown, opts: EmitOpts): void;   // per-socket fan-out, never io.to()
  rooms: { join(socketId: string, room: string): void; leave(socketId: string, room: string): void; size(room: string): number };
  wallet: Wallet; stats: Stats; results: Results; hub: HubApi;
  presence: { isVoiceMember(accountId: string, channelId: string): boolean; socketsOf(accountId: string): readonly string[];
    dnd(accountId: string): boolean };
  prefs: { hidden(accountId: string, game: GameId): boolean };
  ackRttMs(socketId: string): number;
  clock: Clock; log: Logger; settings(): ArcadeSettings;
}
export interface TableGameDef {
  readonly game: 'lamplight' | 'glimmer';
  readonly proto: number;                                  // public config: arcade.proto.lamplight / arcade.defs.glimmer
  readonly modes: readonly string[];                       // 'open' | 'cup' | 'trio'; 'hall' | 'dash'
  readonly cfgSchema: ZodType<unknown> | null;
  readonly settings?: { schema: ZodType<unknown>; defaults: unknown; fields: readonly SettingsField[] };   // trioTable, slotsMaxBet, …
  readonly boards?: readonly BoardDef[];
  start(api: TableApi): TableGame;
}
export type Refusal = { ok: false; code: string };
export interface TableGame {
  lobby?: {
    onCreate(c: CallerCtx, cfg: unknown): { ok: true } | Refusal;
    onJoin(c: CallerCtx, lobby: LobbyRecord, as: 'player' | 'spectator'): { ok: true } | Refusal;   // may escrow a buy-in
    onLeave(c: CallerCtx, lobby: LobbyRecord): void;
    onStart(lobby: LobbyRecord): { ok: true } | Refusal;
  };
  onAway(socketId: string, id: string): void; onBack(socketId: string, id: string, since: number): void;
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(accountId: string, socketId: string): void;
  onRestarting(): void; onBoot(): void; daily(nowMs: number): void; onDisable(): void;
  activity(channelId: string): readonly ActivityEntry[];
  stop(): void;                                            // clears every timer the game holds
}

// hub
export interface LobbyRecord { id: string; game: GameId; channelId: string; mode: string; cfg: unknown; host: string;
  seats: readonly { accountId: string | null; bot: boolean; state: number }[]; watchers: readonly string[];
  state: 'open' | 'live' | 'ended' }
export interface ActivityEntry { g: GameId; id: string; st: 'open' | 'lobby' | 'live' | 'dash'; n: number; max: number;
  w: number; x?: string /* ≤ 24 chars */; j?: { amt: number } /* 60 s after a pot win */ }
export interface HubApi {
  get(lobbyId: string): LobbyRecord | null;
  publish(lobbyId: string): void;                 // coalesced arcade:lobby, ≤ 2 Hz
  activityChanged(channelId: string): void;       // coalesced arcade:activity, ≤ 1 per 2 s per channel
  close(lobbyId: string, reason: string): void;
  bots: { take(n: number): boolean; give(n: number): void };   // server-wide poker bot cap (6)
  limits(): ArcadeLimits;
}

// wallet — transfer() is the only way chips move
export type LedgerAccount = `w:${string}` | `e:${string}` | `p:${string}` | 'house';   // escrow: e:<ref>:<accountId | bot:n>
export type TxnKind = 'grant' | 'claim' | 'buyin' | 'cashout' | 'hand' | 'prize' | 'spin' | 'feature' | 'pot_seed'
  | 'refund' | 'restart-refund' | 'admin' | 'fold';
export interface Leg { account: LedgerAccount; delta: number }
export interface TransferOpts {
  min?: Readonly<Record<string, number>>;     // e.g. { 'w:<id>': bet }: checked before the legs apply
  receipt?: string;                           // compact JSON stored in arcade_txns.result (cleared after 24 h)
}
export type Transfer =
  | { ok: true; dup: false; txnId: number; balances: ReadonlyMap<LedgerAccount, number> }
  | { ok: true; dup: true; receipt: string | null }
  | { ok: false; code: 'funds' | 'min' | 'unbalanced' };
export interface Wallet {
  transfer(kind: TxnKind, ref: string, actor: string /* accountId | 'system' */, idem: string | null,
    legs: readonly Leg[], opts?: TransferOpts): Transfer;
  tx<T>(fn: () => T): T;                      // one db transaction around several transfers and the game's own rows
  view(accountId: string): { bal: number; esc: number; claim: boolean };   // grants 20,000 on the first read
  claim(accountId: string): { ok: boolean; bal: number; got: number };     // max(2000, 10000 − (bal + esc)), once per UTC day
  escrowRows(refPrefix: string): readonly { ref: string; account: string; amount: number; kind: 'stack' | 'buyin' }[];
  refund(refPrefix: string, kind: 'refund' | 'restart-refund'): number;   // bot escrow goes back to house
  pot(scope: string): { pool: number; carryE4: number; last: { accountId: string; amount: number; at: number } | null };
  addCarry(scope: string, e4: number): number;    // whole chips to move house → p:<scope> in the same txn
  potWon(scope: string, accountId: string, amount: number, atMs: number): void;
  receipt(actor: string, idem: string): string | null;
}
export interface Stats { add(accountId: string, game: GameId, stat: string, delta: number): void;
  max(accountId: string, game: GameId, stat: string, value: number): void; get(accountId: string, game: GameId, stat: string): number }
export interface Results { record(r: { game: GameId; mode: string; channelId: string | null; humans: number;
  startedAt: number; endedAt: number; summary: unknown },
  players: readonly { accountId: string; place: number | null; score: number | null; chipsDelta: number }[]): number }
export interface BoardDef { id: string; label: string;
  query(db: Database, limit: number): readonly { accountId: string; value: number; label?: string }[] }   // 60 s cache
export interface Saves {
  list(ownerId: string, game: GameId): readonly SaveRow[]; get(ownerId: string, game: GameId, slot: 0 | 1 | 2): SaveRow | null;
  put(ownerId: string, game: GameId, slot: 0 | 1 | 2, version: number, data: Uint8Array, members: readonly string[]): void;
  remove(ownerId: string, game: GameId, slot: 0 | 1 | 2): 'ok' | 'in-use'; inUse(ownerId: string, game: GameId, slot: 0 | 1 | 2): boolean;
}
export interface PersistApi { wallet: Wallet; stats: Stats; results: Results; saves: Saves; accountOf(slot: number): string | null }

// server/src/arcade/index.ts
export function createArcade(ctx: AppContext, http: HttpServer, io: Server, opts?: { clock?: Clock }): Arcade;
export interface Arcade {
  stop(): Promise<void>; onRestarting(): Promise<void>;
  onAuthenticated(sctx: SocketContext): void;      // arcade:activity:all, arcade:wallet
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(sctx: SocketContext): void;
  publicConfig(): { enabled: boolean; games: Record<GameId, boolean>; proto: { lamplight: number }; defs: { glimmer: number } };
}
export interface Clock { now(): number; hr(): bigint; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
```

**Platform table-lane events** are those of P§5.4, plus four additions:
- `arcade:away` and `arcade:back`;
- `ActivitySummary.x` and `.j`;
- `arcade:saves:delete`, which answers `in-use` while a session runs from that slot.

`arcade:saves:import` is reserved for Bellwick's M7, and P implements it at M2.

**Migration 14** is P§11.1 plus `arcade_prefs (account_id PK → accounts ON DELETE CASCADE, hidden INTEGER, games TEXT, reenable_at INTEGER, updated_at INTEGER)`.

#### 2.6.5 Server: test harness and bench plugins (P)

```ts
// server/test/arcade/harness/index.ts
export function startArcadeServer(o?: { clock?: FakeClock; settings?: Partial<ArcadeSettings> }): Promise<ArcadeTestServer>;
export interface ArcadeTestServer { url: string; ctx: AppContext; clock: FakeClock; close(): Promise<void>;
  account(name?: string): Promise<TestAccount> }      // ctx.accounts.register + ctx.sessions.create (the auth limiter is per process)
export interface TestAccount { id: string; socket(): Promise<TestSocket>; joinVoice(channelId: string): Promise<void>;
  lane(ticketOrResume: string): Promise<TestLane> }
export interface TestSocket { request<T>(ev: string, data: unknown): Promise<T>; received(ev?: string): readonly unknown[]; close(): void }
export interface TestLane { sendUp(p: Uint8Array): void; sendEvt(p: Uint8Array): void; sendVis(s: number): void;
  next(type?: number, timeoutMs?: number): Promise<ServerMsg>; readonly received: readonly ServerMsg[]; close(code?: number): void }
export function lossyLink(p: LinkProfile): LinkSim;    // virtual time; 64 KB queues; head-of-line loss as RTO = max(200 ms, 2 × RTT)
export function runScenario(s: Scenario): ScenarioResult;          // each ≤ 1 s wall; aborts once the result is certain
export function deltaFuzz(o: { create(): MatchRuntime; schedules: number; seed: number;
  decode(k: Uint8Array, events: readonly Uint8Array[]): unknown; equal(client: unknown, server: unknown): boolean }): void;
export function probeRuntime(o: { snapshotBytes: number; eventBytesPerTick: number; players: number }): MatchRuntime;
export function withWallCap<T>(ms: number, fn: (progress: (n: number) => void) => T): T;   // fails with progress when over the cap
```

```js
// ops/bench/games/<id>.mjs (game-owned; found by the netbench by file name)
export const scenarios = ['3g', '3g-loss', 'collapse'];            // whatever subset applies
export async function startBots(server, n) { /* Node clients: socket.io-client + ws; returns { stop() } */ }
export async function enter(page, lobby) { /* drive the shaped Chrome into the game over CDP */ }
```

#### 2.6.6 Client: runtime and hosts (`client/src/arcade/runtime/`)

```ts
// types.ts
export type AnyHost = MatchHost | TableHost;
export interface GameModule<H extends AnyHost = AnyHost> { mount(el: HTMLElement, host: H, opts: MountOpts): GameHandle }
export interface GameHandle { pause(): void; resume(): void; unmount(): void; back?(): boolean /* true = consumed */ }
export interface MountOpts {
  readonly mode: 'local' | 'remote'; readonly lobby: LobbyView | null;
  readonly me: { accountId: string | null; slot: number | null };
  readonly prefs: ArcadePrefs; readonly ptt: KeyBinding | null; readonly reducedMotion: boolean; readonly coarse: boolean;
  readonly shell: ShellBridge;
}
export interface ShellBridge {
  status(s: 'connecting' | 'live' | 'lagging' | 'paused' | 'away' | 'ended'): void;   // coalesced into arcadeSession
  attention(on: boolean): void;        // arcadeSession.attention + tab-title prefix + desktopAPI.requestAttention
  wakeLock(on: boolean): void; minimize(): void; leave(): void;
  names(accountIds: readonly string[]): readonly string[];            // presence lookup on demand, never per tick
  readonly practice: PracticeWallet;
}
export interface SeatInfo { slot: number; accountId: string | null; name: string; bot: boolean; joinOrder: number; extra: number }
export interface MatchHost {
  readonly mode: 'local' | 'remote';
  sendUp(payload: Uint8Array): void;           // newest wins; skipped while ws.bufferedAmount > 512 B
  sendEvent(payload: Uint8Array): void;        // reliable; evSeq assigned and resent after a resume
  onWelcome(cb: (w: Welcome) => void): void; onFrame(cb: (f: FrameView) => void): void;
  onKeyframe(cb: (k: KeyframeView) => void): void; onPhase(cb: (p: PhaseView) => void): void;
  onHandover(cb: (body: Uint8Array, simVersion: number) => void): void;
  onSeats(cb: (seats: readonly SeatInfo[]) => void): () => void;
  onClosed(cb: (code: number, reason: string) => void): void;
  setVisible(visible: boolean): void;          // remote: VIS; local: pause the sim and audio
  rttMs(): number; linkConstrained(): boolean; estServerTick(nowMs: number): number;
  close(): void;
}
export interface TableHost {
  readonly mode: 'local' | 'remote';
  request<T>(ev: string, data: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  on(ev: string, cb: (data: unknown) => void): () => void;
  connected(): boolean; onConnection(cb: (up: boolean) => void): () => void; ackRttMs(): number;
  setVisible(visible: boolean): void; close(): void;
}
export interface LocalTableServer {            // supplied by a table game's chunk for offline play
  request(ev: string, data: unknown): Promise<unknown>; attach(emit: (ev: string, data: unknown) => void): void;
  setVisible(visible: boolean): void; dispose(): void;
}
export interface GameChunk {                   // the default export of client/src/arcade/<id>/index.ts
  module: GameModule<any>;
  local(o: { mode: string; cfg: unknown; seed: Uint32Array; seats: readonly SeatInfo[] }): CoreMatch | LocalTableServer;
}

// net/*.ts
export function createRemoteMatchHost(a: { lobbyId: string; ticket: string; game: ActionGameId }): MatchHost;
export function createLocalMatchHost(core: CoreMatch, a: { selfSlot: number; seats: readonly SeatInfo[] }): MatchHost;  // ≤ 4 steps per frame
export function createRemoteTableHost(game: 'lamplight' | 'glimmer'): TableHost;
export function createLocalTableHost(server: LocalTableServer): TableHost;

// loop.ts — subscribes to lib/frames only while visible ∧ (animating ∨ dirty ∨ stepping)
export interface Loop { markDirty(): void; animate(on: boolean): void; setVisible(v: boolean): void; dispose(): void; readonly running: boolean }
export function createLoop(o: { draw(nowMs: number, alpha: number): void; step?: { fn(): void; maxSteps?: number }; maxFps?: 30 | 60 }): Loop;

// canvas.ts
export interface CanvasMetrics { cssW: number; cssH: number; scale: number; integer: boolean; dpr: number }
export interface StageCanvas { readonly canvas: HTMLCanvasElement; readonly ctx: CanvasRenderingContext2D;
  readonly metrics: CanvasMetrics; onResize(cb: (m: CanvasMetrics) => void): () => void; dispose(): void /* 0 × 0 */ }
export function createStageCanvas(container: HTMLElement, o: { logicalW: number; logicalH: number;
  mode: 'pixelated' | 'blit' | 'hd'; dprCap?: 2 | 3; minIntegerFill?: number /* 0.85 */ }): StageCanvas;

// input/index.ts — sampled once per tick; presses are latched between samples
export const ACT = { up: 1, down: 2, left: 4, right: 8, a: 16, b: 32, swap: 64, menu: 128 } as const;
export interface InputSample { held: number; pressed: number; stickX: number; stickY: number /* −1..1 after the dead zone */ }
export interface TouchLayout { stick: 'float' | 'dpad'; buttons: readonly { id: 'a' | 'b' | 'swap' | 'menu'; label: string; px: 40 | 56 | 76 }[];
  deadZonePx: number; radiusPx: number; vibrateMs: 0 | 10; region: 'deck' | 'overlay' }
export interface Input { sample(): InputSample; setButtonVisible(id: string, v: boolean): void; dispose(): void }
export function createInput(target: HTMLElement, o: { keys: KeyMap; ptt: KeyBinding | null; touch: TouchLayout | null; gamepad: boolean }): Input;
export function isReservedKey(e: KeyboardEvent, ptt: KeyBinding | null): boolean;  // PTT, Ctrl/Alt/Meta chords, app shortcuts, F12

// audio.ts — one context per open game; follows localDeafened and the game volume (default 40 %)
export interface GameAudio { unlock(): Promise<void>; prerender(r: Readonly<Record<string, SoundRecipe>>): Promise<void>;
  play(id: string, o?: { gain?: number; detune?: number }): void; music(seq: MusicSeq | null): void;
  suspend(): void; resume(): void; close(): Promise<void> }
export function createGameAudio(o?: { master?: number }): GameAudio;

// sprites.ts, font.ts
export function bakeAtlas(sheets: readonly SpriteSheet[], palettes: readonly Palette[]): Promise<Atlas>;   // one ImageBitmap
export function drawText(ctx: CanvasRenderingContext2D, atlas: Atlas, text: string, x: number, y: number, color: number): void;  // 5 × 7

// visibility.ts — appVisibility ∧ stage not minimized ∧ IntersectionObserver ≥ 10 %
export function watchStageVisibility(stage: HTMLElement, cb: (visible: boolean) => void): () => void;

// practiceWallet.ts, store.ts (every access in try/catch, in-memory fallback)
export interface PracticeWallet { balance(): number; debit(n: number, ref: string): boolean; credit(n: number, ref: string): void;
  escrow(ref: string, amount: number): void; release(ref: string): number; refill(minBet: number): boolean;
  onChange(cb: (bal: number) => void): () => void }
export const practiceWallet: PracticeWallet;          // datasetto.arcade.practice.v1; restores open escrow on the first read
export function readLocal<T>(key: string, parse: (v: unknown) => T | null): T | null;
export function writeLocal(key: string, value: unknown): boolean;
```

#### 2.6.7 Client: shell, catalogue, signals (`client/src/features/arcade/`, `client/src/arcade/catalog.ts`)

```ts
// client/src/arcade/<id>/meta.ts — main bundle, ≤ 300 B gzip each, game-owned after P-M1
export type OptionField = { key: string; label: string; when?: { mode: readonly string[] } } & (
  | { kind: 'choice'; choices: readonly { value: string | number; label: string }[]; default: string | number }
  | { kind: 'toggle'; default: boolean }
  | { kind: 'saveSlot' });                             // calls arcade:saves {game} and lists the slots
export interface GameMeta {
  id: GameId; name: string; tagline: string; icon: 'cards' | 'coins' | 'bomb' | 'sword';
  lane: 'action' | 'table'; ready: { offline: boolean; online: boolean };
  modes: readonly { id: string; label: string; online: boolean; offline: boolean }[];
  seats: readonly [number, number]; watch: boolean; options: readonly OptionField[];
  load(): Promise<GameChunk>;                          // () => import('./index.ts')
}
// catalog.ts (P)
export const CATALOG: readonly GameMeta[];             // the four meta.ts files, in sheet order

// state.ts (P) — written at most about once per second; a dev counter warns above 2 writes/s
export const arcadeActivity: Signal<ReadonlyMap<string /* channelId */, readonly ActivityEntry[]>>;
export const arcadeLobby: Signal<LobbyView | null>;
export const arcadeSession: Signal<{ game: GameId; id: string; role: 'player' | 'spectator'; mode: 'local' | 'remote';
  status: 'connecting' | 'live' | 'lagging' | 'paused' | 'away' | 'ended'; attention: boolean; minimized: boolean } | null>;
export const arcadeWallet: Signal<{ bal: number; esc: number; claim: boolean } | null>;
export function openArcade(o: { game?: GameId; mode: 'local' | 'remote'; channelId?: string }): void;   // overlay or stage
```

#### 2.6.8 Budget constants (per-client byte budget, `core/net/budget.ts` plus `core/<id>/budget.ts`)

All figures are wire bytes, including the P§5.1 overheads: 76 B per downlink message, 80 B per uplink message, 26 B of TCP ACK per message received, and 92 / 96 B on the table lane. The link is 3G (750 kbit/s down, 250 up, 300 ms RTT) in a 4-person call with the voice cap.

| Role | Down typical | Down worst 1 s | Up moving | Up idle | Source |
|---|---|---|---|---|---|
| Fuseyard player (d = 2) | 17.2 kbit/s | 25.1 | 14.2 (14.5 after a stall) | 6.3 | F§4 |
| Fuseyard spectator (d = 3) | 10.7 | 19 | 5.2 | — | F§4 |
| Bellwick player | 19 exploring, 22 in a fight, 28 at peak | 32 | 16.4 (12.5 when constrained) | 6.1 | B§4.8 |
| Lamplight seat | 0.5; 1.9 with 1 human + 5 bots | 24 (≤ 3 KB) | 0.13–0.44 | — | L§7.5 |
| Glimmerhall member | 1.2; 3.9 worst sustained | 18 (≤ 2.1 KB) | 0.7; 2.4 worst | — | S§11 |
| Lobby and activity | ≤ 1 | 2 | — | — | P§7.1 |
| Hidden or away | < 0.1 (WebSocket ping) | — | < 0.1 | — | P§6.2 |
| **Arcade closed** | **0** | **0** | **0** | **0** | P§7.1 |

**Ceilings** (enforced by tests; the sender logs when a 10 s window exceeds them):

| Lane | Down average | Down in any 1 s | Up |
|---|---|---|---|
| Action lane | ≤ 32 kbit/s | ≤ 40 kbit/s | ≤ 20 kbit/s |
| Table lane | ≤ 4 kbit/s | ≤ 3 KB | ≤ 2.4 kbit/s |

**Worst-case fit:** a 3G phone in the Bellwick boss room, everyone talking.

| | Down (750) | Up (250) |
|---|---|---|
| Voice, 3 capped streams | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | 4 | 3 |
| Bellwick, worst 1 s | 32 | 16.4 |
| **Total** | **184 (25 %)** | **167 (67 %)** |

Fuseyard comes to 177 / 165 kbit/s, Lamplight to 175 / 153 in its peak second, and Glimmerhall to 156 / 153.

```ts
export const OVERHEAD = { down: 76, up: 80, tcpAck: 26, tableDown: 92, tableUp: 96 } as const;
export const LANE_CEILING = { downAvgBps: 4000, downPeak1s: 5000, upAvgBps: 2500 } as const;
export const TABLE_CEILING = { downAvgBps: 500, downPeak1s: 3000, upAvgBps: 300 } as const;
export interface GameBudget { downAvg: number; downPeak1s: number; upAvg: number; keyframeMax: number;
  snapshotMax: number; frameTypMax: number; upMax: number; overflowEvents: number }
// core/fuseyard/budget.ts: { downAvg: 2200, downPeak1s: 3200, upAvg: 1800, keyframeMax: 512, snapshotMax: 22 /* 4 fighters, no slides; +6 B per sliding bomb */, frameTypMax: 256, upMax: 9, overflowEvents: 1024 }
// core/bellwick/budget.ts: { downAvg: 2750, downPeak1s: 4000, upAvg: 2050, keyframeMax: 384, snapshotMax: 91, frameTypMax: 256, upMax: 16, overflowEvents: 1024 }
// Bucket depth = keyframeMax + 10 + 76 + 4 × (frameTypMax + 76) ≥ 1,926 B, so a frame at the overflow threshold always fits.
```

### 2.7 Game-spec requests folded into P

Every "what the platform must add" item from the four specs is part of P. This table maps each one to where it lands.

| Request | Where in P |
|---|---|
| `TableHost`, `GameModule<H>`, `GameHandle.back()` (L§19.1, S§19.9) | `runtime/types.ts`, `net/{remote,local}Host.ts` |
| Paced emitter: overflow hooks, send-time stamping, queue-wait report, egress accounting, per-game sub-bucket, per-socket fan-out (L§19.2, S§19.3) | `arcade/handlers.ts`: `TableApi.emit*`, `queuePolicy` |
| `arcade:away` / `arcade:back`; `ActivitySummary.x` and `.j`; `st: 'dash'` (L§19.3–4, S§19.13) | `hub.ts`, `handlers.ts`, `ActivityEntry` |
| Attention hook and tab title; `desktopAPI.requestAttention` (L§19.5) | `runtime/attention.ts`; P0b for the desktop part |
| Wake Lock helper used by table games (L§19.6, S§19.16) | `runtime/wakeLock.ts` via `ShellBridge.wakeLock` |
| Txn kind `hand`; bot escrow back to the house; actor `'system'` (L§19.7–8) | `wallet.ts` |
| Boards from `arcade_stats` (L§19.9, S§19.5) | `stats.ts` with the game-supplied `BoardDef` |
| Event-list changes; `arcade.proto.lamplight`; `DEFS.glimmer` (L§19.10, L§19.13, S§19.2, S§19.11) | `version.ts`, `/api/config`, `auth:success` |
| Online bot economy rules: lobby refusals, bot cap (L§19.12) | `TableGame.lobby` hooks and `HubApi.bots` |
| Worker chunk budget; practice escrow; desktop Worker smoke (L§19.14–16) | `check-bundle.mjs`, `practiceWallet.ts`, §4.3 |
| `transfer()` `min` guard; retention by kind; daily vault auto-pick hook; `toAccount` except and coalescing (S§19.4, S§19.6–8) | `wallet.ts`, `maintenance.ts` calling `TableGame.daily`, `emitAccount` |
| `lib/frames` low-rate mode (S§19.10) | P0c |
| Quiet `handle()` refusals and one ack shape (S§19.12) | `socket/context.ts` `refusal: 'arcade'` |
| Settings `hallMembers`, `dashes`, `slotsMaxBet`, `bellwickSessions`; self-exclusion with 24 h re-enable (S§19.14–15, B§15.10) | `settings.ts`, `prefs.ts` (`arcade_prefs`) |
| Audio follows deafen; 10-minute no-input away rule for table games (S§19.16) | `runtime/audio.ts`; `ShellBridge` idle option |
| `At` kind, ordered PHASE, WELCOME re-sent on role change, seat queue, reclaimable seats (F§13.1–3) | `net/events.ts`, `sender.ts`, `hub.ts`, `HostEvent` |
| `ackUp`, ghost as a request, round end with ghosts (F§13.4–6) | `CoreMatch` contract (round rules are game code) |
| `skipUnchanged` with a header-only FRAME every 500 ms; interpolation delay from the divisor; `rttMs` (F§13.7–8) | `sender.ts`, `net/interp.ts`, `CoreMatch.setRtt` |
| Replay format; `pixelated` canvas mode; purity tokens; budget constants; gamepad on static screens; catalogue entry (F§13.9–16) | `replay()` opaque, `canvas.ts`, `core.purity.test.ts`, `budget.ts`, low-rate frames, `meta.ts` |
| `awayLimitMs`, rekey, null snapshot, `idle`, `onSeats`, `linkConstrained`, uplink `bufferedAmount` guard, session limit, saves API, opaque HANDOVER, bench bot client and simulator profile (B§15.1–15.14) | `MatchGameDef`, `HostEvent.rekey`, `CoreMatch`, `MatchHost`, `laneClient.ts`, `saves.ts`, harness |

---

## 3. Acceptance criteria and tests

### 3.0 Test time caps (answering the owner's complaint about 20-minute runs)

**The rules:**
- **No run exceeds 60 s.** Every automated file has a wall cap through `withWallCap` or Vitest's `testTimeout`. A test that hits its cap fails and reports how far it got. It never keeps running.
- **Stop when certain.** Statistical checks and bench scenarios abort as soon as their result is certain.
- **No soak is a PR gate.** The CI-sized soaks (Fuseyard 6 s, Glimmerhall < 2 s, Bellwick completion 3 s) are ordinary tests. The 60 s soaks run on demand.
- **Manual passes run once per wave, not per commit.** A passed bench is not re-run after unrelated changes.

| Package | Server suite (CPU time added) | Client suite | Manual, per wave |
|---|---|---|---|
| P0a–P0d | — | ≤ 2 s each | P0a: 15 s `getStats` check. P0b: ≤ 60 s desktop check. P0d: a one-time investigation of ≤ 3 min, then 3 traces of 10 s |
| P | ≤ 40 s (link scenarios ≤ 5 s, integration ≤ 15 s) | ≤ 5 s | probe bench ≤ 2.5 min, only until G3 lands; 15 s idle trace |
| G1 Lamplight | ≤ 10 s | ≤ 2 s | 3 CPU traces × 15 s; 3 screenshots in ≤ 30 s |
| G2 Glimmerhall | ≤ 10 s | ≤ 3 s | bench 25 s; 2 CPU traces × 15 s |
| G3 Fuseyard | ≤ 16 s | ≤ 2 s | bench 25 + 25 + 45 s; CDP smoke ≤ 90 s; Android ≤ 1 min |
| G4 Bellwick | ≤ 8 s | ≤ 2 s | bench 2 × 25 s; 15 s trace; shares the Android check |
| **Total** | **≈ 84 CPU-s, ≈ 30–40 s of wall time added** with Vitest's parallel workers | **≈ 16 s** | **≤ 10 min per wave** (§4.2) |

The bench script enforces `--max-wall 600` for the whole run and 60 s per scenario.

### 3.1 Phase 0

| Pkg | Acceptance criteria | Tests that prove them |
|---|---|---|
| P0a | Each detection rule trips the constrained state: cellular, `effectiveType` ≤ 3g, `saveData`, `downlink` < 2 Mbit/s, or `availableOutgoingBitrate` < 400 kbit/s for 5 s. When constrained, every audio sender gets `maxBitrate = 24000` via `setParameters`, with no renegotiation, and the next SDP carries `maxaveragebitrate=24000`. A peer that reports `link` gets a cap on that one sender only; other peers stay at 128 kbit/s. | Unit: a fake `navigator.connection` matrix, a fake stats series, and a spied `setParameters` whose `createOffer` count stays unchanged. Old-shell case: `onSignal` with `{link}` data does nothing. Manual, ≤ 15 s: two Chrome tabs with fake mics; outbound audio ≤ 30 kbit/s while constrained. |
| P0b | `window:visibility` fires on minimize, restore, hide, show and load. `appVisibility` merges document visibility, page hide and show, Capacitor `appStateChange` and the Electron IPC. The heartbeat uses it. `requestAttention(true)` flashes the frame or bounces the dock until focus. | Unit: a fake for each source gives the right boolean sequence. Desktop CDP check, ≤ 60 s: minimize → `appVisibility.visible === false` within 200 ms; restore → true; `flashFrame` is logged by the main process. |
| P0c | No rAF and no timer while `active === 0`. With `maxFps: 60` on a fake 240 Hz rAF, at most 61 callbacks/s. In low-rate mode (all subscribers ≤ 15 fps), at most `maxFps + 1` rAF calls/s. `Composer.tsx` keeps its behaviour. | Unit: fake rAF and timers (≤ 1 s). The existing Composer tests pass. |
| P0d | On the idle voice page, with nobody speaking and no skeletons: `document.getAnimations()` lists no running infinite animations; no interval of 100 ms or less exists outside a call; the main thread is < 3 % busy at native refresh and < 10 % at 4× throttle over a 10 s trace. `micLevel` gets 0 writes/s with no meter mounted, and ≤ 20/s, only on changes > 2 %, with a meter. There is one shared speaking timer at 100 ms. | jsdom: class allowlist for infinite animations; the `micLevel` watched / unwatched counter; `PeerAudioManager` uses one timer for N peers. Manual: 3 CDP traces × 10 s (idle, 4×, in a call with one fake peer). |

### 3.2 Package P

| Area | Acceptance criteria (numbers) | Test |
|---|---|---|
| Removal | No `MinigameManager`, `minigame` or `voice:game:` outside `arcade/legacy.ts` and its test. `server/Dockerfile` builds with no `assets/`. Migration 14 on a copy of a v13 DB with leaderboard rows creates every `arcade_*` table plus `arcade_prefs`, drops `leaderboard`, and leaves every other table's row count unchanged. | `removal.test.ts` (grep), `migration14.test.ts`, image build in CI |
| Old-shell stub | `voice:game:start` and `voice:game:join` get `voice:game:error` with the exact text. Other `voice:game:*` events are ignored, with no `error` emit. | integration |
| Purity | `core/**` has no `Math.random`, `Date`, `performance`, timers, `crypto`, `for…in`, `enum` or imports outside core. `sim/`, `bots/`, `sim.ts`, `danger.ts` and `bots.ts` have no `while` or `do`. Fuseyard's tokens (`new Map`, `new Set`, `Object.keys/values/entries`; `hidden` in codec, view, danger and bots) are banned. `tsc -p src/arcade/core/tsconfig.json` passes. | `core.purity.test.ts`; `npm run typecheck` |
| Envelopes | Every message round-trips. WELCOME is ≤ 64 B + cfg. 10,000 random buffers give `null` and never throw. | `lane.codec.test.ts` |
| Pacer (virtual time) | Steps down once +150 ms queueing has held 1 s as the server sees it, or after 3 slots skipped by the in-flight cap. Steps up after 3 s of calm. An idle player sending only ACKs is never `stalled` in 60 simulated seconds. A 10 s silence costs exactly 1 keyframe. A fuzz over bucket depth shows the bucket never deadlocks. | `pacer.test.ts` (≤ 1 s) |
| Delta base | 2,000 seeded schedules of skipped slots, all four park reasons, unparks, reconnects and rekeys through the real sender and the probe runtime: after every keyframe plus events, the client world equals the server's public view. `frameSeq` is consecutive. The first message after an unpark is always a KEYFRAME, so there is never a backlog. | `deltaBase.test.ts` (≤ 2 s) |
| Link simulator (probe runtime shaped like Fuseyard: 22 B snapshot, about 7 B of events per frame, 4 players, 147 kbit/s voice each way, the chat prober) | **Wi-Fi:** 15 Hz. **3G:** chat one-way p95 < 300 ms; ≥ 13 frames/s; bytes inside the §2.6.8 ceilings; game queue ≤ 8 KB. **3G + 1 % loss:** chat p95 < 450 ms; ≥ 10 frames/s. **Collapse to 120 kbit/s for 20 s** (the lane fits; nothing may degrade) **and the squeeze to 12 kbit/s left after voice:** the ladder steps down once queueing (+150 ms) has held 1 s as the server sees it, and the first FRAME at the new rate leaves within 1.25 s of that onset (measured 1,191 ms in the squeeze); ≥ 5 frames/s or a clean `overflow` park; back to 15 Hz within 5 s; no chat ack over 2 s. **10 s tunnel:** `stalled` at 2.5 s; one keyframe ≤ 512 B on resume. **3 s main-socket backlog:** `yield` within 2.5 s; resume after 2 probes. | `lossyLink.test.ts`; each scenario ≤ 1 s, ≤ 5 s in total |
| Lane integration | `/socket.io/` and `/arcade/ws` both upgrade on one server; an unknown path is destroyed in < 10 ms. Tickets are single-use with a 30 s TTL. A bad Origin gets 403. HELLO times out at 5 s. Frames over 4 KB close the socket. Per-IP cap 12. Rate: over 40/s is dropped; 200/s for 2 s gives 4429; the 10th malformed frame gives 4400. A resume within the grace keeps the slot. A second tab gets the seat, and the first gets 4409. VIS 1 → pings only; VIS 0 → keyframe. Idle reapers (injected clock): 30 s, 120 s, a 2 min empty table. Restart: PHASE 4, HANDOVER, 1012, escrow refunded. Boot refunds leftover escrow. A tick exception ends only that match. A 25 ms step ends it as `overload` with a replay ≤ 8 KB. A 7th action match is refused. Egress > 1,500 kbit/s and loop-delay p99 > 30 ms each trigger the degrade order. | `lane.int.test.ts`, `hub.int.test.ts` (≤ 15 s in total) |
| Table lane | Bucket 3 KB/s with a 6 KB depth. A non-empty main `writeBuffer` defers Arcade emits in 50 ms steps, and chat arrives first (order assertion). The overflow policy swaps the queue for its replacement event. Stamping happens at send time, and `onSent` reports the wait. Sub-bucket 200 B/s with an 800 B depth. `emitRoom` never calls `io.to()` (spy). Activity ≤ 1 per 2 s per channel and ≤ 150 B. Lobby updates ≤ 2 Hz. Viewers outside the call receive only activity. Invites at most once a minute per pair, none under Do Not Disturb. A hidden account gets refusals with code `hidden`. Refusals ack `{ok: false, code: 'busy'}` and never emit `error`. | `tableLane.int.test.ts` |
| Wallet | 5,000 seeded operations in ≤ 2 s. The invariant (P§11.2) holds after every one. Grant of 20,000 happens once. The claim is `max(2000, 10000 − (bal + esc))`, once per UTC day. The `min` guard works. A retry returns the stored receipt. Actor `'system'` deduplicates. Folding (7 d for spin and feature, 90 d otherwise) keeps conservation. Receipts are cleared at 24 h. | `wallet.prop.test.ts` |
| Client: zero cost | After mounting and unmounting ArcadeSheet, GameStage and ArcadeOverlay, with each stub chunk and a fake game: `frames.active === 0`; no live `setTimeout` or `setInterval` (spied); no open WebSocket (spied constructor); no window, document or key listeners; AudioContext closed; canvases 0 × 0. With the Arcade closed there is no `/arcade/ws`. | `zeroCost.test.tsx` |
| Client: signals and render | 100 frames/s into a fake game write 0 signals. Each platform signal gets ≤ 2 writes/s. VoicePage renders once (render counter). Lobby or activity updates change no route, play no sound and open no toast. | `signals.test.tsx` |
| Client: visibility, input, chat-first | The merger produces the correct VIS sequence from document, page hide/show, Capacitor, IPC, IntersectionObserver and minimized fakes. Input: reserved keys (the PTT key, Ctrl+K, Ctrl+Shift+M/D/comma, Alt+C, Escape outside the canvas, F12, Ctrl+Shift+I) are never bound; `isTyping` applies; a 10 ms tap is latched; stick dead zone 12 px and radius 48 px; `pointercancel` releases; gamepad dead zone 0.3. Chat-first: an ack over 2,000 ms, or a probe timeout at 3 s, gives VIS 2 and the "Paused so chat and voice can catch up" notice; 2 probes under 600 ms give VIS 0. The probe rate is ≤ 0.2/s, and only while a lane is open. | `visibility.test.ts`, `input.test.ts`, `chatFirst.test.ts` |
| Offline | The overlay mounts from AuthScreen while `fetch` rejects and the socket never connects. The practice wallet falls back to memory when `localStorage` throws. Open escrow is restored on mount. | `offline.test.tsx` |
| Bundle | Main bundle growth ≤ 4 KB gzip; `arcade-runtime` ≤ 25 KB. `npm run build` fails over budget. | `check-bundle.mjs` |
| Layout | Arcade sheet, LobbyChip, InviteChip and the stage header at 360 × 640 and 640 × 360: no horizontal scroll; touch targets ≥ 44 px; "Back to call" visible. | jsdom width checks plus one headless screenshot run ≤ 30 s |
| Naming | The hash scan passes over `client/src`, `server/src`, `docs/`, the READMEs and `landing.html`. `name-hashes.mjs --git` passes on the branch's commits. | `naming.test.ts` |
| Real smoke (manual, at M2) | Probe bench (one shaped Chrome and 3 Node bots, 600/100 kbit/s): 3G 25 s, 3G + 1 % 25 s and collapse 45 s pass the simulator criteria, with no ping timeout on either socket and lane `bufferedAmount` < 8 KB. A 15 s CPU trace of the idle voice page with the Arcade closed equals the P0d baseline ± 1 point. | `ops/bench/arcade-netbench.mjs --game probe` |

### 3.3 G1 Lamplight Hold'em

| Area | Acceptance criteria (numbers) | Test |
|---|---|---|
| Evaluator and equity | All 2,598,960 five-card hands give the exact category counts (40, 624, 3,744, 5,108, 10,200, 54,912, 123,552, 1,098,240, 1,302,540) in about 1 s. 100k seeded 7-card hands match a brute-force best of 21. The L§4 vectors pass. The Ah Kh vs Qs Qd oracle gives exactly 15.909 %. | core suite ≤ 5 s |
| Rules | All scripted L§18.1 betting scenarios pass (BB option, min-raise, short all-ins that do or do not reopen, heads-up order, uncalled refund, 3- and 4-way side pots, odd chip, the board plays, ante, `turnQ` staleness). Properties over 2,000 seeded hands: chips conserved after every event, no negative stack, a legal action always exists, every hand ends, pots sum to contributions, `buildPots` makes ≤ seat-count passes. Determinism: the same seed gives the same event-log hash over 500 hands, and a snapshot plus replay rebuilds the state. | core suite |
| Economy | An exhaustive mapping of all 1,000,000 draw values reproduces the Trio table, with EV exactly 2.9725 (< 50 ms). The validator rejects EV ≥ 3 and weights not summing to 1,000,000. Payouts sum to the pool for every format and player count, including human-only Cup places and the abandoned split. | core suite |
| Proof | Build and verify pass. Changing one card, salt or leaf fails. `rv` never contains a mucked or undealt card. `ranks169.ts` matches its hash and orders AA first and 72o last. | core suite |
| Hidden information | 200 bot hands with three sockets (2 seated, 1 spectator). Every emit is scanned structurally: no other seat's hole cards before showdown, no mucked cards ever. A proof reveals only the board, the caller's own cards and the shown cards. A non-seated caller gets `forbidden`. | integration ≤ 4 s |
| Wallet and lifecycle | Concurrent buy-ins never go negative. `onRestarting()` voids the hand and refunds hand-start stacks. Conservation holds after every flow in L§12, including bot buy-ins and `hand` txns. Reconnect keeps the seat; `sync` inside the ring returns events plus `hole`, outside it a snap with cards and salts. `dup` and `stale` codes work. The Trio refuses online bots. The Cup pays humans only. Bots are refused at Boulder and Summit. The 6-bot cap holds. Tables close after 2 min empty, and after 5 min with every human sitting out. No timer is armed between hands when nobody can play. | integration |
| Pacing | A forced writeBuffer backlog delays Lamplight but not chat. Overflow (> 32 events or > 2 s) gives one snap. A 1 s queue wait extends the deadline by 1 s. Link scenario at 3G with 4 players: per-hand wire bytes ≤ 3 KB (4-handed) and ≤ 4 KB (6-max); ≤ 3 KB in any 1 s; chat p95 < 300 ms (< 450 ms with 1 % loss); `q` consecutive; no deadline missed by a client that answered within 1 s. | sim ≤ 1 s |
| Client | Action-bar bounds and pre-action reset. Keyboard: PTT exclusion, `isTyping`, A twice for all-in. Zero cost: `frames.active === 0`, no timers, Worker terminated, AudioContext closed. Hidden: events applied with 0 canvas calls and the ring timer cleared; one redraw on return. 50 table events write `myTurn` at most twice per turn and no platform signal except `attention`. Proof check with a `crypto.subtle` stub, plus the message when it is absent. | jsdom ≤ 2 s |
| Performance | Server < 0.2 ms per action; bot ≤ 2 ms per decision. Lamplight chunk ≤ 50 KB gzip (43 KB target); bot Worker ≤ 10 KB. CPU at 4×: a still table (not your turn) has 0 rAF callbacks and a main thread < 1 %; seated and minimized, 0 rAF and no ring timer; after closing, equal to the baseline. | build check; 3 traces × 15 s |
| Phone | Portrait 360 × 640 (own cards 64 × 90 px, action bar 64 px, targets ≥ 48 px), landscape 640 × 360, desktop 1280 × 720, with no horizontal scroll. | one screenshot run ≤ 30 s |
| Soak (on demand only) | 5,000 bot-only 6-max hands on 4 workers, hard stop at 60 s: no throw, chips conserved, Sharp beats 5 Greenhorns at 95 % confidence (it stops when the bound is crossed, about 1,500 hands). | `npm run test:soak -- lamplight` |

### 3.4 G2 Glimmerhall

| Area | Acceptance criteria (numbers) | Test |
|---|---|---|
| Math | `exactRtp` matches to 1e-9: Orchard 0.948464500375662, Tidepool 0.9422046018125284, Ember Vault 0.9472091408049044, each in [0.94, 0.97]. 1M base spins land within 4 SE of the base RTP, and 50k features within 4 SE of the feature mean (about 3 s). The ≥ 40 hand-built windows per machine and the strip invariants (< 64 stops, never two scatters in a window) pass. | ≤ 5 s |
| Determinism | A fixed seed gives a golden FNV-1a hash of 10k spins, identical in Node and jsdom. | both suites |
| Wire | Base ack ≤ 80 B. Tide Turn ack ≤ 160 B at 10 spins and ≤ 1.2 KB at the 200-spin cap. Enter ack ≤ 1 KB with 16 members. `glimmer:feed` ≤ 400 B. `decodeStops` rejects out-of-range characters. | unit |
| Authority | An injected throw after the guard, and after the draw, rolls everything back. Retries are idempotent, including `settled: true` after the receipt is cleared. An unknown id gives `found: false`. Balance < bet is refused even when the would-be win exceeds the bet. Pot carry over 10k bets equals `floor(Σ bet × 75 / 10000)`. The pot draw runs once per online base spin and never for free or Dash spins. Hidden info: no emit to a non-owner contains `bal`, door data before the pick, or a non-notable spin; away members and non-members get nothing. | integration |
| Lifecycle and Dash | The seat moves to a new socket (`glimmer:moved`). The seat drops after 120 s. An empty hall is deleted. Leaving voice sets `hall = null`, and spinning still works. A restart voids and refunds a Dash. Boot refunds `dash:*` escrow. Disabling the game auto-picks vaults. A DEFS mismatch gives `update`. Dash: minimum 2 entrants; a 60 s lobby cancels and refunds; splits sum exactly; ties give the odd chip to the earlier finisher; a freeroll awards a trophy only. | integration (injected timers) |
| Pacing | 16 members at the maximum cadence. Per recipient: ≤ 3.9 kbit/s averaged over 10 s, ≤ 3 KB in any 1 s, pushes ≤ 1 Hz. A writeBuffer backlog defers pushes by 50 ms and merges them. Link scenario at 3G: chat p95 < 300 ms (< 450 ms with loss); spin ack round trip p95 < RTT + 100 ms. | virtual time ≤ 1 s |
| Bots | An offline Dash (4 bots × 100 spins) plus a 100k-spin hall: no negative balance, no NaN, every Dash ends, deltas equal results. | < 2 s |
| Client | Zero cost (as for P), and still reels for 5 s schedule 0 frames. 100 spins write `arcadeWallet` ≤ once per 2 s. Hidden stops audio, bots, auto-spin and the Dash clock, and sends `glimmer:away`. Space is skipped when it is the PTT key. `pointercancel` cancels a spin. The 700 ms floor holds. A gamepad subscription exists only while a pad is connected. 360 × 640 and 640 × 360 have no horizontal scroll; SPIN is 76 px and bet ± 48 px. | jsdom ≤ 3 s |
| Performance and real smoke | Chunk ≤ 40 KB gzip (engine ≤ 8 KB). A base spin including its transaction takes ≤ 0.5 ms. CPU at 4×: spinning p95 frame cost ≤ 4 ms with no long task > 50 ms; reels still give 0 game frames and 0 game timers. Shaped smoke, 25 s, auto-spin in a hall with 3 bots at 2 spins/s: chat p50 < 300 ms, Glimmerhall down ≤ 4 kbit/s, no ping timeout. Desktop minimized: 0 rAF and `glimmer:away` sent. | build; 2 traces × 15 s; bench 25 s; desktop smoke |

### 3.5 G3 Fuseyard

| Area | Acceptance criteria (numbers) | Test (cap) |
|---|---|---|
| Rules, ghosts, movement | Every F§12 rules case passes. Every ghost row of F§1.7 passes, including the 150-tick hold and the 30-tick resume. 2,000 random input sequences × 120 ticks: no fighter ever enters a blocked cell; clamping is exact at every speed. | 1 s + 1 s + 1 s |
| Determinism | 20 seeded Quickfire rounds run twice, with hashes compared every 30 ticks. Golden hashes at ticks 300 and 1,800 for 5 seeds match in Node and jsdom. A changed hash fails until `SIM.fuseyard` is bumped. | 3 s |
| Codec and hidden items | FRAME without events ≤ 32 B; UP ≤ 9 B at n = 2; keyframe ≤ 512 B with all pools full and ≤ 160 B at round start; WELCOME ≤ 64 B. Fuzzed bytes give null. No item code reaches any recipient before its BlockBroken. | 0.5 s + 1 s |
| View fuzz | `deltaFuzz` with Fuseyard's runtime: the client world equals `keyframeFor()` after every sequence. | 2 s |
| Budget | A recorded 4-bot Brawl round through the real sender: per player, mean down ≤ 2.2 KB/s, worst 1 s ≤ 3.2 KB, up ≤ 1.8 KB/s; spectator mean down ≤ 1.4 KB/s. | 1 s |
| Bot soak (CI) | 60 one-on-one rounds of Menace vs Sprout plus 12 four-bot Brawl rounds (about 100,000 ticks). Menace wins ≥ 80 %. Self-kills are < 10 % of deaths for Menace and < 40 % for Sprout. The median Brawl round is 30–110 s. No bot is stuck for 300 ticks outside Wait. Think time p99 ≤ 0.1 ms. | 6 s (10× on demand: 60 s) |
| Lane integration | 2 humans + 2 bots: a 2.5 s stall gives a ghost after the lock, with SeatState seen by the other client. VIS 1 → pings only; VIS 0 → KEYFRAME reason 2 plus the shield. A resume within the grace keeps the slot. After 60 s a Scrapper bot takes over, reclaimed at the next round through a re-sent WELCOME. The freeze-and-hold win works. Leave → bot at once. Late join is queued to the round start. Idle ends the match at 30 s and at 120 s. An exception isolates the match. A 25 ms step gives `overload`, a HANDOVER and a dump. | 5 s |
| Client | 100 FRAMEs/s write 0 signals, and 600 frames cause 0 child-list mutations in the touch overlay. Stick rules: 15 % to switch axis, 35 % for the minor axis. A 10 ms tap is latched. The predictor matches the server on recorded inputs. | ≤ 2 s |
| CPU and phone | CDP smoke at 4×, offline vs 3 bots for 15 s: main thread < 35 %; frame work p95 ≤ 8 ms; frame interval p95 < 16.7 ms at the 60 fps cap; no long task > 50 ms. Closed: 0 rAF, 0 timers, no lane. Minimized (Electron): 0 rAF, ping only. `step()` ≤ 0.2 ms on the server and ≤ 0.3 ms at 4×. Portrait deck ≥ 200 px with Pop 76 px and Click 56 px. The rotate hint shows when tiles would be < 18 CSS px. | ≤ 90 s |
| Shaped bench (4 players: 1 shaped Chrome + 3 Node bots) | 3G 25 s and 3G + 1 % 25 s pass the P criteria. The collapse scenario (120 kbit/s; the lane fits) and the squeeze (12 kbit/s) recover within 5 s; in the squeeze the ladder steps down once queueing (+150 ms) has held 1 s as the server sees it, and the first FRAME at the new rate leaves within 1.25 s of that onset (measured 1,191 ms in the squeeze). Lane down ≤ 25.6 kbit/s in any 1 s. | ≤ 3 min with setup |
| Android | Fuseyard backgrounded in the WebView: no frames drawn, and the server shows the seat parked as `away`. | ≤ 1 min (blocked if WHPX fails) |
| Bundle | Chunk ≤ 45 KB gzip; the catalogue entry adds about 200 B to the main bundle. | build |

### 3.6 G4 Bellwick

| Area | Acceptance criteria (numbers) | Test (cap) |
|---|---|---|
| Rules, content, solver | Every B§1.2 row, the Buckler (front only), every Vinehook case, keys, the shop, max hp, revive and respawn, drops, and boss HP scaling. Screens are 12 × 9, edges match, references resolve, and maps contain no backtick or `${`. Flag ids are append-only against `flags.lock.json` (≤ 256). The BFS solver shows victory is reachable from every reachable state, whatever the key order. | 0.5 + 0.3 + 0.5 s |
| Determinism and version | Golden hashes at ticks 300 and 1,800 match in Node and jsdom. A 20,000-tick log replayed twice gives equal hashes every 100 ticks. A change to `HERO_RULES` or `TILE_FLAGS` without a `CODEC.bellwick` bump fails (`RULES_HASH`). | 1 s each |
| Fuzz and completion | 10,000 ticks × 4 heroes in each of the 36 rooms: no exception, pool caps hold, ids unique. The walkthrough bot finishes from seed 1 within 45,000 ticks, and 32 seeded dungeon runs all finish. | 2 s + 3 s |
| Codec and authority | Snapshot ≤ 91 B (3 heroes and 14 entities). Keyframe ≤ 384 B worst case and ≤ 200 B typical. UP = 16 B. EVT ≤ 17 B. u16 ticks wrap. Checks: the speed clamp; wall clipping gets Correct; claims older than 16 ticks, from too far, or with more than 8 targets are refused; a key raced at two doors opens one; a duplicate `evSeq` applies once; damage from beyond 24 px is refused; a future `heroTick` is clamped. | 0.2 + 0.5 s |
| Routing and session | `deltaFuzz` extended with room changes, warps, respawns and party events: client room and party equal the server's view. Session: 60 s grace, 10 min away limit, 3 min idle → rest, no work while idle, host hand-off, save on end, restart saves and sends HANDOVER, wipe, revive. Glints cover the Buckler; boss time to kill ≥ 45 s solo and ≥ 35 s with 4. | 1 + 0.5 + 0.2 s |
| Link simulator | 3 bot heroes plus the measured one, in the boss room: 3G and 3G + 1 % pass the P criteria; ≥ 98 % of claims accepted at 3G; bytes within 19–22 typical, 28 peak and 32 worst-window down, and 16.4 up. | 1 s per scenario |
| Client | Hiding stops frames, audio and the music timer. `unmount` leaves nothing. The chunk stays unloaded while closed. 100 frames/s write no signals. Portrait canvas ≤ 60 % of the height with controls ≥ 200 px (overlay below 180 px); landscape gutters < 140 px switch to the overlay. | ≤ 2 s |
| Performance | Main thread ≤ 4 ms per frame on average at 4× throttle in the boss room (15 s trace), and < 35 %; no task over 16 ms. Server ≤ 0.1 ms p99 per ticking room and 0 when idle. Chunk ≤ 60 KB gzip. | trace 15 s; build |
| Real bench and Android | 3 Node bot heroes + 1 shaped Chrome: 3G 25 s and 3G + 1 % 25 s pass. Party Tale backgrounded on Android: nothing drawn and parked (shares the Fuseyard check). | ≤ 1.5 min |

---

## 4. Integration, verification and PR plan

### 4.1 Per-PR automated gate

This is the same as today, plus the new suites. It is the gate for every package.

- `cd server && npm run typecheck && npm test`. This runs both tsconfigs, and the added wall time is about 30–40 s.
- `cd client && npm run build && npm test`. The build runs tsc, then Vite, then `check-bundle.mjs`, and must use `npm run build`, never `npx vite build`, because CI typechecks the test files too.
- The desktop shell builds from the client build. The Android debug APK builds through Gradle in the terminal with JBR JDK 21, because the sandboxed shell blocks Gradle's loopback socket.

### 4.2 Per-wave manual pass (≤ 10 minutes of wall time, run once per release wave)

| # | Check | Where | Time |
|---|---|---|---|
| 1 | Shaped bench: Fuseyard 3G, 3G + 1 %, collapse; Bellwick 3G, 3G + 1 %; Glimmerhall 3G. One shaped Chrome + 3 Node bots each, with the chat prober. | `ops/bench/arcade-netbench.mjs --max-wall 600` | ≤ 4 min (25 + 25 + 45 + 25 + 25 + 25 s + setup) |
| 2 | CPU traces at 4× throttle, 15 s each: idle (Arcade closed); Fuseyard open; Fuseyard hidden; Lamplight still; Glimmerhall spinning; Glimmerhall still; Bellwick boss room | the same Chrome over CDP | ≤ 2 min |
| 3 | Packaged desktop smoke (§4.3) | Electron, scratch profile | ≤ 90 s |
| 4 | Android check (§4.3) | emulator, WebView DevTools | ≤ 1 min (blocked if WHPX fails) |
| 5 | Firefox smoke (§4.3) | headless Firefox over BiDi | ≤ 1 min |
| 6 | Phone layouts: 360 × 640, 640 × 360 and 1280 × 720 for each shipped game | one headless Chrome | ≤ 30 s |

Each wave runs only the rows for the games it ships, plus row 1's Fuseyard 3G scenario as a regression check. Wave 1 (P + Fuseyard), for example, needs about 5 minutes. Phone touch feel on a real device is the owner's hand checklist (F§12, B§10), not a timed run.

### 4.3 Platform recipes

**Every browser runs muted.** Chrome and Electron get `--mute-audio --use-fake-device-for-media-stream --use-fake-ui-for-media-stream`. Firefox has no such flag, so it gets the preferences `media.volume_scale = "0.0"`, `media.navigator.streams.fake = true` and `media.navigator.permission.disabled = true`.

- **Web, Chrome.** Headless, driven over CDP by the bench, using a short per-run profile under `%TEMP%`, because long scratch paths break IndexedDB.
  - The bench uses its userland shaper: Chrome's own network emulation does not delay WebSocket frames.
  - Before starting a dev stack, check the ports with `netstat`. Docker 8080 and Vite 5173 are shared with other sessions, so use free ports with tsx and Vite.
  - Never write under `client/` during a browser run, because Vite then silently reloads the page.
- **Web, Firefox.** For each shipped game:
  1. Mount it offline vs bots, then online with one Node bot.
  2. Confirm the binary lane opens.
  3. Confirm the AudioContext unlocks on the first gesture.
  4. Confirm the `pixelated` canvas renders, or the blit fallback does.
  5. Switch the BiDi browsing context to the background, and confirm the game pauses offline or sends VIS 1 online.
- **Packaged Electron:**
  - **Build:** an unpacked electron-builder build into the scratchpad. Run `node node_modules/electron/install.js` first if a fresh `npm ci` left no electron binary.
  - **Launch:** `--user-data-dir=<scratch profile>`, `--mute-audio` and `--remote-debugging-port`, with `DATASETTO_SERVER_URL` pointing at the local test server. A Node script drives it over CDP, and `taskkill` stops it.
  - **Checks, ≤ 90 s:**
    - Arcade closed: 0 rAF.
    - With the server stopped, "Play offline" starts Fuseyard and it plays.
    - Minimize: `window:visibility` goes false, there are 0 rAF and VIS 1 is sent.
    - Restore: a keyframe arrives.
    - The Lamplight module Worker starts from `file://`, or the main-thread fallback runs.
    - "Your turn" while minimized calls `flashFrame`, seen in the main-process log.
- **Android emulator:**
  - **Setup:** the debug APK; the server at `10.0.2.2` with `allowMixedContent`; `hw.keyboard=no`. Drive it through the WebView DevTools socket `webview_devtools_remote_<pid>`. After `cap sync`, revert LF-only changes.
  - **Checks, ≤ 1 min:**
    - Background Fuseyard: 0 frames, and the server parks the seat as `away`.
    - Background Party Tale: the same.
    - In airplane mode, "Play offline" starts Solo Tale or Fuseyard.
  - **If the emulator fails** with "WHPX: Failed to setup partition, hr=80070005", retry once with `-no-snapshot-load`, then report the Android row as blocked. Do not keep retrying.
- **iPhone (optional, not a gate).** In the Linux Playwright WebKit image over https: Lamplight and Glimmerhall portrait smoke, ≤ 1 min. Real-iPhone items stay on the owner's checklist.

### 4.4 PR and release plan

| PR | Branch | Contents | Opens when | Merge order | Release |
|---|---|---|---|---|---|
| 1 | `arcade/frames` | P0c | its gate and the web check pass | any | R0 |
| 2 | `arcade/window-visibility` | P0b | gate + desktop check + Android visibility | any | R0 |
| 3 | `arcade/voice-cap` | P0a | gate + `getStats` check + an Android call | after 2 (appState swap) | R0 |
| 4 | `arcade/idle-cost` | P0d | gate + traces meet P0d's numbers | any | R0 |
| 5 | `arcade/platform` | P (all of P-M1 to P-M3) | web, server, ops (Caddy route, both images), desktop and Android all verified | after 1–4 | R1 |
| 6 | `arcade/fuseyard` | G3 | verified on top of PR 5's branch | right after 5 | R1 |
| 7 | `arcade/lamplight` | G1 | verified on top of main with P | after 5 | R2 |
| 8 | `arcade/glimmerhall` | G2 | the same | after 5 | R2 |
| 9 | `arcade/bellwick` | G4. If Party Tale slips, Solo Tale may ship in R2 with Party Tale hidden, via `meta.ready.online = false` | the same | after 5 | R3 |
| 10 | `arcade/remove-legacy-stub` | deletes `arcade/legacy.ts` and its test | 3 releases after R1 | — | R1 + 3 |

**Rules:**
- **Pushing and PRs.** Push branches freely. Open a PR only once web, server, ops, desktop and Android all work.
- **R1 needs PRs 5 and 6 together.** Merge them back to back, because removing the old games without a replacement is a regression. No release is cut between those two merges, and a hotfix in that window branches from the last release tag.
- **One VPS redeploy and one release per wave.** The wave redeploys after all of its merges. Wave R1's redeploy carries the server image, the Caddy image (which now copies `server/src/arcade/core`) and the Caddyfile route together.
- **Text in commits, PRs and branches** never names the commercial products these games resemble, their formats or heroes, or the chat app this project is an alternative to. No assistant or tool attribution lines (the owner's standing rule). Branch names are `arcade/<topic>`.
- **Before the first public release** (R1): the owner's trademark search (§1.2 #17) and `node ops/scripts/name-hashes.mjs --git` over the release's commits.

---

## 5. Risks and cut lines

### 5.1 Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Scope: a platform plus four games | the release slips | offline-first per game from P-M1; waves; cut lines (§5.2) |
| A wallet bug mints or destroys chips | the economy breaks | `transfer()` is the only path; the conservation property runs after every operation; boot refunds; admin reset and a ledger view |
| Hidden information leaks (poker hole cards, Fuseyard items, slot doors) | cheating | views-only serializers; structural scans of every emit in the integration suites |
| A runaway sim on the shared event loop | chat stalls | structural loop bans (grep); per-step timing ends a match; loop-delay ladder; ≤ 6 matches; `MatchRuntime` can later move to a worker |
| TCP head-of-line blocking under loss | game stutter for about one RTO | separate lane and in-flight cap, so chat is unaffected; accepted (P§19.1) |
| Verification creep (the owner's complaint) | wasted hours | hard per-run caps, abort on certainty, no soak gates, a 10-minute wave pass (§3.0, §4.2) |
| Old shells: no visibility IPC, old codec | they draw while minimized; they cannot join | the stub for 3 releases; 4426 "update required"; offline still works |
| Android WebView stops scripts in the background; the emulator's WHPX fails | missed poker turns; a blocked check | the disconnect rules cover the seat; report the check as blocked; the owner's real-phone checklist |
| Budgets are computed, not measured | a real link could differ | codec size tests in CI; the sender logs ceiling breaches; one shaped bench per wave |
| Bundle creep | the main bundle grows | `check-bundle.mjs` inside `npm run build` |
| Trademark collisions in names | renames late | the search before R1; names live only in `meta.ts`, content and docs files |
| Voice cap quality complaints | worse voice on cellular | Auto / On / Off; the cap is per peer, so Wi-Fi peers keep 128 kbit/s to each other |
| Bellwick content and art volume | it slips | Solo Tale ships first; placeholder art until its M6 |
| Electron `file://` module Worker | slow poker bots | the main-thread sliced fallback; a check in the desktop smoke |
| Golden hashes differ across JavaScript engines | false failures | integer-only sims, an integer sine table, hashes run in Node and jsdom |
| Firefox canvas or audio quirks | visual or sound bugs | the Firefox smoke each wave; the blit fallback |

### 5.2 Cut lines (cut in this order if time runs short)

1. Gamepad support in every game. Keyboard and touch stay.
2. Music. Sound effects stay.
3. Spectators ("Watch") in Fuseyard and at poker tables.
4. Bellwick extras: Pip, solo-save import, battery saver.
5. Fuseyard: 3 of the 5 arenas (Brickyard and Rolling Mill stay), then Quickfire.
6. Glimmer Dash. The hall, feed, pot and reactions stay. Then reactions.
7. Lamplight: the deck-proof drawer and paged history. The commitment in `hand` and the stored records stay, so the proof can ship later. Then the online Firefly Trio, then the online Lamplight Cup (both stay offline).
8. Leaderboards beyond one per game; the admin ledger view.
9. Bellwick Party Tale: ship Solo Tale only.
10. A whole game, as a last resort: Bellwick moves to a later cycle (Solo Tale can still ship), then Glimmerhall.

### 5.3 Never cut

- The phase 0 voice cap and window visibility.
- The chat-first guard, pacing and parking.
- Server authority, plus the hidden-card and hidden-item scans.
- Wallet conservation.
- Reconnect by account id with a grace period.
- Opt-in joining.
- The zero-cost-when-closed tests.
- Offline mode for every game that ships.
- Removal of the old games, with the old-shell stub.
- The naming scan.
- The verification time caps.
