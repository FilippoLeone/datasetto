# Fuseyard: game specification on the Arcade platform

Fuseyard (game id `fuseyard`, spec `docs/arcade/fuseyard.md`) is a grid arena for 2–4 fighters. They drop fuse bombs that burst in a cross, and the last one standing wins the round.

- **Offline:** against bots, on the device, with no server (platform §12).
- **Online:** voice-channel members opt in through a lobby, bots fill the empty seats, and the server runs the match (platform §8).
- **Delivery:** Fuseyard ships in platform phase 1 and is the game that proves the action lane (platform §19).

The fighters are four lantern-headed **Wicks**:

| Slot | Wick | Colour | Hat |
|---|---|---|---|
| 0 | Ember | red-orange | flame tuft |
| 1 | Tide | blue | sailor cap |
| 2 | Fern | green | leaf sprout |
| 3 | Dusk | purple | crescent hood |

This version adapts the standalone spec to `docs/arcade/platform.md`. The rules and the feel are unchanged. Networking, authority, messages, rates, lifecycle, offline mode, persistence and UI follow the platform. No new measurements were taken for it: every byte figure is computed from the platform's overhead model (§5.1) and checked against the r1–r6 results the platform cites.

## 0. What changed from the standalone spec

| Topic | Standalone spec | On the platform | Why |
|---|---|---|---|
| Code location | `games/fuseyard/sim`, `games/fuseyard/bots` | `server/src/arcade/core/fuseyard/`, imported by the client as `@arcade/core/fuseyard/…` | platform §3.1 |
| Kinds | `const enum` | `as const` objects plus union types | `isolatedModules`, tsx (platform §3.1) |
| Wire | own types `0x01`, `0x10`, `0x11`, `0x12` | platform envelope: UP, FRAME, KEYFRAME, WELCOME, PHASE | one transport, one pacer |
| Input batch | the last 6 inputs every 2 ticks (redundant), 10 B | n = ticks since the last UP, normally 2; UP is 9 B | TCP does not lose UPs |
| Snapshot | 27 B, one encode per recipient | 22 B body encoded once per send slot; `ackUp` lives in the FRAME header | cheaper on the server |
| Event ticks | one tick per event block | events from several ticks share one FRAME, separated by a platform `At` mark | the ladder sends every 2–6 ticks |
| Rates | 15 Hz, 10 Hz under pressure | the ladder: 15, 10, 7.5, 5 Hz | platform §6.1 |
| Disconnect | autopilot after 3 s | **ghost** (frozen, invulnerable), entered through a danger lock; a bot after the grace | platform decision; "lag killed me" |
| Hidden client | `watching=false` | VIS 1, parked `away`, ghost | platform §5.2, §6.2 |
| Round end | last one standing | ghosts excluded; freeze and hold rules (§1.7) | a ghost never wins, and a bot never wins against one |
| Preact | `phase`, `seats` and `scores` signals | no game signals; lobby from `arcadeLobby`; cards drawn on the canvas; the match-end menu is DOM owned by the module | platform §10.1 |
| Canvas | 240 × 224 buffer, scaled blit per frame | the backing store *is* 240 × 224, upscaled by CSS `image-rendering: pixelated` | no per-frame scaling cost |
| Soak tests | 200 matches in 60 s on demand | tick-budgeted, hard wall caps (§12) | bounded runs |

## 1. Rules

### 1.1 Board

- **Grid.** 15 × 13 cells including the border wall. Cell index: `i = y * 15 + x` (0–194).
- **Pillars.** Indestructible pillars stand on every interior cell where x and y are both even (30 in total).
- **Spawns.** Slots 0–3 start at (1,1), (13,1), (1,11) and (13,11).
- **Safe zone.** No random block is ever placed on a non-pillar cell within Manhattan distance 3 of a spawn (9 cells per spawn). This guarantees an escape from a range-2 bomb dropped on the spawn, for example (1,1) → (3,1) → (3,2).
- **Blocks.** Every other fillable cell gets a block with probability `blockDensity`, decided by the round PRNG. Special tiles are never filled.
- **Items.** Items are hidden under blocks, assigned by a seeded shuffle.
  - The counts below are for 4 fighters. With fewer fighters each count becomes `max(1, round(count × fighters / 4))`.
  - If there are more items than blocks, Spare Fuses are removed first.
  - What each block holds is hidden (§3.7).

| Item | Code | Count | Effect | Cap |
|---|---|---|---|---|
| Spare Fuse | 1 | 7 | +1 bomb at a time | 8 |
| Wide Spark | 2 | 7 | +1 blast range | 8 |
| Quick Boots | 3 | 4 | +1 speed level | 5 |
| Shove Glove | 4 | 2 | kick bombs | — |
| Clicker | 5 | 1 | bombs wait for the detonate button | — |

### 1.2 Fighters and movement

Each round a fighter starts with 1 bomb, range 2 and speed level 0.

- **Units.** Positions are integer sub-units with `TILE = 64`. A cell's centre is at `cell * 64 + 32`.
- **Speed.** Levels 0–5 move 8, 9, 10, 11, 12 and 13 units per tick (3.75 to 6.1 tiles/s).
- **Hitbox.** 48 × 48, centred. A fighter's *cell* is the cell that contains its centre.

**Each tick** a fighter's budget equals its speed. It runs `tryMove(d1)` for the primary direction. If that fails, it runs `tryMove(d2)` for the stick's minor axis, which is what lets diagonals take corners.

**`tryMove(dir)`.** `c` is the fighter's cell and `o` its signed offset from `c`'s centre on the perpendicular axis.

1. **Next cell open.** If `neighbor(c, dir)` is open: recentre on the perpendicular axis by `min(budget, |o|)`, advance along `dir` with the rest of the budget, and stop exactly on a centre if the following cell is blocked.
2. **Next cell blocked, off-centre.** If `o ≠ 0`, take `c2`, the neighbour on `o`'s side. If `c2` and `neighbor(c2, dir)` are both open, move toward `c2`'s centre by `min(budget, 64 − |o|)`. This slides a fighter off a pillar edge into the gap.
3. **Otherwise** the move fails. If both directions fail, the fighter stays and keeps its facing.

**Blocking.** Walls, pillars, blocks, steel and bombs block fighters. Other fighters never do.

**Passer mask.** A fighter whose hitbox overlapped a bomb's cell when the bomb was placed may still walk off that bomb. Its bit clears once it stops overlapping.

### 1.3 Bombs, blasts and chains

**Placing.** A fighter can place a bomb when `bombsOut < bombsMax`, its cell is floor, and that cell holds no bomb. The bomb gets a 75-tick fuse (2.5 s) and the owner's current range.

**Blast.** Flame covers the bomb cell. Each arm (N, E, S, W) then walks outward for k = 1 to range:

| Cell | Effect |
|---|---|
| Wall, pillar or steel | The arm stops; no flame on this cell. |
| Block | Flame; the block breaks; the arm stops. |
| Unexploded bomb | Flame; that bomb is queued to explode this tick; the arm stops. |
| Item | Flame; the item burns; the arm stops. |
| Anything else | Flame; the arm continues. |

- **Flame** lasts 15 ticks and kills any fighter whose cell holds it, subject to dodge grace (§3.6) and the ghost and shield rules (§1.7).
- **Chains.** Bombs whose fuse reaches 0 are queued by id, and chained bombs join the end of the queue (at most 32). The owner of the bomb that last wrote a flame cell gets credit for kills there.
- **Broken blocks** become floor at once. The item shows only when that cell's flame expires (the block is drawn crumbling meanwhile), so a block's own blast never burns its item.
- **Kick (Shove Glove).** The fighter must be pushing toward an adjacent bomb it cannot pass, centred on the perpendicular axis and clamped at its cell centre. The bomb then slides at 16 units per tick with its fuse running, and stops on the last cell before a wall, pillar, block, steel, bomb, item or live fighter.
- **Clicker.** Bombs placed while holding it get `fuse = REMOTE`. Detonate fires the oldest of them. If the holder dies or turns ghost, they get fuse 45.
- **Death scatter.** A dying fighter drops `floor(n/2)` of its collected items (at most 6) onto empty floor cells picked by the round PRNG, in the order Clicker, Shove Glove, Quick Boots, Wide Spark, Spare Fuse.

### 1.4 Special tiles

- **Belts.** A fighter on a belt is pushed 4 extra units per tick in the belt's direction, unless it is moving across the belt. A bomb resting on a belt slides at 4 units per tick and stops by the kick rules.
- **Ice.** A fighter on ice keeps moving in its facing direction without input. It can turn only at cell centres, and only into an open cell.
- **Pads** come in pairs, A↔a and B↔b. Whatever crosses a pad's centre (a fighter or a sliding bomb) jumps to the partner's centre, keeps its direction, loses the rest of that tick's budget, and gets a 20-tick cooldown. The jump is skipped when a bomb occupies the partner pad. Flames treat pads as floor.

### 1.5 Round and match flow

- **Round.** 4,500 ticks (150 s), after a 90-tick countdown.
- **Closing Time** (sudden death) starts at tick 2,700. Every 6 ticks, the next interior non-pillar cell on a clockwise spiral from (1,1) gets a warning. 30 ticks later that cell drops as steel, which kills any fighter there and removes any bomb or item. The spiral stops at the 3 × 3 around (7,6): 106 drops in 666 ticks.
- **Round end**, checked after every tick (ghost cases in §1.7): exactly one fighter alive scores 1; none alive, or two or more alive at the time limit, is a draw. A 120-tick result card follows.
- **Brawl.** First to K round wins, K ∈ {2, 3, 5}. After 2K + 3 rounds the highest score wins, and ties share the win. The arena is fixed or rotates.
- **Quickfire.** A single 90 s round (2,700 ticks). Everyone starts with 3 bombs, range 3 and speed level 1. Closing Time starts at tick 900.

### 1.6 Arenas

Each arena is 15 × 13 ASCII rows in `arenas.ts`. Legend: `#` wall, `P` pillar, `.` always-empty floor, `,` fillable floor, `B` fixed block, `^ > v <` belts, `~` ice, `A a B b` pads, `1`–`4` spawns.

| Id | Name | Theme | Density | Feature |
|---|---|---|---|---|
| `yard` | Brickyard | warm brick, dusk | 0.80 | none |
| `mill` | Rolling Mill | rust, steel | 0.70 | two belt loops around the centre |
| `pond` | Frostbite Pond | ice blue, snow | 0.65 | ice in the middle 7 × 5 |
| `garden` | Warp Garden | moss, glow | 0.75 | pads across columns 3/11 and rows 3/9 |
| `depot` | Night Depot | neon on asphalt | 0.85 | short belts, one pad pair |

### 1.7 Away fighters (ghosts) — online only

A seat whose human is disconnected, stalled, hidden, minimized or yielding to chat becomes a **ghost** (platform §9.4). Offline there are no ghosts: hiding pauses the whole game.

| Aspect | Rule |
|---|---|
| Entering (danger lock) | A ghost request takes effect at the first tick on which the fighter's cell holds no flame and lies in no footprint of a bomb with fuse ≤ 30, and at the latest after 45 ticks. Until then the fighter stands still (input 0). Hiding the app therefore never dodges a blast that is already on its way; in practice the lock resolves within one fuse. |
| Body | Frozen in place, drawn translucent with a signal icon. Belts, ice and pads ignore it. |
| Damage | Immune to flame and steel. Steel dropping on its cell moves it to the nearest floor cell without steel, bomb or flame (BFS, lowest cell index on ties). |
| Solidity | Sliding bombs pass through it. It never picks up items, and scatter never lands on its cell. |
| Bombs | It cannot place, kick or detonate. Bombs it already placed keep ticking and keep its kill credit. Its Clicker bombs get fuse 45 when it turns ghost. |
| Return | Live again at its position with a 45-tick **shield** (immune to flame and steel, drawn flickering). It gets passer bits for any bomb it overlaps. |
| Grace over | After 60 s in one episode, or 90 s cumulative in the match, a Scrapper bot takes the seat in place, with the same 45-tick shield. The owner may reclaim the seat at the next round start. |

**Round end with ghosts.** Let H be the live human fighters still alive, B the bots alive and G the ghosts alive. Ghosts never count toward last one standing and never win:

| State | What happens |
|---|---|
| G = 0 | the standard rule (§1.5) |
| G > 0 and H = 0 | the round **freezes** (fuses, flames, bots and Closing Time included) until a ghost returns or its grace ends |
| G > 0, H = 1, B = 0 | the round freezes; if no ghost returns within 150 ticks (5 s), that human wins the round |
| any other state | play on; ghosts stay frozen statues |

A frozen round resumes after a 30-tick countdown. At the time limit with ghosts alive, H + B ≥ 2 must hold (otherwise the round would be frozen), so it is a draw as usual.

## 2. Code and state

### 2.1 Files

```
server/src/arcade/core/fuseyard/        # pure, shared (platform §3.1 rules apply)
  rules.ts    constants, as-const kinds, MatchConfig, item tables
  arenas.ts   the 5 arenas as ASCII rows, parsed once into typed arrays
  sim.ts      createMatch, step, tryMove, round setup, Closing Time, ghost, shield and freeze rules
  danger.ts   danger map; shared by bots and the client's blast lanes
  bots.ts     decide(view: BotView, rng, level) → input byte
  view.ts     public world model: applyKeyframe, applyEvents, applySnapshot (client and tests)
  codec.ts    UP payload, snapshot body, event records, keyframe body, cfg; never reads `hidden`
  replay.ts   canonical dump (hash, HANDOVER, replay dumps), restore, replay ring
server/src/arcade/rooms/fuseyard.ts     MatchRuntime: input FIFOs, seat commands, dodge grace, results
client/src/arcade/fuseyard/             # one lazy chunk
  index.ts    GameModule.mount
  render.ts   static layer, sprites and HUD into the 240 × 224 canvas
  atlas.ts    sprite grids → one ImageBitmap atlas
  predict.ts  own-fighter prediction and reconciliation
  controls.ts touch overlay (built once) and the layout per orientation
  menus.ts    pause and match-end DOM, owned by the module
  sound.ts    effect recipes and the optional music loop
```

`danger.ts` is the one addition to the platform's file list: the client reuses it for blast lanes, so it cannot live inside `bots.ts`.

### 2.2 Types

```ts
// server/src/arcade/core/fuseyard/rules.ts
export const TICK_HZ = 30, TILE = 64, W = 15, H = 13, CELLS = 195;
export const FUSE = 75, FLAME = 15, REMOTE = 0xffff;
export const SHIELD = 45, GHOST_LOCK_MAX = 45, HOLD_WIN = 150, RESUME_COUNT = 30;

export const Dir = { None: 0, N: 1, E: 2, S: 3, W: 4 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];
export const Cell = { Floor: 0, Wall: 1, Pillar: 2, Block: 3, Steel: 4 } as const;
export const Special = { None: 0, BeltN: 1, BeltE: 2, BeltS: 3, BeltW: 4, Ice: 5, PadA: 6, Pada: 7, PadB: 8, Padb: 9 } as const;
export const Item = { None: 0, SpareFuse: 1, WideSpark: 2, QuickBoots: 3, ShoveGlove: 4, Clicker: 5 } as const;
export const Control = { Human: 0, Ghost: 1, Bot: 2 } as const;       // wire SeatState: 0 live, 1 ghost, 2 bot, 3 left
export const BotLevel = { Sprout: 0, Scrapper: 1, Menace: 2 } as const;
export const SeatCmd = { None: 0xff, Return: 0, Ghost: 1, BotTakeover: 2, Left: 3, Reclaim: 4 } as const;
// (each with the same `type X = (typeof X)[keyof typeof X]` line)

export interface MatchConfig {
  mode: 'brawl' | 'quickfire'; arena: ArenaId | 'rotation';
  fighters: 2 | 3 | 4; winsNeeded: 2 | 3 | 5; botLevel: BotLevel;
  seed: number;                     // u32, drawn by the server (crypto) or the device (getRandomValues), never in core
}
export interface Fighter {
  slot: number; control: Control; botLevel: BotLevel;
  x: number; y: number; facing: Dir; moving: boolean;
  alive: boolean; diedAt: number;
  bombsMax: number; bombsOut: number; range: number; speedLvl: number;
  glove: boolean; clicker: boolean; collected: Uint8Array;           // per Item
  padCooldown: number; dodgeGrace: number; doomedTicks: number;
  shield: number;                   // ticks of invulnerability left
  ghostLock: number;                // 0xff: no request pending; else ticks waited
  lastInput: number; kills: number; blocksBroken: number; deaths: number;
}
export interface Bomb {
  id: number; owner: number; x: number; y: number; fuse: number;
  range: number; slideDir: Dir; slideSpeed: number; passers: number;  // slot bitmask
}
export interface Round {
  tick: number; phase: 'countdown' | 'playing' | 'frozen' | 'resuming' | 'over'; arena: ArenaId;
  cells: Uint8Array; special: Uint8Array;
  hidden: Uint8Array;               // item under each block: SERVER ONLY, read by sim.ts and replay.ts only
  items: Uint8Array; pendingItem: Uint8Array;
  flame: Uint8Array; flameOwner: Uint8Array; warn: Uint8Array;
  fighters: Fighter[]; bombs: Bomb[]; nextBombId: number;            // preallocated pool of 32, sorted by id
  spiralIndex: number; nextDropTick: number; rng: number; winner: number;
  holdTicks: number; holdWinner: number;                             // freeze bookkeeping (§1.7)
}
export interface Match {
  config: MatchConfig; round: number; scores: Uint8Array;
  phase: 'countdown' | 'playing' | 'roundEnd' | 'matchEnd'; phaseTicks: number;
  current: Round; botRng: Uint32Array;                               // one stream per slot
  events: Uint8Array; eventsLen: number;                             // this tick's events, already in wire format (§3.3)
}
export interface StepIn {
  inputs: Uint8Array;               // 4 bytes, one input byte per slot (humans; ignored for bots and ghosts)
  seats: Uint8Array;                // 4 bytes of SeatCmd, usually all None
  grace: Uint8Array;                // 4 bytes of dodge grace, read only at round setup
}
export function step(m: Match, input: StepIn): void;   // no allocation; events land in m.events
export type BotView = Omit<Round, 'hidden'>;            // bots get no access to hidden items
```

The sim writes its events straight into `m.events` in wire format, so the runtime's `takeEvents` is a copy, not a re-encode.

### 2.3 Tick order

Slots ascending, bombs by id:

0. **Seat commands** (`StepIn.seats`): return (shield 45, passer bits), ghost request (starts the lock), bot takeover (shield 45), left (bot at the match level), reclaim (queued for the next round setup). Then each pending ghost request is checked against the danger lock.
1. **Frozen or resuming round:** advance `holdTicks`, check the exits in §1.7, and skip steps 2–12.
2. Inputs: human FIFO bytes, bot decisions; ghosts have none.
3. Detonations, then placements.
4. Movement, including kicks, belts, ice and pads (ghosts skipped).
5. Bomb slides (ghosts are not obstacles).
6. Passer masks.
7. Pickups (the lowest slot wins ties; ghosts never pick up).
8. Fuses, then the explosion queue, breaks and flame writes.
9. Deaths (ghosts and shielded fighters are immune).
10. Closing Time (steel on a ghost's cell moves the ghost).
11. Flame decay, item reveals, shield countdown.
12. Death scatter.
13. The round-end check with the ghost rules, then `tick++`.

### 2.4 Determinism

- The platform's core rules apply: no `Math.random`, `Date`, `performance`, timers, `crypto`, `for…in` or `enum`, and no `while` or `do` in `sim.ts`, `danger.ts` or `bots.ts` (platform §3.1, §13.4).
- Fuseyard adds: no `new Map`, `new Set`, `Object.keys`, `Object.values` or `Object.entries` in `sim.ts`, `danger.ts` and `bots.ts`, and the token `hidden` never appears in `codec.ts`, `view.ts`, `danger.ts` or `bots.ts`. The purity test greps for both.
- **Bounded loops.** BFS uses a preallocated `Int16Array(195)` queue, `for (let h = 0; h < tail; h++)` with `tail ≤ 195` by construction. Danger-map chain resolution is `for (let pass = 0; pass < 32; pass++) { …; if (!changed) break; }`. The explosion queue holds at most 32.
- **Integer maths only:** `| 0`, `Math.imul`, `>>> 0`. Dodge grace arrives as an integer from the server (§3.6).
- **PRNG:** mulberry32. The round stream is seeded with `seed ^ Math.imul(round + 1, 0x9e3779b9)`, and slot k's bot stream with `seed ^ Math.imul(k + 1, 0x85ebca6b)`. A takeover bot uses its slot's stream.

### 2.5 Dump, hash and replay

- **Canonical dump** (`replay.ts`): every field of `Match`, `hidden` and the RNGs included, in a fixed order; about 2.2 KB raw. One function serves three uses:
  - the golden hash: FNV-1a 32 (`core/hash.ts`);
  - HANDOVER (deflate-raw, about 0.8 KB);
  - the starting point of replay dumps.
- **Replay ring** (for the watchdog's dumps, platform §13.4):
  - a dump every 900 ticks (the last two are kept);
  - one input byte per human slot per tick;
  - seat commands and grace values as `(tick, slot, value)` records.

  The 30 s ring deflates to well under the platform's 8 KB. `restore(dump)` plus `step` over the ring reproduces the bug in a unit test. The platform's "seed + config + input ring" is not enough on its own, because seats change mid-match and the ring starts mid-match.

## 3. Online play on the action lane

### 3.1 Who decides what

| Part | Server | Client |
|---|---|---|
| `step()`: bots, PRNG, hidden items, explosions, deaths, pickups, scores | decides | — |
| Own fighter's movement | decides | predicts with the shared `tryMove` and the sim's belt, ice and pad rules |
| Own bomb press | decides | shows a ghost bomb and plays the sound at once |
| Other fighters | — | interpolated by server tick |
| Blasts, blocks, items, deaths | — | from events only |
| Dodge grace | set per human at round start from the lane RTT | — |

### 3.2 From lobby to match

1. **Create.** A voice member opens the Arcade sheet and taps Fuseyard's start card under "Play with your call", which creates the lobby with the setup they last played in a call (or the default); its Options button opens the generic setup screen, drawn from Fuseyard's catalogue entry (`meta.ts`, ≤ 1 KB in the main bundle):
   `{id: 'fuseyard', seats: [2, 4], options: [mode, arena, fighters, wins, bots]}`.
   It sends `arcade:lobby:create {ch, game: 'fuseyard', mode: 'brawl' | 'quickfire', cfg: {arena, fighters, wins, bots}}` (zod-validated, about 80 B).
2. **Discover.** Others see a passive LobbyChip, "Fuseyard · 1/4 · Join · Watch", from `arcade:lobby` and `arcade:activity`, and a Join row in their Arcade sheet. No toast, sound or change of view.
3. **Start.** The host presses Start (`arcade:lobby:start`) once at least one human is seated. Bots at the chosen level fill the rest. The server draws the seed. If the host leaves the lobby, the lowest-seated human becomes host.
4. **Connect.** When `arcade:lobby` turns live, each seated client asks `arcade:ticket {id}` and opens `/arcade/ws` with `HELLO {proto: 1, codec: {fuseyard: 1}, ticket}`. It gets WELCOME and KEYFRAME (reason 0). Watchers do the same with a spectator ticket (at most 4, d = 3).
5. **End.** After PHASE 5 the server closes the lane. Rematch goes back through the lobby: the host presses Start again, and everyone gets a fresh ticket. The lane exists only while a match does.

- **Late join.** `arcade:lobby:join {as: 'player'}` while the match runs puts the account in the seat queue. Its WELCOME carries slot `0xFF` and the *queued* flag. It watches without counting against the spectator cap. At the next round start the server gives it a free or fill-bot seat, re-sends WELCOME with the slot, then the round KEYFRAME.
- **Reclaim** after the grace works the same way, for the account's own seat.

### 3.3 Messages

All layouts are little-endian. Platform envelopes are in platform §5.2.

**Client → server**

| Message | Fuseyard payload | Bytes |
|---|---|---|
| UP `0x01` | `u8 n (1–6), n × u8 input`. Input bits: 0–2 primary dir, 3–5 secondary dir, 6 bomb press, 7 detonate press. `upSeq` is the newest input's seq; the others are `upSeq − n + 1 …`. | 6 + 1 + n = **9** with n = 2 |
| ACK, PING, VIS, RESYNC | platform only | 4, 5, 2, 2 |

There is no Fuseyard EVT: everything a fighter does is in its input bytes.

**Validation.** n outside 1–6 is dropped. A direction value above 4 reads as 0. An `upSeq` that is not newer than the last one received is a duplicate and is dropped.

**Server → client**

| Message | Fuseyard body | Bytes |
|---|---|---|
| WELCOME `0x80` | cfg: `u8 mode, u8 arena (0xFF rotation), u8 fighters, u8 winsNeeded, u8 botLevel`. Flags b0 = queued for a seat. | 47 + 5 = **52** |
| FRAME `0x81` | snapshot body: `u8 n`, then n × `{u8 slot:2\|facing:3\|moving:1\|alive:1\|ice:1, u16 x, u16 y}`, then `u8 m`, then m sliding bombs × `{u16 id, u16 x, u16 y}`. n = seated fighters. | header 8 + snapshot **22** (4 fighters, no slides) + events |
| KEYFRAME `0x82` | see below | 10 + 150 (round start) to 10 + 492 (worst) |
| PHASE `0x85` | 2 at match start; 4 at match end with a 16 B result body (`4 × {u8 roundWins, u8 kills, u8 blocks, u8 deaths}`), or on restart or overload; 5 before the lane closes | 5 + 0 or 16 |
| HANDOVER `0x86` | the deflated canonical dump (§2.5) | ≈ 0.8 KB, shutdown or overload only |
| BEAT, PONG, BYE | platform only | 3, 11, ≤ 68 |

Round-level flow (countdown, playing, frozen, round end, match end) travels in-stream as the Round event, ordered with the deaths that cause it. Fuseyard does not use PHASE 3.

**Events** (inside FRAME; the kind byte is counted in B)

| Kind | Name | Payload | B |
|---|---|---|---|
| `0x01` | BombPlaced | u16 id, u8 slot, u8 cell, u8 range, u8 remote | 7 |
| `0x02` | BombKicked | u16 id, u8 dir (bit 7 = pushed by a belt) | 4 |
| `0x03` | BombStopped | u16 id, u8 cell | 4 |
| `0x04` | Explode | u16 id, u8 cell, 4 × u8 arm length (bit 7 = ended on a block) | 8 |
| `0x05` | BlockBroken | u8 cell, u8 item (the first message that names it) | 3 |
| `0x06` | ItemTaken | u8 cell, u8 slot, u8 item | 4 |
| `0x07` | ItemBurned | u8 cell | 2 |
| `0x08` | SteelWarn | u8 cell | 2 |
| `0x09` | SteelDrop | u8 cell | 2 |
| `0x0A` | ItemDropped | u8 cell, u8 item | 3 |
| `0x0B` | Died | u8 slot, u8 killer (0xFF none), u8 cause (0 flame, 1 steel) | 4 |
| `0x0C` | Stats | u8 slot, u8 bombsMax:4\|range:4, u8 speed:3\|glove:1\|clicker:1 | 4 |
| `0x0D` | Teleport | u8 kind (0 fighter pad, 1 bomb pad, 2 ghost moved by steel), u16 slot or bomb id, u8 toCell | 5 |
| `0x0E` | Round | u8 phase (0 countdown, 1 playing, 2 frozen, 3 resuming, 4 round end, 5 match end), u8 round, i8 winner or hold winner, 4 × u8 score | 8 |
| `0xF0` | SeatState (platform) | u8 slot, u8 state (0 live, 1 ghost, 2 bot, 3 left) | 3 |
| `0xF1` | Notice (platform) | u8 code | 2 |
| `0xF2` | **At** (new platform kind) | u8 back: the following events happened at `frame.tick − back` | 2 |

The client derives three things instead of receiving them, and `view.ts` implements each derivation once:
- fuse ends, from BombPlaced's tick + 75;
- flame cells and their expiry, from Explode's arms + 15;
- Clicker bombs dropping to fuse 45, from the holder's Died or SeatState ghost.

**KEYFRAME body**

| Part | Layout | Bytes |
|---|---|---|
| Header | u8 arena, u8 round, u8 roundPhase, u16 roundTick, 4 × u8 score, u8 spiralIndex, u8 holdTicks/2, u8 flags | 12 |
| Cells | 195 × 4 bits (Floor, Wall, Pillar, Block, Steel; block contents never) | 98 |
| Items | u8 count, then `{u8 cell, u8 item \| pending << 7}` | 1 + 2 each (≤ 21) |
| Bombs | u8 count, then `{u16 id, u8 cell, u8 fuse (0xFF remote), u8 owner:2\|range:4\|sliding:1, u8 passers:4\|slideDir:3}` | 1 + 6 each (≤ 32) |
| Flames | u8 count, then `{u8 cell, u8 ticksLeft}`; above 49 flames, a 98 B map of 4 bits per cell instead | 1 + min(2 each, 98) |
| Warns | u8 count, then `{u8 cell, u8 ticksLeft}` | 1 + 2 each (≤ 5) |
| Fighters | 4 × `{u8 slot:2\|seat:2\|facing:3\|alive:1, u16 x, u16 y, u8 bombsMax:4\|range:4, u8 speed:3\|glove\|clicker\|moving\|ice, u8 padCooldown, u8 shield}` | 36 |

- **Round start:** 150 B.
- **Mid-round:** typically 200–300 B.
- **Worst case:** all pools full, 492 B. The codec asserts the 512 B cap.

The bombs entry is 6 B, not the standalone spec's 9 B, so that the worst case fits: sliding positions come from the snapshot.

### 3.4 Cadence and rates

| What | Rate |
|---|---|
| Sim | 30 Hz on both sides |
| FRAME to players | every 2 ticks (15 Hz); the ladder steps to every 3, 4 or 6 ticks |
| FRAME to spectators | every 3 ticks (10 Hz), and down the same ladder |
| UP | every 2 ticks while any input bit is set, plus one after release; every 4 ticks while the FRAME divisor is 6 (it rides in the FRAME flags) |
| ACK | at most 4 Hz, only when no UP went out in 250 ms (platform §5.2) |
| PING | 5 at start, then one every 2 s |
| KEYFRAME | join, resume, unpark, round start, resync |
| Rendering | at most 60 fps, only while a round runs or something animates |

Halving UP at the bottom of the ladder saves uplink exactly when the link is struggling, at the cost of 67 ms of input batching.

### 3.5 Server input queue

Each human slot has an 8-entry ring:

- One input is popped per tick. Duplicate seqs are dropped.
- **Empty queue:** the last direction is repeated with the press bits cleared, for up to 6 ticks, then 0.
- **Backlog:** above 4 queued inputs, the queue is trimmed to 2, and the dropped presses are OR-ed into the next kept input.
- **`ackUp`:** the seq of the newest input *applied* at or before the frame's tick. Repeated inputs do not advance it.
- **Ghosting** clears the ring, and UPs received while a ghost are dropped.

A client sending more inputs than ticks gains nothing: the trim rule caps how fast its fighter can move.

### 3.6 Prediction, interpolation and event timing

- **Own fighter.** On each FRAME the client sets its fighter to the server's position and replays its *sent* inputs with seq > `ackUp`, one per tick, through the shared step for one fighter: `tryMove`, belts, ice, pads.
  - Unsent idle ticks are not replayed, so a fighter standing still sits on the server position.
  - Errors under 32 units blend out at 25 % per frame. Larger errors snap.
  - Kicks are not predicted: a bomb blocks until BombKicked arrives.
- **Ghost bomb.** A press draws a ghost bomb and plays the place sound at once. It clears when BombPlaced arrives for that cell, or after `rtt + 200 ms`.
- **Others** render at `estServerTick − delay` through `core/net/interp.ts`, with `delay = clamp(2 × divisor × 33.3 ms + jitterP90, 100, 300)`. That is about 130 ms on Wi-Fi and 200–300 ms on 3G. Extrapolation is capped at 100 ms (3 ticks), then motion holds. The clock comes from PING and PONG.
- **World events** (bombs, blasts, blocks, items, steel) apply on receipt, at their own tick: fuse sparks and flame lifetimes are drawn from the tick in the `At` mark.
- **Remote deaths** also apply on receipt: the sprite blends to its last snapshot position over 2 frames and plays the death animation.
- **Dodge grace.** At round start the runtime sets `grace[slot] = clamp(round(rttMs / 66), 0, 4)` from the sender's smoothed lane RTT. Bots, ghosts and offline play get 0.
  - `doomedTicks` counts the ticks spent in flame, and the fighter dies once it exceeds the grace.
  - Leaving the flame resets the count, so a late dodge on a slow link still saves the player.
  - Both values are sim state and both are replay records.
- **Lag icon** over your own fighter when RTT is over 500 ms, or when FRAME flag b4 is set.

### 3.7 Hidden information

Only block contents are hidden:
- `Round.hidden` is read by `sim.ts` and by `replay.ts`.
- No codec field carries it, and BlockBroken is the first message that names an item.
- Bots receive a `BotView` without it.
- HANDOVER (the canonical dump) is the only message that includes it, and it is sent only when the match is void (restart or overload).

Everything else is public, including who holds the Clicker.

### 3.8 Pacing constants

These go in `core/net/budget.ts`, as wire bytes:

```ts
export const FUSEYARD = {
  downAvg: 2200,       // B/s per player (17.6 kbit/s); the bucket refills at 1.25 × this = 2,750 B/s
  downPeak1s: 3200,    // B in any 1 s window (25.6 kbit/s)
  upAvg: 1800,         // B/s (14.4 kbit/s)
  keyframeMax: 512,    // body
  frameTypMax: 256,    // body; for the bucket depth only
  overflowEvents: 1024,
} as const;
// bucket depth = (512 + 10 + 76) + 4 × (256 + 76) = 1,926 B, so a frame at the 1 KB overflow threshold always fits
```

- **In-flight cap at 3G.** `deliveryRate ≈ 1.7–2.2 KB/s × (0.30 + 0.08 s) + 600 ≈ 1.25–1.45 KB`.
  - Steady state has 4.5 frames in flight per 300 ms RTT, about 515 B.
  - A worst-case keyframe (578 B on the wire) fits beside them, so 3G at budget never skips a slot.
- **Unchanged frames** (new sender option `skipUnchanged`). When a slot's snapshot is byte-identical to the last one sent to that recipient and it has no events, nothing is sent. A header-only FRAME (84 B on the wire) still goes out every 500 ms, which keeps ACKs and the stall rule working.
  - This empties the countdowns, result cards and frozen rounds.
  - During play fighters almost always move, so the budget below does not count on it.

## 4. Byte budget per client

Overheads from platform §5.1: 76 B per downlink message, 80 B per uplink message, and 26 B of TCP ACK in the reverse direction per message received. Typical events are about 100 B/s of payload (≈ 6.7 B per frame) plus about 1.5 B per frame of event count and `At` marks.

**Messages**

| Message | Payload | Wire | Rate |
|---|---|---|---|
| FRAME to a player, typical | 38 B | 114 B | 15/s |
| FRAME, no events | 30 B | 106 B | — |
| KEYFRAME at round start | 160 B | 236 B | once per round |
| KEYFRAME, worst | 502 B | 578 B | resume or unpark |
| PONG | 11 B | 87 B | 0.5/s |
| UP, n = 2 | 9 B | 89 B | 15/s while moving |
| ACK | 4 B | 84 B | ≤ 4/s while not moving |
| PING | 5 B | 85 B | 0.5/s |

**Per client** (kbit/s, wire)

| Role | Down, typical | Down, worst 1 s | Up, moving | Up, idle |
|---|---|---|---|---|
| Player at d = 2 (15 Hz) | FRAME 1,710 + PONG 44 + TCP ACKs 403 B/s = **17.2** | 15 frames, a 500 B chain and a worst keyframe = **25.1** | UP 1,335 + PING 43 + TCP ACKs 403 B/s = **14.2** (14.5 after a stall, n = 6) | ACK 336 + PING 43 + TCP ACKs 403 B/s = **6.3** |
| Player at d = 6 (5 Hz, bottom of the ladder) | **7.1** | **14** | UP every 4 ticks: **6.9** | **4.2** |
| Spectator (d = 3) | **10.7** | **19** | ACKs only: **5.2** | — |
| Away or hidden (parked) | WebSocket ping only: **< 0.1** | — | **< 0.1** | — |
| Arcade closed | **0** | — | **0** | — |

All of these sit inside the platform's action-lane ceilings: 32 kbit/s average down, 40 in any 1 s, 20 up.

**3G fit: four players, all talking, cellular voice cap on (platform §2.1)**

| | Down (750 kbit/s) | Up (250 kbit/s) |
|---|---|---|
| Voice, 3 streams at 24 kbit/s with overhead | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | ~4 | ~3 |
| Table lane while in a match (probe, lobby updates) | ~1 | ~0.2 |
| Fuseyard player, worst second | 25.1 | 14.5 |
| **Total** | **177 (24 %)** | **165 (66 %)** |
| Same without the voice cap | ~490 (65 %) | **~477 (191 %: fails)** |

- **Headroom.** The 85 kbit/s of uplink headroom absorbs TCP retransmissions and RTCP.
- **Shaped bench.** On the bench's non-voice share (600 down, 100 up), Fuseyard takes 4 % of the downlink and 14 % of the uplink.
- **Against the measurements.** A typical FRAME is 114 B on the wire, half the 236 B of r4's 160 B snapshot. r4 kept chat at p50 16 ms on the same 600 kbit/s link.

**Server**

| What | Egress |
|---|---|
| One match, 4 players | 4 × 17.2 ≈ 69 kbit/s (about 15.5 MB per 30 min) |
| One match, 4 players and 4 spectators | 69 + 4 × 10.7 ≈ 112 kbit/s |
| CPU | ≤ 0.2 ms per match tick (0.6 % of one core); the snapshot is encoded once per send slot (< 5 µs), and only the 8 B header differs per recipient |
| Memory | under 200 KB per match: state 2.2 KB, replay ring ≤ 8 KB, ≤ 1 KB of pending events per recipient, a 64-entry `sentAt` ring per recipient |

**Compared with the old engine.** The old games sent about 400 kbit/s of JSON to everyone viewing the channel. Fuseyard sends 17 kbit/s to each player, 11 to each opted-in watcher, and nothing to anyone else.

## 5. Seats, grace, hidden, idle and restarts

**Seats** (platform §9.4, with the ghost rules of §1.7)

| Event | Network | Seat |
|---|---|---|
| No ACK or UP progress for 2.5 s | parked `stalled`, BEAT at 1 Hz | ghost request (danger lock) |
| VIS 1: hidden, minimized, stage collapsed, "Back to call" | parked `away`, pings only | ghost request |
| VIS 2 (chat first), or the main socket's writeBuffer non-empty for over 1 s | parked `yield` | ghost request |
| Lane closed with any code but 1000 | GONE; the resume token works during the grace | ghost request |
| Back within the grace | unpark (or resume) → KEYFRAME (reason 2 or 1) | applied at the next tick: live, 45-tick shield |
| Grace over (60 s per episode, 90 s per match) | lane closed with 4000 if still open | Scrapper bot; the owner may reclaim it at the next round start |
| Leave (lane closed with 1000) | — | at once a bot at the match's level; the seat is free for queued joiners at the next round |
| A second tab takes the seat | the old one gets 4409 | unchanged |

**Idle**
- A match ends after 30 s with no human connected (ghost seats count as not connected).
- It also ends after 120 s with no non-zero human input. That clock runs only while at least one live human fighter is alive in a playing, unfrozen round, so humans watching bots finish a round never trip it.
- Bots never keep a match alive.
- An unstarted lobby closes after 10 min. A lobby seat is held for 30 s after a disconnect.
- With no live match the scheduler stops (platform §13.1), and Fuseyard has no timers of its own.

**Restart or overload** (platform §9.6)
- **Server side.** The match sends PHASE 4 (reason restart or overload), a HANDOVER with the canonical dump (hidden items included, because the results are void), and closes the lane with 1012.
- **Continue offline vs bots.** A LocalHost restores the dump. The other humans become bots at the match's level, ghosts become live, dodge grace drops to 0, and the results do not count.
- **No usable HANDOVER.** If none arrived, or its `simVersion` differs from the client's, the client rebuilds from its view (keyframe plus events). Hidden contents are re-rolled from a local seed, giving each remaining block an item with the round's original items-per-block ratio and the standard type mix. The `collected` arrays are approximated from Stats.
- **Wait and rejoin** is offered next to it.

## 6. Offline

- **Host.** `localHost.ts` runs the same `core/fuseyard/sim` on the main thread, inside the frame callback, as a fixed-step accumulator: at most 4 steps per frame, with the backlog dropped after a stall.
- **Hidden means paused.** No frames run, audio is suspended, and the sim does not advance. Esc, P or Start opens the pause menu.
- **Rules.** No ghosts, no grace, dodge grace 0. The client has authority, with no prediction and no reconciliation, and that path has its own tests.
- **Seed** from `crypto.getRandomValues`.
- **Lobby.** The same options form, with bots only.
- **Entry points** (platform §10.6, §12): "Play solo" in the Arcade sheet, "Arcade" in the user menu (LocalHost even while online, at no server cost), and "Play offline" on the login screen, the offline ConnectionBanner and the shells' server-unreachable screens.
  - Fuseyard needs no socket, no `/api/config` and no account to start; it mounts with defaults.
  - It works with no network in the desktop and Android shells, and on the web when the chunk is already loaded.
- **Offline stats** (matches, wins, round wins, best streak) live in `localStorage` under `datasetto.arcade.fuseyard.stats.v1`. Every access is wrapped in try/catch with an in-memory fallback, and nothing is ever uploaded.

## 7. Bots

Bots run inside `step()`, so they are deterministic and behave the same on the server and offline. They see a `BotView`, which has no `hidden`.

**Danger map** (`danger.ts`, preallocated)
- It is rebuilt on every tick that has a bot, in under 50 µs with 32 bombs.
- Each cell holds `dangerFrom` and `dangerTo`, in ticks from now (0xFFFF means never).

| Source | Window |
|---|---|
| Flame | `[0, flameLeft]` |
| Bomb | its real footprint, during `[fuse, fuse + 15]` |
| Chains | a bomb in another's footprint takes the shorter fuse; up to 32 passes, stopping early when stable |
| Opponent's remote bomb | from now |
| Warned steel cell | from its drop tick, forever |

Ghosts and shielded fighters are not targets. A frozen round runs no bot code.

**Paths.** BFS over at most 195 cells, in under 20 µs. Arrival time is `dist × ticksPerTile(speed) + offset`.
- A cell is *passable* at time t when t falls outside `[dangerFrom − M, dangerTo + 2]`.
- A cell is *safe* if it is never dangerous.
- Blocks cost 3 plus a fuse when hunting, and are impassable otherwise.
- `canEscape(cell)` adds a hypothetical bomb at `cell` and checks that a safe cell is reachable in time. A bot never places a bomb unless it passes.

**Decisions.** A bot re-plans at its interval, and at once when a new bomb appears in its row or column. It takes the first rule that applies:

1. **Flee.** If danger reaches its cell or its next path cell within 30 ticks, it goes to the nearest safe cell, by a path that is passable at each arrival time.
2. **Trap.** If an opponent is in line and in range, a bomb would leave that opponent at most one safe cell, and `canEscape` holds, it places a bomb. With the glove it kicks bombs toward opponents. With the Clicker it detonates once an opponent is in the footprint and it is safe itself.
3. **Loot.** It goes for a reachable visible item within 8 cells, weighted Clicker 5, Shove Glove 4, Spare Fuse 3 (2 at 5 bombs), Wide Spark 3 (1 at range 5), Quick Boots 3 (0 at level 3).
4. **Clear.** It scores escapable cells within 10 steps as `blocksHit × 4 − dist`, walks to the best and bombs it.
5. **Hunt.** It paths toward the nearest opponent that is neither a ghost nor shielded, with blocks costed. On an open board it keeps 2–4 cells away.
6. **Wait.** It stays on the safest nearby cell.

Paths are followed with `d1` aimed at the next cell and `d2` at the one after it.

| Level | Sprout | Scrapper | Menace |
|---|---|---|---|
| Re-plan interval | 9 ticks | 3 | 1 |
| Margin M | 10 | 6 | 3 |
| Trap / kick / Clicker | none | trap only | all |
| Mistakes (`rng % 100`) | flees to the second-best cell 6 % of the time; skips items 25 % of the time | 1 % | 0 |

**Which level where**

| Seat | Level |
|---|---|
| Fill seat | the lobby's level |
| Leave | the lobby's level |
| Grace over | Scrapper, so the seat stays cautious until its owner reclaims it |

## 8. Client and UI

### 8.1 Module and state

- **Contract.** `fuseyard/index.ts` implements `GameModule.mount(el, host, opts)` and returns `{pause, resume, unmount}` (platform §3.3). It talks only to `MatchHost`:
  - remote: `onWelcome`, `onKeyframe`, `onFrame` and `onPhase` feed `view.ts`, and `sendUp` sends inputs;
  - local: the same callbacks, fed by LocalHost.
- **No game signals.** The standalone spec's `phase`, `seats` and `scores` signals are gone. The shell's `arcadeLobby` and `arcadeSession` carry everything Preact shows, and they are written only on lobby, seat and phase changes. Frames go from `laneClient` straight into the module, so VoicePage never re-renders on game traffic.
- **On the canvas:** the HUD (four Wick chips with scores and stats, the round timer, the Closing Time alarm), the round countdown, the result card, the freeze banner ("Waiting for ‹name› · 5") and the lag icon.
- **Module-owned DOM:** the pause menu (Resume, Controls, Leave) and the match-end panel (standings from the PHASE 4 body, Rematch, Leave). Both are built once and shown or hidden by class.
- **Names.** Display names come from presence by account id, through the lobby view the shell already holds. Nothing per tick.

### 8.2 Render loop and canvas

- **Loop.** `runtime/loop.ts` subscribes to `lib/frames` at `{maxFps: 60}` only while the game is visible (platform §10.3) and a round is running or something animates. A static screen draws once.
- **Canvas.** The canvas backing store is the logical size, **240 × 224**: 15 × 13 tiles of 16 px plus a 16 px HUD strip. The platform's §10.2 figure of 240 × 208 leaves out the HUD.
  - **Scaling.** The page upscales it with CSS `image-rendering: pixelated`. The CSS size is an integer device-pixel multiple, `k = floor(fit × dpr)`, used when it fills at least 85 % of the space; otherwise it is the fractional fit.
  - **Example.** A 360 px phone at DPR 3 gets k = 4: a 320 × 299 CSS px board with 21 px tiles.
  - **Cost.** The upscale happens in the compositor, so a frame costs one static-layer copy, up to 60 atlas sprites and the HUD, all at 240 × 224.
  - **Fallback.** When `CSS.supports('image-rendering', 'pixelated')` is false, the backing store is sized to `k × logical` and the buffer is blitted with smoothing off. This path allows DPR up to 3, because a cap of 2 would give 16 px tiles on that phone.
  - **Sizing.** A ResizeObserver on the stage sets the size.
- **Static layer.** Floor, walls, pillars, special tiles and blocks are baked into an offscreen 240 × 208 layer, and only cells that events change are redrawn into it.
- **Readability**
  - Your Wick has a white outline and, for 3 s each round, a bobbing "you" marker.
  - A bomb's spark speeds up in its last 30 ticks, with a red ring in the last 15.
  - **Blast lanes** (on by default on phones) tint the cells known bombs will hit within 1 s. They are computed with `danger.ts` once per sim tick, only while bombs exist.
  - If tiles would be under 18 CSS px, a one-time hint suggests rotating the phone.
  - Reduced motion removes the shake and the flicker.
- **Unmount** releases everything: the frame subscription, listeners, the gamepad timer, the AudioContext, the lane, and canvases set to 0 × 0. The platform's zero-cost test covers it.

### 8.3 Layouts

- **Phone portrait:**
  - the board on top, in the top 60 % with an 8 px gutter;
  - below it a control deck at least 200 px tall: the stick on the left, the 76 px **Pop** (bomb) button bottom right, and the 56 px **Click** (detonate) button above Pop.
  - Click is toggled by class when your Stats event changes the Clicker flag. It is never rebuilt, unlike the old d-pad, which was rebuilt 20 times a second.
- **Phone landscape** (preferred, in the existing immersive mode): the board fits the screen height and the controls sit in the side margins. If a margin is under 140 px, the controls overlay the board at 35 % opacity.
- **Desktop:** the board centred, with a key legend below it.
- **Phone extras:**
  - Wake Lock is held while a round is live and visible.
  - Android back opens the pause menu, and a second back minimizes (`useBackClose`).
  - "Back to call" minimizes to the chip "Fuseyard running · Return", which counts as away.

### 8.4 Input

Input is sampled once per sim tick into the input byte. Presses are latched between samples, so a 10 ms tap is never lost.

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Move | WASD or arrows; the newest held key is primary, the previous one secondary | left stick (dead zone 0.3) or D-pad | floating stick, or the D-pad option |
| Bomb | Space or J | A (0) | Pop |
| Detonate | K or Shift | B or X (1 or 2) | Click |
| Pause and menu | Esc or P | Start (9) | ⏸ in the HUD |

- **Keyboard.** Keys are captured only while the canvas has focus, and the `isTyping` guard applies. The push-to-talk key and the app shortcuts are never bound (platform §10.4).
- **Touch stick** (`pointer: coarse`, overlay built once at mount):
  - **Origin.** The first touch in the left zone sets it. Dead zone 12 px, radius 48 px, and dragging past the radius moves the origin.
  - **Axes.** The larger axis is primary and switches only when the other leads by 15 %. The minor axis becomes `d2` above 35 % of the radius.
  - **Pointer handling.** Pointer capture and `touch-action: none`; cancel and blur release everything.
  - **Haptics.** A 10 ms vibration on placement, Android only, off by default.
- **Gamepad.** While a round runs, it is polled inside the frame callback. On static screens (pause, result, match end), while the game is open, visible and a gamepad is connected, a 10 Hz poll timer reads Start and A; it stops when any of those conditions ends.

## 9. Art and sound

All art and sound is original and generated by code. Nothing is downloaded, traced or copied.

**Pixel art**
- **Sprites.** 16 × 16 strings of palette indices in `atlas.ts`. The four Wicks share 17 frames: walk 3 each for side, up and down (left mirrored), idle 2, death 4, cheer 2. Each Wick gets its own palette and a 16 × 6 hat overlay. Ghost and shield looks are palette swaps (translucent, flicker), not new frames.
- **Tiles** are generated per theme from seeded noise with a 6-colour palette.
- **Bombs, flames, items.** Bombs pulse over 3 frames. Flames come in 3 intensities. Items are tokens: a fuse coil, a spark star, a winged boot, a glove and a button.
- **Font.** The platform's 5 × 7 bitmap font.
- **Atlas.** Everything is baked once into a 256 × 256 `ImageBitmap` atlas. In dev builds, `?fuseyard-atlas` shows it.

**Sound**
- **Rendering.** Effects are pre-rendered at open with an `OfflineAudioContext`: 22,050 Hz mono, under 300 KB, in under 150 ms.
- **Context.** One AudioContext per open game: created on the first in-game gesture, suspended when hidden, closed on unmount.
- **Mix.** Master volume 40 %, below voice. At most 4 explosion voices per 100 ms.

| Sound | Recipe |
|---|---|
| Place | sine 180 → 90 Hz over 80 ms, plus a click |
| Explode | noise with a low-pass swept 2,000 → 200 Hz over 400 ms, plus a 60 Hz thump; ±8 % pitch |
| Crumble | band-pass noise at 900 Hz, 120 ms |
| Pickup | square-wave major triad, 3 × 40 ms |
| Kick | noise sweep 400 → 1,600 Hz, 90 ms |
| Teleport | FM bell, 660 Hz |
| Death | square glide 600 → 100 Hz, 300 ms |
| Closing Time | 880/660 Hz alarm |

**Music.** An optional 4-channel step sequencer (two pulse, triangle, noise) plays one original 16-bar loop per theme, stored as arrays. It is off by default online and on by default offline.

## 10. Persistence and stats

Fuseyard needs no tables of its own. It uses migration 14's generic tables (platform §11), and it never touches the chip wallet: there are no stakes.

- **When.** Results are written once, at match end, in one transaction, and only for online matches with at least 2 humans (platform §11.3). Offline and solo results stay on the device (§6).
- **`arcade_results`:** `game 'fuseyard'`, `mode 'brawl' | 'quickfire'`, `channel_id`, `humans`, `started_at`, `ended_at`. The `summary` is about 150 B of JSON: `{arenas, rounds, winsNeeded, scores, draws}`.
- **`arcade_result_players`:** one row per human account that played at least one full round live.
  - `score` = round wins, `chips_delta` = 0.
  - `place` comes from the final standings; ties share a place.
  - It is NULL for a human who left or whose seat ended under a grace bot.
  - Bots get no rows.
- **`arcade_stats`** upserts per account: `matches`, `wins` (match wins, or shared wins), `round_wins`, `kills`, `blocks`.
  - A round counts for an account only if its seat was live when the round ended.
  - A match win counts only if the seat was live at the final round's start.
- **Boards** (`arcade:board {game: 'fuseyard'}`, 60 s cache):
  - all-time wins from `arcade_stats`;
  - weekly wins from `arcade_result_players` joined with `arcade_results` on `arcade_results_game_time`.
- **Device preferences** (`lib/storage`, `datasetto.arcade.prefs.v1`): stick or D-pad, blast lanes, vibration, music and volume.

## 11. Performance budgets

| Item | Budget |
|---|---|
| `step()` with 3 bots, mid-range phone or desktop at 4× CPU throttle | ≤ 0.3 ms per tick |
| `step()` per match on the server | ≤ 0.2 ms per tick; the watchdog ends a match at 20 ms once or 4 ms three ticks running (platform §13.4) |
| Bot think time | p99 ≤ 0.1 ms |
| Render | ≤ 2.5 ms; total main thread ≤ 4 ms per frame |
| Decode and apply | ≤ 0.1 ms per message |
| Allocations | none per tick or per frame: typed arrays, the bomb pool, a preallocated event buffer |
| Memory | heap ≤ 8 MB, atlas ≤ 256 KB, audio ≤ 300 KB |
| Bundle | lazy chunk ≤ 45 KB gzip (platform §3.1); main bundle: only the catalogue entry, about 200 B |
| Hidden, closed or parked | 0 rAF callbacks, 0 timers, 0 game messages beyond the WebSocket ping |

## 12. Tests and verification

Every automated run has a hard wall cap and stops as soon as its result is certain. A test that hits its cap fails with the number of ticks it completed; it never runs longer. Nothing here takes minutes. All seeds are fixed, so the statistical bot checks are deterministic regression checks, not flaky ones.

**Server (Vitest, node)**

| Suite | Checks | Cap |
|---|---|---|
| `fuseyard.rules` | blasts (arms stop at pillars, include the first block, range caps, items burn and stop the arm, a revealed item survives its own block's blast); chains in id order with kill credit; passer masks; kicks stop at every obstacle type; Clicker oldest-first, fuse 45 on death and on ghost; belts, ice, pad cooldown, blocked partner pad; draws, best-of-K, the 2K + 3 cap, the Closing Time order and its stop; safe zones, exact item counts, every arena's spawn bomb escapable at base speed, scatter | 1 s |
| `fuseyard.ghosts` | the danger lock defers inside a footprint and releases after a blast or at 45 ticks; immune to flame and steel; moved by steel; passed by sliding bombs; no pickups; every row of the round-end table in §1.7, including the 150-tick hold and the 30-tick resume | 1 s |
| `fuseyard.movement` | 2,000 random input sequences × 120 ticks: no fighter ever enters a blocked cell; exact clamping at every speed; cornering with `d2` | 1 s |
| `fuseyard.determinism` | 20 seeded Quickfire rounds with random inputs, each run twice, hash compared every 30 ticks; golden hashes at ticks 300 and 1,800 for 5 seeds, also run in the client's jsdom suite; a changed hash fails until `SIM.fuseyard` is bumped | 3 s |
| `fuseyard.codec` | every message round-trips; FRAME without events ≤ 32 B; UP ≤ 9 B at n = 2; keyframe ≤ 512 B with all pools full and ≤ 160 B at round start; WELCOME ≤ 64 B; fuzzed bytes return null and never throw | 0.5 s |
| `fuseyard.view` (delta-base fuzz) | random skipped slots, parks of all four kinds, unparks and reconnects through the real sender: after each sequence the client's `view.ts` world equals `keyframeFor()` at the same tick | 2 s |
| `fuseyard.hidden` | every frame and keyframe to every recipient is decoded: no item code for a cell before its BlockBroken; purity grep that `codec.ts`, `view.ts`, `danger.ts` and `bots.ts` never mention `hidden` | 1 s |
| `fuseyard.budget` | a recorded 4-bot Brawl round (bot inputs encoded as if human) through the sender with the §5.1 model: per player mean down ≤ 2.2 KB/s wire, worst 1 s ≤ 3.2 KB, up ≤ 1.8 KB/s; spectator mean down ≤ 1.4 KB/s | 1 s |
| `fuseyard.soak` (CI) | 60 one-on-one Quickfire rounds Menace vs Sprout, plus 12 four-bot Brawl rounds, about 100,000 ticks: no exception; every round ends by its limit; Menace wins ≥ 80 %; self-kills < 10 % of deaths for Menace and < 40 % for Sprout; median Brawl round 30–110 s; no bot stuck for 300 ticks outside Wait; think time p99 ≤ 0.1 ms (timed by the harness, outside core) | 6 s |
| `fuseyard.soak` (on demand, `SOAK=1`) | the same with 10× the rounds | 60 s |
| Lane integration (`startTestServer`, injected clocks) | 2 humans and 2 bots through a scripted round. Covers: stall 2.5 s → ghost after the lock, with SeatState seen by the other client; VIS 1 → only pings; VIS 0 → KEYFRAME reason 2 and shield; resume token within the grace keeps the slot; after 60 s a Scrapper bot, reclaimed at the next round through a re-sent WELCOME; the freeze-and-hold win; Leave → bot at once; late join queued until the round start; 30 s with no humans and 120 s without input end the match; a tick exception ends only that match; a 25 ms step ends it with "overload", a HANDOVER and a replay dump | 5 s |

The platform's §15.1 line "1,000 headless Fuseyard bot matches in under 5 s" cannot hold, and the soak above replaces it. A Brawl match is about 10,000 ticks, and at the spec's 30–100 µs per tick in Node that is 0.3–1 s per match, roughly 100 times the stated budget.

**Client (Vitest, jsdom), ≤ 2 s in total**
- **Zero cost when closed.** The platform test, with Fuseyard behind a fake host.
- **No signals.** Feeding 100 FRAMEs per second writes no signals, and 600 frames cause no child-list mutations in the touch overlay (MutationObserver).
- **Input.** Stick axis rules (15 % switch, 35 % minor axis), pointercancel, 10 ms tap latching, keyboard newest-held-is-primary, the PTT key excluded.
- **Prediction.** Predictor parity with the server on recorded inputs without kicks or pads.

**Manual, bounded** (every browser with `--mute-audio`, `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`)

| Check | Pass | Wall time |
|---|---|---|
| CDP smoke, 4× CPU throttle: 15 s offline vs 3 bots | main thread < 35 %; frame work p95 ≤ 8 ms; frame interval p95 < 16.7 ms at the 60 fps cap; no long task over 50 ms | ≤ 90 s for the whole smoke |
| Same smoke: close the game | 0 rAF callbacks, 0 Arcade timers, no `/arcade/ws` socket | (included) |
| Same smoke: minimize (Electron `window:visibility` false) | 0 rAF callbacks; the lane carries only the ping | (included) |
| Shaped bench (`ops/bench/arcade-netbench.mjs`, Fuseyard is the bench game) | platform §15.2 criteria | scenarios 1 and 2 (3G, 3G + 1 % loss) at 25 s each (5 s settle plus a 20 s window), scenario 3 (the 120 kbit/s collapse) at 45 s; under 3 min with setup |
| Android WebView: Fuseyard backgrounded | no frames drawn, and the server parked it (a WHPX access error is reported as blocked) | ≤ 1 min |
| Phone checklist | stick in both orientations, readability at 360 px, haptics, pause on app switch, the back button | by hand |

Totals: about 16 s of server tests, about 2 s of client tests, and under 6 minutes of manual checks.

## 13. What the platform must add or change for Fuseyard

1. **`At` event kind `0xF2 {u8 back}`.** The sender inserts it between the per-tick event blobs it merges into one FRAME. `takeEvents` returns the event count with the bytes, because FRAME's `nEv` needs it.
2. **Ordered PHASE.** A PHASE goes through the recipient's ordered queue, after its pending events. A recipient that unparks gets the current PHASE right after its KEYFRAME if the phase changed while it was parked.
3. **WELCOME re-sent on a role change** (queued watcher to seat, reclaim after the grace), with WELCOME flag b0 = queued. Queued watchers do not count against the 4-spectator cap. The hub keeps a seat queue and a *reclaimable* seat state (owner kept, bot in control).
4. **`MatchRuntime.ackUp(slot)`** for FRAME headers. `snapshotFor` and `keyframeFor` may return one shared buffer per tick.
5. **Ghost requests.** `setSeat(slot, 'ghost')` is a request: the sim applies it at the first safe tick (≤ 1.5 s, §1.7), and the runtime emits SeatState when it does. Platform §9.4's "at once on away, yield or close" becomes "at the first safe tick".
6. **Round end with ghosts.** §1.7's table replaces platform §9.4's sentence "if every fighter still alive is a ghost, the round pauses". That case is kept. The table adds that a bot never wins against a ghost, and that a lone human waits 5 s before winning against one.
7. **Sender option `skipUnchanged`** with a header-only FRAME every 500 ms (§3.8). Interpolation delay is derived from the divisor in the FRAME flags plus observed jitter, not from arrival gaps, so that skipped slots do not inflate it.
8. **`sender.rttMs(recipient)`** (smoothed) exposed to the runtime, for dodge grace at round start.
9. **Replay format:** a dump plus inputs plus seat and grace records (§2.5), instead of seed, config and input ring.
10. **Canvas.** A `pixelated` mode in `runtime/canvas.ts`: the backing store stays at the logical size and CSS upscales it at an integer device-pixel multiple when that fills at least 85 %. A per-game DPR cap of 3 for the fallback blit. Fuseyard's logical size is 240 × 224, not the 240 × 208 in platform §10.2.
11. **Purity grep tokens** for Fuseyard (§2.4): `new Map`, `new Set`, `Object.keys|values|entries` in `sim.ts`, `danger.ts` and `bots.ts`; `hidden` in `codec.ts`, `view.ts`, `danger.ts` and `bots.ts`.
12. **`budget.ts` constants** for Fuseyard (§3.8), with a bucket depth of at least 1,926 B, so that a frame at the 1 KB overflow threshold always fits and the bucket can never deadlock.
13. **Gamepad on static screens.** The 10 Hz poll timer in §8.4, because platform §10.4 polls only inside the frame callback, which does not run on static screens.
14. **Corrections to platform figures:**
    - §15.1's soak count (see §12);
    - §7.1's spectator line: with the §5.2 ACK rule a spectator acks at 4 Hz, so 10.7 down and 5.2 up once TCP ACKs are counted, not 9.4 and 3.4. Still far below the ceilings.
15. **Bench timing.** §15.5's scenarios 1 and 2 shrink to 25 s. The old failure showed within 22 s and a healthy link settles in under 5 s, so only the collapse scenario needs 45 s.
16. **Catalogue entry.** A generic lobby options form in the shell, driven by a per-game catalogue entry, so no game code enters the main bundle.

## 14. Milestones (all inside platform phase 1)

| # | Milestone | Scope | Done when |
|---|---|---|---|
| 1 | Offline core | movement, bombs, chains, stat items, Brawl, placeholder art, keyboard, Brickyard, a simple bot, LocalHost, rule and determinism tests | a 4-bot match finishes offline, and closing it leaves nothing running |
| 2 | Full rules | glove, Clicker, scatter, Closing Time, 5 arenas, 3 bot levels, blast lanes | the CI soak passes |
| 3 | Online | runtime, codec, view, input queue, prediction, interpolation, dodge grace, the lobby flow, ghosts and holds, late join and reclaim, HANDOVER | the codec, view-fuzz, budget and integration suites pass; the shaped bench passes |
| 4 | Controls | stick, buttons, phone layouts, pixelated scaling, gamepad | the phone checklist passes |
| 5 | Art and sound | sprites, themes, atlas, effects, music | the budgets hold at 4× throttle in the CDP smoke |
| 6 | Polish | Quickfire, the match-end panel, stats and boards, accessibility pass, the closed-game cost check | the platform's §15.6 states pass |

## 15. As built

Where the implementation fills in or differs from the sections above. Code: `server/src/arcade/core/fuseyard/` (rules, arenas, sim, danger, bots, view, codec, replay, runtime, golden), `server/src/arcade/rooms/fuseyard.ts`, `client/src/arcade/fuseyard/`.

### 15.1 Rules and state

| Topic | As built |
|---|---|
| Arena legend | A fixed block is `X`, so `B`/`b` stay the second pad pair. |
| Two fighters | Slot 1 starts on (13,11), opposite slot 0, instead of (13,1). Three or four fighters use the table in §1.1. |
| Ice | Momentum is the `moving` flag. A fighter stopped on ice moves with its input like on floor; leaving the ice without input it stops on the first floor cell. |
| Belt bombs | A bomb carried by a belt follows the belt's turns (each change is a BombKicked with bit 7) and stops where the belt ends. A kicked bomb ignores belts while it slides. |
| Sliding bombs | A live fighter who steps into a sliding bomb's cell gets its passer bit, so nobody is trapped inside a bomb. |
| Timers | Shields and pad cooldowns count down at the start of every playing step; flames, fuses and warnings during it. So every timer reads its full value after the step that sets it, and the client derives all of them from the round tick (R), which advances only while the round plays. |
| Steel under a shield | A shielded fighter is moved by steel like a ghost. |
| Bot memory | Each bot's plan (`BotBrain`) is part of the match state and of the canonical dump, so a restored match steps identically. |
| `Match` | Adds `draws`, `arenasPlayed`, `seatOut` (applied seat changes) and the `roundStarted` / `roundEnded` / `matchEnded` flags the runtime reads. |

### 15.2 Bots

The rules of §7 with these additions, each found by tracing self-kills in the soak:
- Bots leave any blast area at once (not only within 30 ticks), and only bomb from a cell that is safe now, never on ice or a belt.
- Walking about (not fleeing) uses a 30-tick margin, the same horizon that triggers a flight; a flight keeps its goal while it stays safe. Both stop a bot from dithering on the edge of a soon-to-burn cell.
- If no safe cell is reachable with the level's margin, the flight retries with none; with nowhere better to go the bot waits.
- Before dropping a bomb, the way out keeps 10 ticks to spare.
- The danger map forecasts Closing Time drops due within 5 s, places a sliding bomb's blast where it will rest (that cell counts as blocked for paths), and flags remote bombs (and the bombs they would set off) per holder: never safe to stand in, crossed only to get out of one. A bot's own remote area never blocks it.
- Pads are modelled as jumps in path searches. A bot standing still on the tick it detonates. Sprout and Scrapper detonate a Clicker bomb as soon as they are outside it, but never into someone else's bomb; Menace detonates when an opponent is in the blast.
- Menace and Scrapper also walk to a trap spot (up to 7 or 4 cells away) where a bomb would leave an opponent at most one refuge; Scrapper and Menace score bomb spots by opponents caught as well as blocks.

Soak results (CI size, seeds fixed): Menace beats Sprout in 93 % of 60 Quickfire duels; self-kills are 0–8 % of Menace's deaths and 6–9 % of Sprout's; the median four-bot Brawl round is 50–68 s; think time p99 is about 20 µs. The four-bot rounds use the lobby default (Scrapper ×4); Scrapper self-kills are about 18 %, mostly chain reactions.

### 15.3 Wire

| Topic | As built |
|---|---|
| KEYFRAME header | The 11th byte is `holdTicks` in full (u8, at most 150) while frozen, else the countdown, resume or card ticks left. Flags: winner + 1 in bits 0–2, hold winner + 1 in bits 3–5. |
| Bomb entry | `u8 owner:2 | range:4 | sliding:1`, `u8 passers:4 | slideDir:3 | belt:1` (bit 7: carried by a belt, 4 units per tick). |
| Round start | The runtime emits `roundStart`; the platform's match sends every recipient a KEYFRAME (reason 3), because each round's block layout is new. Offline the runtime also emits a `rekey` for the local seat, since a LocalHost has no round-start rule. |
| After the end | Once a match has ended, later steps do nothing and send no events (the scheduler normally stops stepping it; a LocalHost keeps ticking on the end screen). |
| View check | The client world, encoded as a keyframe, equals the server's public view after every message, except passer masks, which events do not carry (the predictor uses its own overlap rule). |
| HANDOVER, replay | The HANDOVER body is the core's raw dump; the platform deflates it (about 1 KB) and the client inflates it. The replay ring is deflated by `rooms/fuseyard.ts` (under 8 KB). |
| Bot strength | Seats filled with bots (and every bot seat) play at the lobby's Bots option. The hub's own bot level is always 1 from the Arcade sheet, so it is not used. |
| Bots in the lobby | The catalogue entry sets `hostBots: false`: every seat still empty at the start gets a bot (the definition's `botFill`), so the sheet shows no bot stepper and a lone host can start at once. |
| Offline rematch | `sendEvent([1, u32 seed])` restarts the local match with a seed from the device; online, the next match comes from the lobby. |

### 15.4 Client

- The board container is laid out per orientation (`controls.ts` `layoutFor`); the platform's touch overlay is moved above the board (35 % opacity) when the landscape margins are under 140 px.
- Online input: one input per 30 Hz tick; only ticks that go out in an UP (while anything is held, plus one after release) enter the batch and the predictor, so a batch is always consecutive ticks. Only reconciliation differences are blended; the predictor's normal advance is not.
- Music is an 8-bar loop per arena (rendered once by the platform's audio module, about 1 MB of samples); effects stay under 300 KB.
- Offline stats: `datasetto.arcade.fuseyard.stats.v1` = `{matches, wins, roundWins, bestStreak, streak}`; device options in the game's pref slot `{lanes, music}`.
- Restart: after PHASE 4 (restart or overload), a HANDOVER and close 1012, the module shows "The server restarted". If the HANDOVER is from this sim version, "Continue vs bots" restores it (`sim.ts` `takeOverOffline`: the player keeps its fighter, a ghost returns with the usual shield, every other human becomes a bot at the match's level) and swaps the closed lane for a LocalHost the module owns; the continued match does not count toward device stats. Without a usable HANDOVER only Leave is offered; rebuilding the match from the client's view (§5) is not implemented.
- Returning from "Back to call", the stage was out of the page and focus fell to the body; the module takes focus back on resume (unless the chat box has it), so the keys work at once.
- Under Vitest every imported binding is read through a getter; the hot core modules copy their imports into module-local constants, which made the sim about five times faster in tests (no effect in Node or the browser build).

### 15.5 Online tests and checks

- `deltaFuzz.test.ts`: the platform's delta-base fuzz with Fuseyard's runtime, 500 schedules from match states recorded across four matches (half on result cards, so about 34 schedules cross a round start), scripted human inputs and seat changes (ghost, return, bot, leave, reclaim). The fuzz hands decoders only keyframe bodies and event sections, not FRAME ticks or snapshots, so it compares what both carry (board, items, bombs, seats, lives, powers, phase, round, winners, scores); `view.test.ts` keeps the byte-exact check, timers and positions included, through a stand-in sender that knows each FRAME's tick.
- `budget.test.ts`: a recorded 4-bot Brawl round on Night Depot (60 s) through the real sender for four players and a spectator with the §5.1 wire model: player down 1.6–1.7 KB/s mean and 2.17 KB worst second, up 1.0–1.5 KB/s, spectator 1.1 KB/s; the pacer stays at divisor 2.
- `lane.int.test.ts`: the real server, Fuseyard's definition, a fake clock and real sockets. Covered: decoded frames and movement, stall → ghost seen by the other player, away (pings only) and back (keyframe reason 2, shield), resume within the grace, restart (PHASE 4, a HANDOVER that restores), grace over → Scrapper bot, reclaim at the next round start (re-sent WELCOME, keyframe reason 3), Leave → bot at once, a late joiner seated at the round start, the 120 s no-input end, and no item under an unbroken block in any message. A lone live player in a two-fighter match wins each round after the 5 s hold while the other is a ghost, so the grace test uses three humans. The 30 s no-human end, exceptions and overload are covered by the platform's probe tests.
- The heavier tests cap this process's CPU time rather than wall time (`test/arcade/fuseyard/cpu.ts`): the full suite runs dozens of files in parallel forks, and wall time there says more about the machine than the test.
- Bench plugin `ops/bench/games/fuseyard.mjs`: the shaped client, one Node player (lobby host, real inputs) and two server bots. Fuseyard skips unchanged FRAMEs, so scripted Node players that stand against walls or blow themselves up make the frame counts dip for reasons that have nothing to do with the link; server bots keep the board moving.
