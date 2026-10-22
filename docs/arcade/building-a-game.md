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
