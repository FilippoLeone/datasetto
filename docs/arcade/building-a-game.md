# Building a game on the Arcade platform

A short guide for the four game packages. The contract is plan.md §2.6, as amended in platform.md §20 ("As built"). Everything listed there is frozen at tag `arcade-p-m1`; a change is a small platform PR with a one-line note in platform.md §20.

## Files you own

| Game | Server | Client | Tests |
|---|---|---|---|
| any | `server/src/arcade/core/<id>/**` (starts with `version.ts` and `budget.ts`) | `client/src/arcade/<id>/**` (starts with `meta.ts` and `index.ts`) | `server/test/arcade/<id>/**`, tests next to your client files |
| Fuseyard, Bellwick | `server/src/arcade/rooms/<id>.ts` (default export: a `MatchGameDef`) | | |
| Lamplight | `server/src/arcade/tables/lamplight.ts` (+ `cup.ts`, `trio.ts`) | | |
| Glimmerhall | `server/src/arcade/halls/glimmer.ts` (+ `dash.ts`) | | |

Each stub's default export is `null` (server) or a "coming soon" chunk (client) until you replace it. The registry (`server/src/arcade/games.ts`) and the catalogue (`client/src/arcade/catalog.ts`) never change when a game lands. Set `meta.ready` to show your tile.

## Imports

| What | From |
|---|---|
| Bytes, RNG, hashes | `@arcade/core/bytes`, `@arcade/core/rng`, `@arcade/core/hash` (server: relative paths with `.js`) |
| The `CoreMatch` contract and host events | `@arcade/core/net/match` |
| Envelope types, constants (`PHASE`, `KEY_REASON`, `TICK_MS`) | `@arcade/core/net/lane` |
| Event walking and platform events | `@arcade/core/net/events` (`forEachEvent`, `PEV`) |
| Interpolation and the tick clock | `@arcade/core/net/interp`, `@arcade/core/net/clock` |
| Budgets | `@arcade/core/net/budget` (types), your own `core/<id>/budget.ts` (numbers) |
| Hosts, `GameModule`, `GameChunk`, `MountOpts`, `ShellBridge` | `@/arcade/runtime/types` |
| `GameMeta`, `OptionField` | `@/arcade/catalog` |
| The frame scheduler | `frames` from `@/arcade/runtime/p0` |
| Loop, canvas, input, audio, sprites, font | `@/arcade/runtime/{loop,canvas,input,audio,sprites,font}` |
| Device storage | `readLocal` / `writeLocal` from `@/arcade/runtime/store`; per-game prefs via `readGamePref` / `writeGamePref` in `@/arcade/runtime/prefs` |
| Practice chips | `opts.shell.practice` |
| Server table API, wallet, stats | `server/src/arcade/tables/types.ts` (re-exports the wallet and stats types) |
| Server action API | `server/src/arcade/rooms/types.ts`, `wrapCore` from `rooms/wrap.ts` |

The core's purity test (`server/test/arcade/core.purity.test.ts`) covers your `core/<id>/` too: no `Math.random`, `Date`, `performance`, timers, `crypto`, `process`, `globalThis`, `for…in` or `enum`; only relative `.js` imports inside core; no `while` or `do` in `sim/`, `bots/`, `sim.ts`, `danger.ts` or `bots.ts`. Fuseyard's extra tokens are in the same test.

## Lifecycle the platform drives

- **Mount.** The shell calls `chunk.module.mount(stage, host, opts)` with a stage element that fills the game area. Offline it first calls `chunk.local({mode, cfg, seed, seats})`; seats are you in slot 0 and bots in the rest (`cfg.players` or `cfg.fighters` sets the count, else the meta's maximum for action games and minimum for table games).
- **Visibility.** The platform merges app visibility, "Back to call" and the IntersectionObserver, then calls `host.setVisible(v)` and `handle.pause()` / `handle.resume()`. A paused game draws nothing, runs no timers and suspends its audio. `resume()` may also be called once right after mount.
- **Back.** Android back and Esc call `handle.back()`; return true when you consumed it (a menu closed), false to let the shell minimize.
- **Unmount.** Free everything: loop, input, audio, canvases (`stage.dispose()`), timers, Workers. The shell's tests check that nothing is left.
- **Local hosts.** `createLocalMatchHost` steps your `CoreMatch` at 30 Hz (at most 4 steps per frame) and drains `takeHostEvents()` after every step. To see `persist` events offline (Bellwick saves), wrap `takeHostEvents` in the core you return from `local()`.

## Testing helpers

`client/src/arcade/runtime/testing.ts` (import from tests only): `installFakeFrames()` (virtual rAF and `performance.now`), `stubCanvas()` (a recording 2D context for jsdom), `createProbeCore()` (a scriptable `CoreMatch`) and `trackResources()` (live timers, sockets and listeners). `client/src/features/arcade/fakeGame.test-util.ts` shows a fake game that uses every runtime piece and `installFakeAudio()`.

Every test file must finish well under 60 s; use seeded randomness and injected clocks.

Server side, `server/test/arcade/harness/index.ts` is one import for everything:

- **Virtual time.** `lossyLink(profile)` is one client's bottleneck link stepped 1 ms at a time (rate, delay, jitter, loss with head-of-line stalls, voice and chat sharing the queue). `runScenario(scenario)` drives the real sender and a runtime over that link against a modelled client and returns frames, chat latency, bytes and ladder changes per window. `deltaFuzz(o)` checks the delta-base rule over seeded schedules. `probeRuntime(o)` is a pure runtime shaped like an action game, and `withWallCap(ms, fn)` fails a run that takes too long.
- **Live server.** `startArcadeServer({clock, settings, arcade})` boots the real HTTP app, Socket.IO and the action lane on a free port with a fake clock. Pass your def as `arcade: {matchGames: [yourDef, null]}` (or `tableGames`); `account()`, `socket()`, `joinVoice()` and `lane(ticket)` drive it. `probeGame()` and `probeControl` are the platform's scriptable match game.

## The shaped bench

`node ops/bench/arcade-netbench.mjs --game <id> [--max-wall 600] [--out <dir>]` runs one headless Chrome through a userland TCP shaper (the non-voice share of 3G: 600/100 kbit/s, 300 ms RTT, 64 KB buffers) next to unshaped Node bots, with a chat prober on the main socket. Each scenario is capped at 60 s and stops early once a check has failed. The report gives frames per second, chat one-way delay, probe RTT, lane bytes per second, what the server actually sent (FRAME divisors, keyframe reasons) and the watchdog level.

A game takes part by adding `ops/bench/games/<id>.mjs`, found by file name (or `--plugin <file>`). `ops/bench/games/probe.mjs` is the example. Scenarios: `3g`, `3g-loss`, `collapse` (120 kbit/s, the lane fits) and `squeeze` (12 kbit/s left after voice); a full run stays under 150 s.

- **Required exports:** `scenarios` (a subset of the four), `game` (the server game id), `startBots(server, n)` returning `{ lobby: { id, ch, game, started }, start({ humans }), stats(), stop() }` (called with n = `humans` − 1), and `enter(page, lobby)`.
- **Optional exports:**
  - `humans` (default 4) and `serverOptions({ loadServer })` (the server's Arcade options, e.g. `{ matchGames }`).
  - `ready(store)`: setup waits for it instead of the first lane frames (15 s), for table games; `store.game` holds the plugin's own samples.
  - `criteria`: `{ [scenario]: {...} }` replaces that scenario's checks. Keys: `framesMedian` (frames/s ≥), `chatP95` and `chatP50` (chat one-way ms <), `sioDownKbps { kinds: [prefix…], max }` (mean socket.io down kbit/s for events whose name starts with a prefix; `'ack'` covers acks), `probeMaxMs`, and `collapse: true` with `recoverFrames` (the ladder, floor and recovery checks). No disconnects and lane `bufferedAmount` are always checked.
  - `stage = true`: the app keeps its own `arcade:lobby` handling, so its stage opens.
- **What `enter` gets:** in Chrome, `page.page.eval(js)` (`window.__bench.sc` is the app's socket client; push samples with `window.__bench.game.push(…)`), `page.startProbes(ms)` for the acked `arcade:probe`, and `page.join(ch, id)` / `page.play(id, opts)` for the action lane; with `--client node`, `page.main` (a socket.io client with `request` and `joinVoice`), `page.game` and `page.startProbes(ms)`.
- **Ladder bar** (collapse and squeeze): the server steps down once queueing has held 1 s as it sees it, and the first FRAME at the new rate leaves within 1.25 s of that onset.
