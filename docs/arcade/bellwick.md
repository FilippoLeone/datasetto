# Bellwick: The Silent Bells

Code id `bellwick`. This is the game spec for `docs/arcade/bellwick.md`, fitted to the Arcade platform (`docs/arcade/platform.md`). A reference like **P§6.2** points to a section of the platform document.

Bellwick is an original top-down action-adventure with two modes:

- **Solo Tale**: one hero, run on the device, with no server, no network and no account.
- **Party Tale**: co-op for 1–4 heroes from one voice channel, run by the server. Joining is opt-in.

The bells of Kettlebrook have gone silent, and the Gloam, a mist, is creeping out of Gloamwood. Elder Hesper sends Wren, the lamplighter's apprentice, to the Drowned Bellhouse, where Old Clapper, the first bell, has swallowed the chime. In Party Tale each hero wears a tunic colour (teal, plum, mustard or sky) and a name pin.

All numbers below are computed from the layouts in this document, using the platform's per-message overheads (P§5.1). Nothing was measured for this adaptation.

## 0. Changes from the first draft

| Area | First draft | Now | Why |
|---|---|---|---|
| Transport | "unreliable newest-wins stream plus reliable events" | The action lane `/arcade/ws`: UP and EVT going up, FRAME, KEYFRAME and PHASE coming down (P§4, P§5) | One transport for both action games. Newest-wins comes from pacing, not from dropping packets. |
| Budget | 24 kbit/s down, 3 up, payload only | Wire rates with framing: 19 typical, 28 peak and 32 in the worst 1 s window down; 16.4 up | Per-message overhead dominates (P§5.1) |
| HeroState | 14 B, with its own seq and seenTick | UP payload of 10 B (UP is 16 B). The seq moves into the envelope, a `heroTick` is added, and iframes are kept on the server. | The server needs the hero's own clock to validate moves. Hit claims carry their own seenTick. |
| Snapshot | Heroes at 8 B, entities at 7 B, projectiles and pickups included | Heroes at 6 B and entities at 5 B, in pixels. Projectiles and pickups travel only as events. At most 91 B. | Absolute snapshots carry only what moves. Pixel precision is all the 192 × 160 back buffer can show. |
| RoomInit | ≤ 220 B, no tiles | The KEYFRAME body carries the room's current tile grid. Typically 141 B, capped at 384 B. | Map edits stay safe on shells that do not auto-update (§4.5) |
| Hit claims | One per target | One per swing, listing up to 8 targets | Fewer messages; overhead is per message |
| Hidden | `Rest` and `Rejoin` messages | VIS 1, then VIS 0 and a KEYFRAME with reason 2 | Platform (P§6.2) |
| Grace | 60 s after a disconnect, 10 min resting | The same values, through the platform's seat grace plus a per-game away limit (§15, item 1) | |
| Saves | localStorage, or a `bellwick_saves` table | `arcade_saves` (migration 14): 3 slots of at most 4 KB | P§11.1 |
| Flag ids | A sorted, generated table | An append-only id table with a lock file | Sorting shifts every id after an insertion and corrupts old saves |
| Enums | `const enum` | `as const` objects plus union types | P§3.1 |
| Moth Wisp path | Not specified | An integer sine table | `Math.sin` is not guaranteed to be bit-identical across JavaScript engines |
| Bundle | 80 KB gzip, +2 KB main | 60 KB gzip, nothing added to the main bundle beyond the shell's registry entry | P§3.1 budgets |
| Tests | A 60 s browser run, 100,000-tick soaks | Virtual-time suites taking ≤ 8 s of wall time; one real shaped run of 2 × 45 s plus a 15 s trace, ≤ 3 min in all | The owner asked for short verification runs (P§15) |
| Server step | 0.2 ms per room | 0.1 ms p99 per room, and at most 3 Bellwick sessions server-wide | Fits the platform's 2 ms per tick for all matches (P§13.2) |

## 1. Rules and content

The game design is unchanged from the first draft.

### 1.1 Units

- **Tick rate**: the simulation runs at 30 ticks/s. Rendering is interpolated and capped at 60 fps (30 with battery saver).
- **Positions**: integers in 1/16 px ("sub"), local to the room. A screen is 3072 × 2304 sub.
- **Screens**: 12 × 9 tiles of 16 px, plus a 16 px HUD, for a 192 × 160 logical canvas.
- **Health**: hp counts half hearts. A slash deals 2.

### 1.2 Hero and combat

| Action | Rule |
|---|---|
| Move | 8-way at 32 sub/tick (22 per axis on diagonals). Facing is 4-way, along the dominant axis. |
| Slash (A) | Lasts 10 ticks. A 14 × 10 px box in front is live on ticks 2–5. Movement is locked for 8 ticks. Deals 2. Cuts bushes, grass and thorns. |
| Spin | Hold A for 18 ticks to charge (you walk at 16 sub/tick meanwhile). Release for a 12-tick spin of radius 22 px that deals 4. |
| Interact | A interacts instead of slashing when a chest, sign, NPC, lantern or counter is within 6 px ahead. |
| Hurt | Hero: knocked back at 48 sub/tick for 5 ticks, then 45 ticks of invincibility. Enemy: knocked back at 64 sub/tick for 4 ticks, then 10 ticks of invincibility. Walls stop knockback. |
| Push | Pushing for 15 ticks slides a block 16 px over 16 ticks, if the target tile is free. |
| Pit / ledge | A pit costs 1 half heart and returns you to the room entry. A `v` ledge can only be hopped going south. |

Heroes pass through each other. Enemies that overlap separate at 8 sub/tick.

### 1.3 Items, hearts, glints

Items are party unlocks: once anyone finds one, every hero has it. Swap changes the B item.

- **Rootsword**: in a chest in Hesper's house, within the first minute.
- **Bark Buckler** (hold B; sold at Pell's Sundries): halves your speed and blocks pebbles, notes and shockwaves from the front. Blocked pebbles bounce back at enemies. It is needed to get past the Pebble Sentinels, which fire across Gloam Gate every 20 ticks.
- **Vinehook** (tap B; found in the Hook Vault): travels at 96 sub/tick, reaches 64 px, cooldown 10 ticks.
  - A hook post pulls you over pits and water, and you are invulnerable meanwhile.
  - A pickup is pulled to you.
  - An enemy is stunned for 45 ticks. A Shellback flips over for 120.
  - A crystal switch toggles.
  - In phase 3 it rips out the boss's clapper.

**Hearts.** Max hp = 6 + 2·vessels + 2·floor(shards/4) half hearts. The cap is 6 hearts, reached with 8 shards and the one Heart Vessel.

**Drops** from grass and bushes:

| Drop | Chance |
|---|---|
| Nothing | 70 % |
| 1 glint | 20 % |
| A heart (only if someone is hurt) | 8 % |
| 5 glints | 2 % |

Pickups last 300 ticks.

**Glints** come as chips (1), sparks (5) and stars (20). They go into a shared purse that holds up to 500. Glints exist only inside a save. They are not Arcade chips, are never converted, and nothing can be bought with real money.

**Shop**: Buckler 30, Hearthbrew 20 (refills one hero; each hero carries at most one), heart shard 80. Hesper's gift (5) plus the chests on Windmill Hill (10) and in the Rocky Rise cave (20) guarantee enough glints for the Buckler.

### 1.4 Overworld (20 screens and 3 interiors)

```
         x=0            x=1             x=2               x=3           x=4
y=0  Hollow Oaks    Log Tunnel      Bellhouse Shore   Old Shrine*   Cliff Lookout
y=1  Wood's Edge    Mossy Path (L)  Gloam Gate        Stone Ring    Hermit Glade*
y=2  Windmill Hill  Crossroads      North Meadow      Rocky Rise    Broken Bridge
y=3  Millpond*      West Lane       Square (L,start)  East Lane     Orchard
(L) lantern   * needs the Vinehook
```

**Areas**: row 3 is Kettlebrook village (Hesper's house, the shop). Row 2 is the Windmere fields (ledges, the Rocky Rise cave). Rows 0–1 are Gloamwood (thorns, the Sentinels at Gloam Gate, and the dungeon at Bellhouse Shore). The interiors are Hesper's house, Pell's Sundries and the Rocky Rise cave.

**Heart shards**

| Where | How |
|---|---|
| Millpond | Hook across the water |
| Orchard | A block maze |
| Rocky Rise cave | Two switches |
| Hermit Glade | Fennick's gift; reached by hook posts from Broken Bridge |
| Old Shrine | A hook post |
| Ossuary | In the dungeon |
| Flooded Crypt | In the dungeon |
| Shop | Buy it |

**Bonus chests**: a star at Cliff Lookout, and 2 sparks under a bush at Hollow Oaks.

### 1.5 Enemies

| Kind | HP | Hit | Behaviour | Drop |
|---|---|---|---|---|
| Burrlet | 2 | 1 | Hops 1 random tile every 30–60 ticks | chip 30 % |
| Snapjaw | 4 | 2 | Patrols. If a hero is in a clear line on its row or column within 6 tiles, it charges at 64 sub/tick and is stunned for 30 ticks when it hits a wall | chip 30 %, heart 10 % |
| Slingkin | 4 | 1 | Keeps 3–5 tiles away, lines up and throws a 48 sub/tick pebble every 75 ticks | chip 40 % |
| Shellback | 6 | 2 | Slow. Frontal slashes clink and push you back 8 px. Once hooked it flips over for 120 ticks and takes ×2 damage | spark 50 % |
| Moth Wisp | 2 | 1 | Flies over pits and water on a sine path (a 64-entry integer table in `content/sine.ts`); retreats for 40 ticks after contact | 2–5 chips |
| Rootling | 4 | 2 | Hides under a sprout. With a hero within 3 tiles it shakes for 15 ticks, lunges 2 tiles, stays exposed for 45 ticks and hides for 60 | heart 20 % |
| Bell Bat | 2 | 1 | Roosts, and swoops on a fixed 36-tick arc at heroes within 5 tiles | chip 30 % |

- **Targeting**: enemies go after the nearest active hero by Manhattan distance. Ties go to the lowest slot. Resting heroes are ignored.
- **Overworld respawn**: enemies come back when an empty room is activated again (§2.2).
- **Dungeon**: cleared rooms stay cleared until every hero has left the dungeon.

### 1.6 Dungeon: the Drowned Bellhouse (13 rooms)

```
        x=0            x=1                  x=2                x=3
y=0                13 Clapper's Belfry
y=1                12 Antechamber (L)
y=2   9 Ossuary    8 Bell Rope Hall     10 Clockwork Room  11 Flooded Crypt
y=3   5 Chapel     4 Great Nave         6 Switch Gallery   7 Hook Vault
y=4   2 Cistern    1 Entry Hall (L)     3 Belfry Stair
```

| Room | Exits | Contents |
|---|---|---|
| 1 Entry Hall | N4, W2, E3, S out | Lantern, 2 Burrlets |
| 2 Cistern | E1 | 2 Snapjaws, **key A** |
| 3 Belfry Stair | W1 | 3 Bell Bats; pushing a block reveals the **Map** |
| 4 Great Nave | S1, W5, E6 locked (L1), N8 locked (L2) | 3 Burrlets, a Slingkin |
| 5 Chapel | E4 | 2 Shellbacks; clearing them reveals **key C** |
| 6 Switch Gallery | W4, E7 behind a shutter | 2 blocks on 2 switches open the shutter; the **Compass** |
| 7 Hook Vault | W6, N11 over a hookable pit | 2 Moth Wisps, the **Vinehook** |
| 11 Flooded Crypt | S7 | 2 Rootlings, hook posts, **key B**, a heart shard |
| 8 Bell Rope Hall | South ledge: S4, W9. North ledge (by hook): E10 locked (L3), N12 | A central pit |
| 9 Ossuary | E8 | 3 Rootlings, a heart shard |
| 10 Clockwork Room | W8 | 2 Slingkins; hooking a crystal switch extends a bridge to the **Boss Key** |
| 12 Antechamber | S8, N13 boss door | Lantern, 3 heart pots |
| 13 Clapper's Belfry | S12 | The boss |

**Keys**

- Keys hang on a shared ring. A key opens one door, and that door stays open (a world flag).
- Keys A and C come before the hook and fit L1 and L2 in either order. The hook is behind L1. Key B and door L3 are behind the hook.
- No order of spending keys can soft-lock the dungeon, and a solver test proves it (§13, test 3).

**Map and Compass**: the Map reveals every room. The Compass marks the boss room and the chests not yet opened.

### 1.7 Boss: Old Clapper

A 32 × 32 bell golem with HP 24 + 12·(n−1), where n is the number of heroes in the room when the first one enters. Heroes who arrive later do not rescale it. Contact deals 2.

| Phase | HP | Attacks | When it can be hurt |
|---|---|---|---|
| 1. Toll | above ⅔ | Hops near a hero, shows a shadow for 20 ticks, then slams. The slam sends out a ring at 48 sub/tick that deals 2; the Buckler or invincibility frames stop it. | While stuck for 45 ticks after each slam |
| 2. Peal | above ⅓ | Rolls along the walls. Fires 3 blockable notes every 60 ticks. Summons 2 Bell Bats every 240 ticks, at most 4 alive. | While dizzy for 60 ticks after every 3 laps |
| 3. Cracked | below ⅓ | Chases at 20 sub/tick | Only while the clapper is out: hooking it pulls it out for 90 ticks, during which the boss stops and takes ×2 damage. Otherwise slashes do nothing. |

On defeat it drops the Heart Vessel and sets `boss_down`. Allies can always enter the boss room, and a wipe resets the fight.

### 1.8 Saves, death, revival

- **Lanterns** are save points. Touching one sets the respawn point and saves. Shared progress also autosaves 2 s after any change.
- **Downed.** At 0 hp a hero becomes a flame.
  - An ally standing within 16 px for 60 ticks revives them with 4 half hearts and 45 ticks of invincibility.
  - A hero not revived within 600 ticks respawns at the lantern with max(6, ceil(maxhp/2)) half hearts. "Rest at the lantern" (EVT `Respawn`) does this at once.
- **Wipe.** When every hero who is not resting is downed, they all respawn at the lantern. Active rooms reset their enemies, a boss fight resets, and cleared dungeon rooms stay cleared. Progress is never lost.
- **Solo.** There is no ally to revive you, so "Rest at the lantern" is offered as soon as you go down.

## 2. Co-op rules

### 2.1 Shared and per-hero state

- **Shared** (the server owns it): flags, purse, keys, Boss Key, Map, Compass, items, shards, vessels, the respawn lantern, boss state and cleared rooms.
- **Per hero**: room, position, facing, action, hp, invincibility, status (active, downed, resting, in transit), Hearthbrew, tunic and stats.

### 2.2 Screens and active rooms

- Heroes roam freely, one screen each.
- A room **ticks** while it holds at least one active or downed hero, which is at most 4 rooms per session.
- A room that empties is **frozen** for 5 s: kept in memory but not stepped. If someone comes back within the 5 s, it carries on. After that it is freed and only its flags are kept. This stops a hero who dithers on an edge from farming respawns, and frozen rooms cost no CPU.
- A room whose heroes are all resting is frozen as well.
- Allies show as map pins, from a roster sent once a second (§4.4).
- At a lantern, "Go to ally" warps you next to an ally.
- A joiner spawns next to the hero who has been in the session longest (P§9.2).

### 2.3 Opt-in

- The host, a voice member, starts Party Tale from the Arcade sheet and picks a new tale or one of their 3 save slots.
- Other voice members see a passive LobbyChip, "Bellwick · party 2/4 · Join" (no Watch: there are no spectators in v1). Nobody's view changes until they press Join (P§9.2).
- A running session stays joinable as a player until it has 4 heroes.
- People who turned on "Hide Arcade", or the per-game Bellwick toggle, see no chip.

### 2.4 Presence

Heroes are keyed by account id (P§9.1). A newer connection for the same seat takes it over, and the older one gets BYE 4409.

| Event | What happens | Platform mechanism |
|---|---|---|
| The lane drops (tunnel, app killed, Wi-Fi switch) | The hero rests: at once when the socket closes, or after 2.5 s without ACK or UP progress | P§6.2 `stalled`; seat state `ghost` = Resting |
| Back within 60 s | Restored exactly, with a KEYFRAME (reason 1) of the hero's room | Resume token (P§4.1) |
| Gone for more than 60 s | The hero leaves the session. The save keeps their tunic and stats. | Seat grace over |
| Game hidden or minimized, "Back to call", or the "chat first" yield | The hero rests. The lane is parked and receives no frames. | VIS 1 or 2: `away` or `yield` |
| Resting for 10 minutes while hidden | The hero leaves (BYE 4000) | Per-game away limit, a platform addition (§15) |
| Visible, but 3 minutes without input | The hero rests on the server. Any input wakes them. | Rule inside the runtime |
| No hero is active anywhere | The session does no work per tick | `MatchRuntime.idle`, a platform addition (§15) |
| 5 idle minutes (no input from anyone), 60 s after the last hero leaves, or the host ends it | The session saves and ends: PHASE 4, then 5 | P§9.5 |
| The host leaves | The host role passes to the longest-present hero. The tale keeps saving into the original owner's slot. | Hub |

## 3. Code, simulation and authority

### 3.1 Where the code lives

```
server/src/arcade/core/bellwick/          # pure, shared (P§3.1); imported as @arcade/core/bellwick/… in the client
  rules.ts            HERO_RULES, TILE_FLAGS, ENEMY_STATS, BOSS_RULES (as const); RULES_HASH (§3.6)
  content/
    overworld.txt.ts  interiors.txt.ts  bellhouse.txt.ts   # export default String.raw`…` (15 KB of maps)
    legend.ts  flags.ts (append-only ids)  flags.lock.json  text.ts  art.ts  music.ts  sine.ts  walkthrough.ts
    parse.ts          # about 150 lines; runs once per server process and once per client chunk load
  sim/  hero.ts room.ts party.ts ai.ts boss.ts collide.ts
  bots/ hero.ts       # walkthrough bot ("Pip"); BFS and A* over fixed-capacity queues
  codec.ts            # UP, EVT, snapshot, events, keyframe, roster, save
  replay.ts
server/src/arcade/rooms/bellwick.ts      # MatchRuntime: party, active rooms, validation, rewind rings, autosave
client/src/arcade/bellwick/              # lazy chunk; implements GameModule (P§3.3)
  index.ts online.ts offline.ts render.ts camera.ts hud.ts dialogue.ts menu.ts audio.ts controls.ts
```

**Rules for the core** (enforced by the platform's purity test, P§15.1):

- No `enum` or `const enum`; `as const` objects with union types instead.
- No DOM or Node APIs. No `Math.random`, `Date`, `performance`, timers, `crypto` or `for…in`.
- No `while` or `do` in `sim/` or `bots/`. Every loop is a `for` over a pool length or a fixed capacity: per room, 12 enemies, 12 projectiles, 12 pickups and 6 blocks; ray casts of at most 12 tiles; bot BFS over at most 36 rooms × 108 tiles.
- Integer state only. Distances are compared squared, and the Moth Wisp's sine comes from an integer table.
- RNG: `xorshift32` from `core/rng.ts`, one per room, seeded with `fnv1a(partySeed, roomId, activationCount)` from `core/hash.ts`. The party seed is injected: by the server (from `crypto.randomInt`) online, and from `crypto.getRandomValues` in the client runtime offline.
- Maps are TypeScript modules wrapping `String.raw` template literals, so neither tsx, tsc nor Vite needs a text loader. The content test asserts that no map contains a backtick or `${`.

### 3.2 Simulation

- **Step functions** allocate nothing and write events into a reused buffer:
  - `stepHero(h, buttons, room, party, out)` runs offline, and in the client for your own hero online;
  - `stepRoom(room, heroes, party, out)` runs everything else: offline in the client, online on the server.
- **Collision**:
  - Tile flags are `SOLID`, `WATER` (blocks walkers only), `PIT`, `LEDGE_S`, `CUT` and `HOOKABLE`.
  - The feet box is 10 × 8 px. Movement resolves X first, then Y.
  - An overlap of 5 px or less nudges the hero 1 px per tick around the corner.
- **AI**: each enemy is a state machine on integer timers, `(ai, aiT)`. Line of sight is a ray cast along the row or column.

### 3.3 State model

```ts
export const Act = { Idle: 0, Walk: 1, Slash: 2, Charge: 3, Spin: 4, Shield: 5, Hook: 6, Push: 7,
  Hurt: 8, Pulled: 9, Ledge: 10, Downed: 11, Resting: 12, Transit: 13 } as const;   // fits 4 bits
export type Act = (typeof Act)[keyof typeof Act];
export type Dir = 0 | 1 | 2 | 3;                    // down, up, left, right
export type Dir8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;   // projectiles
export type RoomId = number;                        // u8: 0–19 overworld, 20–22 interiors, 32–44 dungeon (room n = 31 + n)
export type Buttons = number;                       // u8 bits: up down left right A B swap menu
export const Status = { Active: 0, Downed: 1, Resting: 2, Transit: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

interface Body { x: number; y: number; facing: Dir; iframes: number; kbDx: number; kbDy: number; kbT: number }  // sub
export interface Hero extends Body { slot: 0 | 1 | 2 | 3; tunic: 0 | 1 | 2 | 3; room: RoomId; act: Act; actT: number;
  hp: number; item: 0 | 1; brew: boolean; status: Status; downedT: number; reviveT: number; heroTick: number }
export interface Enemy extends Body { id: number; kind: EnemyKind; hp: number; ai: number; aiT: number; homeX: number; homeY: number }
export interface Projectile { id: number; kind: number; x: number; y: number; dir: Dir8; t0: number; ttl: number; fromHero: boolean }
export interface Pickup { id: number; kind: PickupKind; x: number; y: number; ttl: number; flag: number }
export interface Block { id: number; tile: number; moveT: number; dir: Dir }
export interface Room { id: RoomId; tick: number; rng: number; activation: number;
  tiles: Uint8Array;                                 // 108 current tile codes (cut, opened, pressed)
  switches: number; nextId: number; enemies: Enemy[]; projectiles: Projectile[]; pickups: Pickup[];
  blocks: Block[]; boss: BossState | null;
  ring: Int16Array }                                 // server only: 16 ticks × 14 entities × (x, y), 896 B
export interface Party { flags: Uint8Array /* 32 B = 256 flags */; purse: number; keys: number; bossKey: boolean;
  map: boolean; compass: boolean; buckler: boolean; hook: boolean; shards: number; vessels: number;
  lantern: number; playTicks: number; cleared: number /* u16 dungeon mask, not saved */ }

export type SaveV1 = { v: 1; seed: number; flags: string /* base64, 32 B */; playSec: number; imported?: true }
  & Omit<Party, 'flags' | 'playTicks' | 'cleared'>
  & { heroes: Record<string /* accountId, or 'solo' */, { tunic: number; brew: boolean; downs: number; defeats: number }> };
```

- **Account ids stay out of the sim.** The core knows slots only. The runtime maps slot to account when it writes a save, and the client maps slot to account through the lobby seats (§4.1).
- **Entity ids** are u8 (0–127), unique within a room. Pools are preallocated. Spawning past a cap is refused (P§13.4).
- **`heroes` in a save** is capped at 16 entries; the oldest is dropped. A save stays under 2 KB.

### 3.4 Map format

There is one text file per area: overworld, interiors and the Bellhouse. Each screen is a header line, then 9 rows of 12 characters, then its entities:

```
@screen 2,3 square music=village lantern=village
TTTTTT,,TTTT
T....,,....T
T.HHH,,RRR.T
T.HDH,,HDH.T
,,,,,,,,,,,,
T..*..L..".T
T.S.......*T
T....__....T
TTTTTTTTTTTT
@warp 3,3 int_hesper 5,7
@warp 8,3 int_shop 5,7
@sign 2,6 text=sign_square
@enemy burrlet 10,5
```

**Legend** (`content/legend.ts`). Each character maps to a 6-bit tile code. The codes are append-only and part of the codec contract (§3.6).

| Char | Tile | Char | Tile | Char | Tile |
|---|---|---|---|---|---|
| `.` | grass | `,` | path | `"` | tall grass |
| `*` | bush | `T` | tree | `#` | rock |
| `~` | water | `-` | shallows | `=` | bridge |
| `^` | thorns | `\|` | fence | `H` | wall |
| `R` | roof | `D` | door | `O` | pit |
| `+` | hook post | `B` | block | `_` | switch |
| `c` | crystal | `s` | sprout | `v` | ledge |
| `S` | sign | `L` | lantern | `C` | chest |
| `k` | lock | `K` | boss door | `X` | shutter |
| `p` | pot | `:` | floor | `%` | dungeon wall |

Some codes have no character and appear only as states: cut grass, an open chest, a lock that has been opened, an open shutter, an open boss door, a pressed switch, an extended bridge, a lit lantern.

- **Chests**: written as `@chest x,y item flag=<name>`.
- **Flags**: names map to u8 ids through `content/flags.ts`, which is **append-only**. A test compares it with the committed `flags.lock.json` and fails if an existing id changed. At most 256 flags.
- **Edges**: open tiles on a screen's edge must line up with the neighbouring screen.

### 3.5 Authority split

At 300 ms RTT, a hero simulated on the server would make your own sword feel late, and co-op among friends does not need hard anti-cheat. So each client owns its own hero, and everything shared or scarce stays on the server. This is the hybrid authority in P§8.

| Concern | Online | Offline |
|---|---|---|
| Own hero (movement, actions, walls) | Client; the server validates and corrects | Client |
| Damage to own hero | The victim's client reports it; the server checks it and keeps the canonical hp and iframes | Client |
| Hits on enemies, cut tiles, crystal switches | The client claims them; the server checks against its 16-tick rewind ring | Client |
| Enemies, the boss, drops, pickups, blocks, switches, doors, chests, purse, keys, flags, revival, saves | Server | Client |
| Projectiles and shockwaves | The server spawns and removes them; clients draw their straight, deterministic flight | Client |
| Dialogue, menus, music, particles | Client | Client |

**Server checks** (`rooms/bellwick.ts`):

- **Moves (UP)**:
  - Each axis may change by at most `32 × ΔheroTick + 32` sub, plus allowances the server can see: knockback it applied itself, a hook pull (96 sub/tick while `Pulled`, with a hook post in line within 64 px), a ledge hop (south only, over `LEDGE_S`) and the screen slide.
  - `heroTick` must increase, and may be at most `serverTick + 3`.
  - Swept against the server's tile grid, a feet box may not pass through `SOLID` or walker-blocking `WATER` by more than 4 px.
  - A failed check sends `Correct` with the last valid position. Three Corrects within 2 s also send a KEYFRAME with reason 5 (resync).
- **Hit claims**:
  - Each target must overlap the attack box: the slash box in front, a spin radius of 22 px, or the hook line of up to 64 px. The box comes from the hero's validated position. The target's position comes from the ring at `seenTick`, with 4 px of slack.
  - `seenTick` must be inside the 16-tick ring (533 ms) and not later than the hero's `heroTick`. The target must not be invincible at that tick.
  - One claim is accepted per swing (keyed by the start of the attack) and names at most 8 targets.
  - Cut tiles and crystals are checked against the static grid, with no rewind.
- **Damage**: the source must have been within 24 px of the hero: its ring position at `seenTick`, or the projectile's or shockwave's computed path. The hero must not be invincible (server iframes), resting or in transit. When the client's hp disagrees, the server sends `Hp`.
- **Blocked**: the projectile is alive, within 20 px in front of the hero's facing at `seenTick`, and the party owns the Buckler.
- **Interact, Push, Buy, keys, EnterRoom**: serialised per party (one event loop) and idempotent by `(accountId, matchId, evSeq)` (P§5.2). A key raced at two doors opens one of them. The other claimant gets `Refused`.

**Feel** (client side):

- The flash and sound play at once.
- **Predicted kill.** When a claim would take an enemy's last known hp to 0, the poof plays at once and the sprite is hidden. If a `Refused` comes back, or no `Despawn` arrives within RTT + 250 ms, the enemy reappears. That should be rare.
- Enemy knockback is shown as an offset that blends into the server position over 6 ticks.
- Your own hp drops immediately. The server's value wins when it arrives.
- A room change starts its 600 ms slide at once (§4.7).

### 3.6 Version contract

The platform lets action games play online with a different sim version (P§1). For Bellwick that holds only for the parts the server runs: enemies, the boss and drops. The client is authoritative for its own hero against the server's walls, so two things belong to **`CODEC.bellwick`**, not `SIM.bellwick`:

- `HERO_RULES`: speeds, boxes, timings, and the knockback, hook and ledge numbers;
- `TILE_FLAGS`: tile code to collision flags.

A test hashes both (`RULES_HASH`) and fails if the hash changes without a bump of `CODEC.bellwick`. A shell with a different codec gets close code 4426 for Party Tale, with "Update the app to play Party Tale". Solo Tale still works.

**Map edits need no bump.** Every KEYFRAME carries the room's current tile grid, and the server decides room exits (§4.5). An older shell therefore walks the server's map. Only its art, sign text and music could be out of date, and WELCOME's `contentHash` lets it say so quietly.

## 4. Networking

### 4.1 Session setup (table lane, main socket)

| Step | Event | Notes |
|---|---|---|
| Create | `arcade:lobby:create {ch, game: 'bellwick', mode: 'party', cfg: {tale: 'new' \| 'slot', slot: 0 \| 1 \| 2}}` | Voice members only. A new tale in an occupied slot asks for confirmation in the UI first. |
| List saves | `arcade:saves {game: 'bellwick'}` → `{slots: [{slot, playSec, hearts, items, members, updatedAt}]}` | ≤ 400 B |
| Join | `arcade:lobby:join {id, as: 'player'}` → `{ok, lobby, ticket}` | Also while the session runs (drop-in), up to 4. `as: 'spectator'` is refused with `no-spectators`. |
| Lobby updates | `arcade:lobby` (≤ 2 Hz, coalesced) | `seats[i].a` is the account in slot i. The game module gets names and tunics through `host.onSeats` (§15). |
| Lane | HELLO `{"t":"hello","proto":1,"codec":{"bellwick":1},"ticket":"…"}` | P§4.1 |

**WELCOME cfg** (Bellwick): `u8 taleSlot (0xFF = new), u32 contentHash, u8 n, n × {u8 slot, u8 tunic, u8 joinOrder}`, at most 18 B. No account ids travel on the lane.

### 4.2 Up: UP and EVT

**UP payload (HeroState), 10 B; the UP message is 16 B**

| Field | Type | Notes |
|---|---|---|
| room | u8 | |
| x, y | u16, u16 | sub, room-local, feet-box centre |
| packed | u8 | `facing:2 \| act:4 \| moving:1 \| charged:1` |
| actT | u8 | ticks into the current act |
| hp | u8 | the client's belief, so mismatches can be detected |
| heroTick | u16 | the estimated server tick this state is for (wrap-aware) |

**EVT payloads** (the first byte is the game event kind; EVT adds `T` and `u16 evSeq`)

| Kind | Name | Arguments | Payload | Message |
|---|---|---|---|---|
| `0x01` | HitClaim | `u16 seenTick, u8 attack (0 slash, 1 spin, 2 hook), u8 dir, u8 n (1–8), n × u8 target` (entity id < 128, or 128 + tile index for cut tiles and crystals) | 6 + n | 10–17 B |
| `0x02` | DamageTaken | `u8 source (entity id; 0xFE pit), u8 amount, u16 seenTick` | 5 | 8 B |
| `0x03` | Blocked | `u8 projectileId, u16 seenTick` | 4 | 7 B |
| `0x04` | Interact | `u8 tileIdx` (chest, NPC gift, lock, counter, lantern) | 2 | 5 B |
| `0x05` | Push | `u8 tileIdx, u8 dir` | 3 | 6 B |
| `0x06` | EnterRoom | `u8 edge (0–3, 4 = warp tile), u8 pos` (tile along the edge, or the warp tile) | 3 | 6 B |
| `0x07` | Buy | `u8 item` | 2 | 5 B |
| `0x08` | UseBrew | — | 1 | 4 B |
| `0x09` | Respawn | — (rest at the lantern now, when downed) | 1 | 4 B |
| `0x0A` | GoToAlly | `u8 slot` (only at a lantern) | 2 | 5 B |
| `0x0B` | Emote | `u8 emote` | 2 | 5 B |

Signs and plain dialogue are local and send nothing. After a resume the client resends only Interact, Push, Buy, UseBrew, Respawn and GoToAlly above WELCOME's `lastEvSeq`. Claims are dropped, because they would be older than the ring.

### 4.3 Down: FRAME snapshot body (absolute, at most 91 B)

```
u8 room
u8 nh (0–3)    nh × 6 B   other heroes in this room:
               u8 slot:2|status:2|facing:2|hurt:1|moving:1, u8 x px, u8 y px, u8 act:4|charged:1|spare:3, u8 actT, u8 hp
u8 ne (0–14)   ne × 5 B   moving entities (enemies, the boss, sliding blocks):
               u8 id, u8 x px, u8 y px, u8 pose:4|facing:2|hurt:1|stunned:1, u8 hp
```

- **Pixels are enough.** Positions are in pixels (x 0–191, y 0–143), centre of the body. The client never simulates other entities online, and the 192 × 160 back buffer cannot show sub-pixels.
- **Not in snapshots:** pickups and projectiles. They are static or follow deterministic straight paths, so they travel only as events and in keyframes.
- **Sizes:** typically 41 B (3 others and 4 enemies), 61 B in a fight (3 others and 8 enemies), and at most 3 + 18 + 70 = **91 B**.
- **Frozen rooms** have no snapshot (`snapshotFor` returns `null`). Their slots send nothing unless events are pending (§15).

### 4.4 Down: events (in a FRAME's event block)

**Room events** go to the heroes in that room.

| Kind | Name | Payload after the kind byte | Bytes |
|---|---|---|---|
| `0x01` | Spawn | `u8 id, u8 kind, u8 x, u8 y, u8 state, u8 hp` | 7 |
| `0x02` | Projectile | `u8 id, u8 kind:4\|dir:4, u8 x, u8 y, u16 t0` | 7 |
| `0x03` | Despawn | `u8 id, u8 reason` (killed, expired, blocked, collected) | 3 |
| `0x04` | Damage | `u8 target (entity id, or 0x80 + slot), u8 amount, u8 hpAfter, u8 bySlot` | 5 |
| `0x05` | Drop | `u8 id, u8 kind:4\|ttl:4, u8 x, u8 y` | 5 |
| `0x06` | Tile | `u8 tileIdx, u8 code` (cut, opened, shutter, bridge, chest) | 3 |
| `0x07` | BlockSlide | `u8 tileIdx, u8 dir` | 3 |
| `0x08` | Correct (self only) | `u8 room, u16 x, u16 y, u8 reason` | 7 |
| `0x09` | Hp | `u8 slot, u8 hp` | 3 |
| `0x0A` | Downed | `u8 slot` | 2 |
| `0x0B` | Revived | `u8 slot, u8 bySlot` | 3 |
| `0x0C` | BossPhase | `u8 phase, u8 hp, u16 tick` | 5 |
| `0x0D` | Shock | `u8 x, u8 y, u16 t0` (slam ring origin) | 5 |
| `0x0E` | Refused (self only) | `u16 evSeq, u8 code` | 4 |

**Party events** go to every hero in the session, whatever their room.

| Kind | Name | Payload | Bytes |
|---|---|---|---|
| `0x20` | Party | `u8 field (purse, keys, items, shards, vessels, lantern, maxHp), u16 value` | 4 |
| `0x21` | Flag | `u8 flagId, u8 value` | 3 |
| `0x22` | Got | `u8 slot, u8 item` (the "Ana found the Vinehook" banner) | 3 |
| `0x23` | Roster (1 Hz) | `u8 n, n × {u8 slot:2\|status:2\|tunic:2\|host:1\|lag:1, u8 room, u8 tx:4\|ty:4, u8 hp, u8 joinOrder}` | 2 + 5n ≤ 22 |
| `0x24` | Saved | `u8 lantern` | 2 |
| `0x25` | Victory | `u32 playSec` | 5 |

The platform kinds `0xF0` (SeatState: `ghost` shown as Resting, `left`) and `0xF1` (Notice) apply as in P§5.2. Events average about 3 B per frame while exploring and 6 B in fights, with bursts of up to about 40 B.

### 4.5 Down: KEYFRAME body (RoomInit)

```
u8 room, u8 entry (0 edge, 1 warp, 2 respawn, 3 join, 4 resume, 5 resync)
u16 heroX, u16 heroY (sub), u8 hp, u8 status       // your own hero, canonical
81 B tiles: 108 × 6-bit current tile codes
u8 switches, u8 roomFlags (cleared, shutter, bridge)
u8 nh, nh × 6 B   other heroes (as in the snapshot)
u8 ne, ne × 6 B   entities: u8 id, u8 kind, u8 x, u8 y, u8 state, u8 hp
u8 np, np × 4 B   pickups: u8 id, u8 kind:4|ttl:4, u8 x, u8 y
u8 npr, npr × 6 B projectiles: u8 id, u8 kind:4|dir:4, u8 x, u8 y, u16 t0
[boss room]       4 B: u8 phase, u8 laps, u8 timer, u8 clapperT
[entry 3 or 4]    40 B party block: 32 B flags + u16 purse, u8 keys, u8 items, u8 shards, u8 vessels, u8 lantern, u8 maxHp
```

| Case | Size |
|---|---|
| Typical room change (2 others, 4 enemies, 1 pickup, 1 projectile) | **141 B** |
| Typical join or resume | 181 B |
| Worst room change with full pools (14 entities, 12 pickups, 12 projectiles, boss) | 321 B |
| Worst join | 361 B |
| **Hard cap** (codec test) | **384 B** |

That is 84 B above the platform's 300 B figure (§15). Keyframes are rare: one per room change, join, resume, unpark or resync.

### 4.6 Rates and cadence

| Stream | Rate |
|---|---|
| Sim | 30 Hz on both sides |
| FRAME | every d ticks: 15, 10, 7.5 or 5 Hz on the platform ladder (P§6.1) |
| Interpolation | by server tick, delay clamp(2 × interval + jitter p90, 100, 300) ms, extrapolation ≤ 100 ms (P§8.4) |
| UP | every 2 ticks while your hero's state changed; every 3 ticks while the link is constrained (P§2.1); none while still. The client skips an UP while `ws.bufferedAmount > 512` (newest wins). |
| ACK, PING, VIS | as in P§5.2 |
| EVT | immediately; at most one HitClaim per swing (≤ 3/s); typically ≤ 2/s in fights |
| Roster | 1 Hz, as a party event |

Messages per second are about 15.5 down and at most 17.5 up, well under the lane limit of 40/s (P§4.1).

### 4.7 Routing and room changes

- Action-lane traffic goes only to session members. A room's snapshots, room events and keyframes go only to the heroes in that room. Party events go to everyone.
- **Room change:**
  1. The client sends `EnterRoom` and starts the 600 ms slide (500 ms vertical). During the slide the hero is in `Transit`: invulnerable, with enemies frozen on screen.
  2. The server checks that the hero is within 8 px of that edge and that the exit is open in its own grid. Then it moves the hero and activates (or unfreezes) the new room.
  3. The runtime asks the sender to **rekey** this recipient with reason 4 (§15). The sender drops the recipient's pending events from the old room and sends the new room's KEYFRAME as soon as the in-flight cap allows. The delta-base rule of P§6.2 is unchanged: the world is the last keyframe plus later events.
  4. A refused exit (a shutter that closed) sends `Refused` and `Correct`, and the slide plays backwards.
  5. With RTT over about 600 ms, the slide holds on its last frame with a small "…" until the keyframe arrives.
- Warps (doors, "Go to ally", respawn at the lantern) use the same rekey with entry 1 or 2. Interiors fade over 250 ms each way instead of sliding.
- Parked heroes (`away`, `yield`, `stalled`) get nothing. Unparking sends a KEYFRAME with reason 2 (P§6.2).

### 4.8 Byte budget at 3G, 4 heroes

The link is 750 kbit/s down, 250 up, 300 ms RTT, with occasional loss, in a 4-person call with the cellular voice cap (P§2.1). All figures are wire kbit/s with the P§5.1 overheads: 76 B per downlink message, 80 B per uplink message, and 26 B of TCP ACK per message received.

**Down, per client**

| Item | Calculation | kbit/s |
|---|---|---|
| FRAME, exploring (3 others, 4 enemies, 3 B of events) | 15 × (8 + 41 + 3 + 76) = 1,920 B/s | 15.4 |
| FRAME, fight (3 others, 8 enemies, 6 B of events) | 15 × (8 + 61 + 6 + 76) = 2,265 B/s | 18.1 |
| FRAME, peak (14 entities, 30 B of events) | 15 × (8 + 91 + 30 + 76) = 3,075 B/s | 24.6 |
| TCP ACKs for your UPs | 15 × 26 B | 3.1 |
| PONG | 0.5 × (11 + 76) B | 0.35 |
| Room-change keyframe | ≤ 384 + 10 + 76 = 470 B per change (about one per 15 s) | 0.25 average; 3.8 in the second it lands |
| **Total** | | **19 exploring, 22 fight, 28 peak; 32 in the worst 1 s window** |

At d = 3 (10 Hz) a fight costs about 15.6 kbit/s, and at d = 6 (5 Hz) about 9.5.

**Up, per client**

| Item | Calculation | kbit/s |
|---|---|---|
| UP while moving | 15 × (16 + 80) = 1,440 B/s | 11.5 |
| TCP ACKs for frames | 15 × 26 B | 3.1 |
| EVT in fights | 2 × (10 + 80) B | 1.4 |
| PING | 0.5 × 85 B | 0.34 |
| **Total** | | **16.4 moving in a fight**; 15.0 exploring; 6.1 standing still (ACK 4/s instead of UP); 12.5 with a constrained link (UP at 10 Hz) |

**Does it fit?** Worst case: a 3G phone in the boss room, all four people talking.

| | Down (750) | Up (250) |
|---|---|---|
| Voice, 3 capped streams (P§2.1) | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | 4 | 3 |
| Table lane for the Arcade (lobby, roster changes) | ≤ 1 | ≈ 0 |
| Bellwick | 32 (worst 1 s window) | 16.4 |
| **Total** | **184 (25 %)** | **166 (67 %)**; 162 (65 %) with UP at 10 Hz |
| Same, without the voice cap | ~497 (66 %) | ~480 (192 %: fails; this is the platform precondition) |

Both stay under the platform ceilings for the action lane: ≤ 32 kbit/s average and ≤ 40 in any 1 s window down, ≤ 20 up (P§7.1).

**Why chat is not delayed:**

- The game uses its own TCP connection, so a lost game segment never stalls chat's stream.
- The in-flight cap (P§6.1) limits what the game adds to the shared radio queue to about 80 ms × 4 KB/s + 600 B ≈ 0.9 KB, which is about 10 ms at 750 kbit/s.
- On the uplink, the 512 B `bufferedAmount` guard keeps the client's game backlog under about 20 ms at 250 kbit/s.

**Server egress per session:**

- 4 × 19 = 76 kbit/s typical, and 4 × 28 = 112 kbit/s at the peak.
- A 30-minute session costs about 17 MB.
- Three sessions at the peak come to 336 kbit/s, inside the 1.5 Mbit/s degrade threshold (P§6.5).

### 4.9 Latency

| Link | Behaviour |
|---|---|
| Wi-Fi (30 ms) | Interpolation delay about 130 ms; claims are about 150 ms old (5 ticks) |
| 3G (300 ms) | Delay about 200 ms; claims are 200 + 150 + 33 ≈ 383 ms old (11.5 ticks), inside the 16-tick ring (533 ms) |
| 3G at the bottom of the ladder (5 Hz, delay 300 ms) | Claims are about 483 ms old (14.5 ticks), still inside the ring |
| RTT over about 500 ms | The "laggy" pip shows (FRAME flag b4, or the measured RTT). Some claims arrive older than the ring and are refused (the enemy clinks). Exploring, puzzles and the shop keep working up to about 800 ms. |
| Outage | After 2.5 s the hero rests (`stalled`). Resuming costs one keyframe of at most 384 B. |

Projectiles and slam rings follow deterministic paths, so the client draws them at the **current** estimated server tick, not the interpolated past. That is the time frame in which your own hero dodges or blocks them. They are blended from the thrower's drawn position over their first 6 ticks, so they do not seem to pop out of nowhere.

### 4.10 Server runtime (`rooms/bellwick.ts`)

| `MatchRuntime` member (P§3.3) | Bellwick |
|---|---|
| `step()` | For each ticking room: `stepRoom` (enemies, boss, projectiles, pickup timers, blocks, switches), pickup collection from validated hero boxes, revive and downed timers, the wipe check, ring writes, and the autosave check (counted in ticks). Returns at once when the session is idle. |
| `onUp(slot, p)` | Decode HeroState, validate it, then store it or send `Correct`. A changed state resets the 3-minute idle timer. |
| `onEvent(slot, evSeq, p)` | Deduplicate, then dispatch §4.2 |
| `snapshotFor(r)` | The recipient's room without its own hero; `null` when the room is frozen |
| `keyframeFor(r)` | RoomInit of the recipient's room, plus the party block for join and resume |
| `takeEvents(r)` | Events of the recipient's room, party events, and its own `Correct` and `Refused` |
| `setSeat(slot, s)` | `live` → active, `ghost` → Resting, `left` → the hero leaves (their stats go into the save). `bot` is never used. |
| `handover()` | SaveV1 plus each hero's room and position (§5.3) |
| `replay()` | Full states of the ticking rooms at the start of the ring, plus the last 10 s of accepted UPs and EVTs, deflated, ≤ 8 KB (cut from the oldest end) |
| `dispose()` | Frees rooms. The final save is written before this is called. |

## 5. Lifecycle

### 5.1 Joining and leaving

- **Late join**: the joiner lands beside the longest-present hero, even in the boss room. Boss HP does not rescale.
- **Leave** (pause menu, or closing the stage): the lane closes with 1000 and the hero leaves at once. Their tunic and stats are written to the save.
- **The host's tale**: the save belongs to the host who started it (§6.1). If the host leaves, the session goes on with a new host and keeps saving into the original owner's slot.

### 5.2 Hidden, idle, grace

- These follow §2.4.
- **Pause menu online**: opening it does not pause the world in Party Tale. The hero stands still and stays vulnerable, so a menu is not a free shield.
- **Pause menu offline**: it pauses the sim.

### 5.3 Restarts, overload, admin

- **`server:restarting`** (P§9.6):
  1. The session saves.
  2. Each hero gets PHASE 4 (reason "restart") and a HANDOVER whose body is `deflate-raw(SaveV1 + {room, x, y})`, about 1 KB, not the full sim state.
  3. The lane closes with 1012.
- **The stage then offers two choices:**
  - **"Continue offline (this copy stays on this device)"** starts a Solo Tale from a local "Party copy" slot, overwritten each time; it can be copied into slots 1–3. It never syncs back.
  - **"Wait and rejoin"**: once the server is back, the host recreates the lobby from the same slot. The save holds everything up to the restart.
- **Overload** (watchdog, P§13.4) is handled the same way, with reason "overload" and a replay dump.
- **Admin** turning Bellwick off in Admin › Arcade saves each session, then ends it.
- **Chips**: Bellwick holds no chips or escrow, so there is nothing to refund.

## 6. Persistence

### 6.1 Party Tale saves (`arcade_saves`, migration 14)

| Column | Bellwick use |
|---|---|
| `owner_id` | The host who created the tale |
| `game` | `'bellwick'` |
| `slot` | 0–2 |
| `version` | 1 (SaveV1) |
| `data` | UTF-8 JSON SaveV1, zod-checked on read and on write, ≤ 4,096 B (under 2 KB in practice) |
| `members` | JSON array of the account ids that played in it, at most 16 |

- **When it writes**:
  - on a lantern touch;
  - 2 s after any change to shared progress (debounced: at most one write per 2 s per session);
  - on Victory;
  - at session end;
  - on restart, overload or admin-off.

  Each write is one upsert taking about 0.1 ms.
- `arcade:saves:delete` is refused with `in-use` while a session runs from that slot.
- **v1 limit**: only the owner can host their own slots. Members see the tale only while the owner hosts it.

### 6.2 Stats, results and the board

- **`arcade_stats`**, game `bellwick`: `clears`, `best_clear_s`, `foes`, `revives` and `downs`, updated at session end and on Victory.
- **`arcade_results`**: on Victory, one row with mode `party`, `humans` = the heroes present at the boss, and the summary `{"s": playSec, "slot": n}`. Plus one `arcade_result_players` row per hero, with `score` = playSec and `chips_delta` 0.
- **The "Bellwick fastest clear" board** reads `best_clear_s`. It counts only tales that were started online, with at least 2 humans at the boss, and not imported (P§11.3).
- **Solo and offline results** stay on the device.

### 6.3 Solo Tale saves (device)

- Stored in `localStorage` under `datasetto.arcade.bellwick.saves.v1`: an array of 3 slots plus the "Party copy" slot, each a SaveV1 of at most 4 KB.
- Every access is wrapped in try/catch, with an in-memory fallback and the notice "Saves aren't available in this window".
- **Saving**: on a lantern touch, 2 s after changes, and at once when the game is hidden.
- **Import (M7)**: `arcade:saves:import {game, slot, data}` copies a Solo Tale into an account slot with `imported: true`. An imported tale never counts for boards.

## 7. Offline mode (Solo Tale)

- **LocalHost** (P§12) runs `stepHero` and `stepRoom` for the hero's room (plus a room frozen within the last 5 s) on the main thread, inside the frame loop. It runs at most 4 steps per frame, and a backlog is dropped after a stall. Hidden therefore means paused.
- **No server needed**:
  - It starts from "Play offline" on the login screen, the ConnectionBanner, and the desktop and Android server-unreachable screens.
  - It also starts from "Arcade" in the user menu while online, which costs the server nothing.
  - It mounts with defaults: no socket, no `/api/config`, no account.
  - It works in the desktop shell (`file://`), the Android shell, and a warm web page. A cold web start does not work offline (P§12).
- **Pip (M7)**: an optional helper hero, driven by `core/bellwick/bots/hero.ts` through plain `Buttons`, the same code path as a player.
- **Offline stats** stay in `localStorage` and are never uploaded.

## 8. Client: loop, rendering, UI integration

### 8.1 Loop

- **`runtime/loop.ts`** subscribes to `lib/frames` with `maxFps: 60` (30 with battery saver) only while all of these hold (P§10.2):
  - the game is visible;
  - it is not paused (offline);
  - the stage is on screen;
  - something is dirty.
- **Paused, menus open, a dialogue fully shown, an empty still room:** the loop unsubscribes, so 0 fps. Ambient animations (water, lantern flicker) stop with it.
- **Online**:
  - your own hero steps at a fixed 30 Hz in the frame callback, drawn between its last two ticks;
  - others come from `core/net/interp` at `estServerTick − delay`;
  - projectiles and shocks are drawn at the present tick (§4.9).

  Floats appear only in render code, never in core.
- **Gamepad** polling happens only inside the frame callback (P§10.4).

### 8.2 Camera and drawing

- **Camera**: fixed per screen. A screen change slides over 600 ms horizontally or 500 ms vertically. Interiors fade over 250 ms each way.
- **Static tiles** are baked into a 192 × 144 offscreen canvas when a KEYFRAME arrives. A `Tile` event re-bakes one 16 × 16 cell.
- **Each frame** draws the bake, then entities sorted by y, then the cached HUD (hearts, purse, keys, B item, roster mini-pins, laggy pip) into the 192 × 160 back buffer. `runtime/canvas.ts` scales that to the display canvas: ResizeObserver, DPR ≤ 2, integer scaling, smoothing off.
- **Text** uses the shared 5 × 7 font. Dialogue is also written to an `aria-live` node built once.
- **Map screen** (M): drawn on the canvas from party flags and roster rooms.

### 8.3 Preact and the shell

- **Preact sees only coarse signals**: `arcadeSession.status` (connecting, live, lagging, paused, away, ended) and `arcadeLobby` seats, at most about once per second (P§10.1).
- **On the canvas, never in signals**: HUD, pins, names and the laggy pip.
- **Plain DOM owned by the game module**, built once at mount and event-driven: the touch controls and the pause menu.
- **GameStage** replaces the video grid on your own screen only, collapses the voice tiles to a strip, and adds "Back to call", which minimizes the game (`away`).
- **A minimized game** shows as a chip, "Bellwick running · Return".

### 8.4 Zero cost when closed, hidden or idle

| State | Rule |
|---|---|
| Closed | The chunk is not loaded. No listeners, timers, subscriptions or lane. |
| Hidden (P§10.3 merged visibility) | frames, audio and the music timer stop. Online: VIS 1, the lane is parked, and only the WebSocket ping flows. Offline: the game autosaves and the sim pauses. On return: VIS 0, then a KEYFRAME with reason 2. |
| Paused or still | 0 fps |
| Visible but alone and idle in a frozen room | No snapshots; one FRAME per second for the roster (about 0.1 kbit/s) |
| `unmount()` | Frees everything; the platform test asserts nothing is left (P§15.4) |

## 9. Bots

- **Solo opposition** is the enemy AI of §1.5 and the boss of §1.7.
- **The hero bot** (`core/bellwick/bots/hero.ts`) is deterministic and emits plain `Buttons`.
  - It follows the `content/walkthrough.ts` goals, with BFS across screens and A* within a room, both over fixed-capacity queues (no `while`).
  - It replans when its goal changes, or every 15 ticks.
  - In combat it lines up and slashes, hooks Shellbacks first, retreats and drinks at 2 half hearts, and attacks the boss only in its windows.
- **The hero bot drives:**
  - the tests;
  - Pip (M7);
  - the bench's three Node bot heroes (§13).

  The server never runs hero bots. When a hero's grace runs out, the hero leaves.

## 10. Controls and layout

| Action | Keyboard | Gamepad (standard mapping, 0.3 dead zone) | Touch |
|---|---|---|---|
| Move | Arrows or WASD | D-pad or left stick | Floating stick, 8 sectors |
| A: sword and interact (hold to charge a spin) | J, Z or Space | A (0) | A button, 76 px |
| B: item (hold Buckler, tap Vinehook) | K, X or Shift | B (1) or X (2) | B button, 56 px |
| Swap item | L or C | Y (3) | 40 px icon above B |
| Pause menu | Esc or P, only while the canvas has focus | Start (9) | ≡ at top right |
| Map | M | Back (8) | Map icon at top right |

- **Keyboard**:
  - Keys are captured only while the canvas has focus, behind the existing `isTyping` guard.
  - Never bound: the configured push-to-talk key, any key with Ctrl, Alt or Meta held, and the app shortcuts (P§10.4).
  - If push-to-talk is Space or another listed key, the other bindings still work and the key hints leave that key out.
- **Touch** uses the platform overlay (`runtime/input/touch.ts`):
  - the stick floats under the thumb in the left 45 % of the stage, with a 12 px dead zone and a 48 px radius, quantised to 8 sectors;
  - each pointer is tracked separately, so you can move and slash at the same time;
  - pointer capture and `touch-action: none`, with release on `pointercancel` or blur;
  - an optional D-pad, as in the platform;
  - haptics: a 10 ms pulse on damage and on opening a chest, off by default.
- **Portrait**: the canvas spans the full width (6:5) at the top, taking at most 60 % of the height, with the controls below in at least 200 css px. If less than 180 px is left (short phones, split screen), the controls overlay the canvas at 45 % opacity.
- **Landscape** (preferred, with Android immersive mode): the canvas fits the height, with controls in the side gutters. Gutters under 140 px switch to the overlay.
- **Desktop**: an integer-scaled canvas with key hints. Touch controls appear only on `(pointer: coarse)`.
- **Android back** opens the pause menu, and a second back minimizes (`useBackClose`). A Wake Lock is held while a Party or Solo Tale is live and visible.
- **Pause menu**: Items, Map, Party ("Go to ally", only at a lantern), Settings (music, effects, reduce flashing, control size and opacity, battery saver), Leave.
- **Allies** also carry shape markers (● ▲ ■ ◆), so colour is never the only cue.

## 11. Art and sound

**Art**

- **Style**: warm storybook pixel art in an original 16-colour palette (4 ramps of 4, plus outline and highlight). The village is ochre and green, Gloamwood blue-violet, and the dungeon teal stone in lantern light.
- **Sprites**: palette-indexed strings in `content/art.ts`, where `.` is transparent and `0`–`f` index the palette. A `mirror` flag derives the left-facing frames.
- **Frame counts**:
  - Hero: 4 directions × (2 walk, slash, shield, hook, hurt), plus spin, downed and resting.
  - Enemies: 2–4 each.
  - Boss (32 × 32): 6.
  - Tiles: about 45.
- **Atlas**: everything is rasterised once at mount into one `ImageBitmap` atlas of at most 512 × 512 (P§10.5). Tunics are palette swaps. Nothing is downloaded or traced, and the M6 review checks every sprite for originality.

**Sound**

- **Synthesis**: everything is Web Audio, and no audio files ship.
- **Effects** are parameter records, pre-rendered with an `OfflineAudioContext` at mount. For example, the swish is noise band-passed from 2 kHz to 600 Hz over 90 ms, and the hit is a square wave falling from 220 to 110 Hz over 80 ms.
- **Music** comes from a 4-channel tracker (two squares, a triangle and noise) playing note strings from `content/music.ts`: 4 tracks and 4 jingles, all original.
- **One AudioContext** per open game, created on the first in-game gesture, suspended when hidden and closed on unmount.
- **Levels**:
  - the Arcade master is 40 %, below voice, because speakers leak into microphones;
  - effects play at 70 % of the master;
  - music defaults to on (40 %) in Solo Tale and **off** in Party Tale, with a toggle in the pause menu (P§10.5).
- **Music scheduling**: a 100 ms `setTimeout` chain schedules 200 ms ahead. It exists only while music is audible and the game is visible, and the zero-timer test covers it.

## 12. Performance budgets

| Budget | Target |
|---|---|
| Client main thread | ≤ 4 ms per frame on average on a mid-range phone (Snapdragon 7-class, or desktop at 4× slowdown). Offline sim ≤ 0.5 ms per tick; online own-hero step ≤ 0.05 ms; render ≤ 2.5 ms; everything else ≤ 0.5 ms. No task over 16 ms. Platform check: main thread < 35 % at 4× throttle, frame p95 < 16.7 ms (P§15.6). |
| Allocation | None per tick or frame (pools, a reused DataView). Heap grows by ≤ 100 KB per 10 s. |
| Memory | Heap ≤ 8 MB. Offscreen canvases ≤ 1.5 MB (atlas ≤ 1 MB, back buffer 120 KB, two room bakes 220 KB). The display canvas is the stage size × DPR (≤ 2). |
| Bundle | Bellwick chunk ≤ **60 KB gzip**: sim and codec 15, content 8, art 10, render and UI 12, audio and music 6, slack 9. The shared `arcade-runtime` group is not counted, and the main bundle gains only the shell's registry entry. |
| Server CPU | ≤ 0.1 ms p99 per ticking room, ≤ 0.4 ms per session tick. 0 when no hero is active. At most 3 sessions server-wide, which keeps all action matches together under 2 ms per tick (P§13.2). |
| Server memory | ≤ 200 KB per session (rooms, 896 B rings, 8 KB replay ring), plus the parsed content shared once per process (about 100 KB) |
| Server egress | ≤ 112 kbit/s per session at the peak, 76 typical |
| Network per client | Down ≤ 32 kbit/s in any 1 s window (19 typical); up 16.4 moving, 6.1 idle |
| Hidden | 0 frames, 0 timers, a parked lane (ping only) |

## 13. Tests (bounded wall time)

Everything except row 14 runs in simulated time inside `npm test`. Bellwick adds **≤ 8 s** to the server suite and **≤ 2 s** to the client suite. No run lasts longer than 60 s, nothing soaks in real time, and a measurement stops as soon as its pass or fail is certain (P§15).

| # | Test | Where | Checks | Cap |
|---|---|---|---|---|
| 1 | Rules | server | Each row of §1.2; the Buckler blocks only from the front; every Vinehook case; keys; the shop; max hp; revive and respawn; drop tables; boss HP scaling | 0.5 s |
| 2 | Content | server | Screens are 12 × 9, edges match, references resolve, no backtick or `${` in maps; flag ids unique, ≤ 256, append-only against `flags.lock.json`; every chest and warp is reachable | 0.3 s |
| 3 | Soft-lock solver | server | BFS over (items, keys, doors, flags, purse floor): victory stays reachable from every reachable state, whatever the key order | 0.5 s |
| 4 | Determinism and goldens | server and client (jsdom) | FNV-1a hashes at ticks 300 and 1,800 of a 4-hero `Buttons` log (P§15.1), failing until `SIM.bellwick` is bumped; a 20,000-tick log replayed twice in both projects gives the same hash every 100 ticks; the `RULES_HASH` test (§3.6) | 1 s each |
| 5 | Fuzz (virtual) | server | 10,000 ticks of random `Buttons` for 4 heroes in each of the 36 rooms: no exceptions, pool caps hold, ids stay unique, step time bounded | 2 s |
| 6 | Completion | server | The walkthrough bot finishes from seed 1 within 45,000 ticks; 32 seeded dungeon runs all finish | 3 s |
| 7 | Codec | server | Round trips. Snapshot ≤ 91 B with 3 heroes and 14 entities. Keyframe ≤ 384 B worst case and ≤ 200 B typical. UP = 16 B. EVT ≤ 17 B. Fuzzed bytes decode to `null`. u16 ticks wrap. | 0.2 s |
| 8 | Authority | server | Speed clamp; wall clipping gets `Correct`; claims stale beyond 16 ticks, from too far away or with more than 8 targets are refused; a key raced at two doors opens one; a duplicate `evSeq` applies once; damage from beyond 24 px is refused; a `heroTick` from the future is clamped | 0.5 s |
| 9 | Routing and rekey | server | The platform's delta-base fuzz extended with room changes, warps, respawns and party events: after every keyframe plus its events, the client's room and party equal the server's view for that hero | 1 s |
| 10 | Session (injected timers) | server | 60 s grace; the 10 min away limit; 3 min idle → rest; no work while idle; host hand-off; save on end; restart saves and sends HANDOVER; wipe; revive | 0.5 s |
| 11 | Lifecycle | client | Hiding stops frames, audio and the music timer; `unmount` leaves nothing behind (P§15.4); the chunk stays unloaded while the game is closed; 100 frames per second write no signals | 1 s |
| 12 | Maths | server | Guaranteed glints cover the Buckler; world glints cover shop prices; hits needed to kill each enemy; boss time-to-kill ≥ 45 s solo and ≥ 35 s with 4; there are 8 shards | 0.2 s |
| 13 | Lossy link (virtual) | server | The platform `lossyLink` with Bellwick traffic, 3 bot heroes plus the measured one, in the boss room: the 3G and 3G + 1 % scenarios pass the P§15.2 criteria, ≥ 98 % of claims are accepted at 3G, and bytes stay within §4.8 | 1 s per scenario |
| 14 | Real shaped run (manual, before a release) | `ops/bench/arcade-netbench.mjs` | Bellwick variant: 3 Node bot heroes and one headless Chrome (`--mute-audio`, fake media) through the shaper. Scenarios 1 (3G) and 2 (3G + 1 % loss), 45 s each, aborting early. One 15 s CPU trace at 4× throttle in the boss room. One Android WebView check (≤ 1 min) that a backgrounded Party Tale draws nothing and is parked; if the emulator hits the known WHPX error, it is reported as blocked. | **≤ 3 min in all** |

## 14. Milestones (platform phase 4)

| Milestone | Scope | Tests |
|---|---|---|
| M1 Core (offline) | Sim, movement, slash, knockback, 3 screens, 2 enemies, HUD, canvas, keyboard and touch, pause on hide | 1, 4, 11 |
| M2 Overworld | Parser, all screens, transitions, dialogue, glints, shop, lanterns, local saves | 2, 12 |
| M3 Dungeon | 13 rooms, keys, puzzles, both items, Map and Compass | 3 |
| M4 Enemies and boss | All enemies, Old Clapper, the hero bot, balance. Solo Tale can ship at the end of M4 (with `games.bellwick` on and Party Tale hidden). | 5, 6 |
| M5 Party Tale | `rooms/bellwick.ts`, codec, routing and rekey, validation and rings, revival, roster pins, grace and idle rules, `arcade_saves`, stats, restart handover | 7, 8, 9, 10, 13, 14 |
| M6 Art and sound | Final sprites, effects, music, title and ending; the originality review | — |
| M7 Polish | Gamepad, haptics, reduce flashing, battery saver, Pip, phone checks, solo save import | — |

Repo practice applies: one VPS redeploy and one release per wave, and a PR only once web, server, ops, desktop and Android all work.

## 15. What the platform must add or change for Bellwick

1. **Per-game away limit.** Add `awayLimitMs` to the match config: 600 s for Bellwick, while Fuseyard keeps 60 s (90 s cumulative). A parked, away seat costs only the 10 s WebSocket ping.
2. **Rekey hook.** Add `MatchRuntime.takeRekeys(): {slot, reason}[]`, polled by the sender after each `step()`. For each entry the sender drops that recipient's pending events and sends a KEYFRAME (reason 4 for a room change, warp or respawn; 5 for a resync), following the in-flight rule of P§6.2.
3. **Empty slots send nothing.** `snapshotFor` may return `null`, and a send slot with no snapshot and no events sends nothing. The 1 s BEAT keeps the lane alive.
4. **Idle sessions.** Add `MatchRuntime.idle`. The scheduler keeps running only while some match is not idle or some recipient is parked as `yield` or `stalled` (those need the 1 Hz BEAT). Otherwise it stops (P§13.1).
5. **Budget constants** (`core/net/budget.ts` and the codec tests):

   | Constant | Was | Becomes |
   |---|---|---|
   | Keyframe cap | 300 B | 384 B |
   | Snapshot cap | 136 B | 91 B |
   | UP | 17 B | 16 B |
   | EVT payload | 3–7 B | 1–14 B |
   | §7.1 Bellwick row, down | 23 / 31 | 19–22 / 28 (32 in the worst window) |
   | §7.1 Bellwick row, up | 16.5 | 16.4 |
6. **Codec contract** (§3.6). `CODEC.bellwick` covers `HERO_RULES` and `TILE_FLAGS` through the `RULES_HASH` test. P§1's "sim skew only degrades prediction" holds for Bellwick's server-run parts only.
7. **Lobby features**:
   - running lobbies stay joinable as a player (drop-in up to 4);
   - no Watch button for Bellwick;
   - the cfg schema `{tale: 'new' | 'slot', slot}`;
   - when the host leaves, the host role passes to the longest-present hero.
8. **MatchHost additions**:
   - `onSeats(cb)`: slot → account id, display name, tunic and join order, from `arcade:lobby` (≤ 2 Hz);
   - `linkConstrained(): boolean`, the P§2.1 detection, for UP at 10 Hz.
9. **Client uplink guard.** `laneClient` skips a newest-wins UP while `ws.bufferedAmount > 512` B, unless it already does.
10. **Session limit.** `arcade.limits.bellwickSessions`, default 3, counted inside the 6 action matches server-wide.
11. **Saves API**:
    - `arcade:saves` returns Bellwick slot summaries (≤ 400 B);
    - `arcade:saves:delete` is refused with `in-use` while a session runs from that slot;
    - in M7, `arcade:saves:import {game, slot, data}`, with the `imported` flag.
12. **HANDOVER** for Bellwick is SaveV1 plus hero placement, not the full sim state. The client runtime gets a "Party copy" local slot.
13. **Stats and board.** The `arcade_stats` keys of §6.2; the "fastest clear" board counts only clears that were online, had at least 2 humans and were not imported. One `arcade_results` row on Victory.
14. **Bench and simulator:**
    - a Node bot-hero client (`core/bellwick/bots` over `ws`) for the netbench Bellwick variant;
    - a Bellwick traffic profile for `lossyLink`;
    - Bellwick in the delta-base fuzz.
15. **Pre-release name check** (P§18). Add these to the list: Kettlebrook, Gloamwood, Windmere, Drowned Bellhouse, Rootsword, Bark Buckler, Vinehook, Hearthbrew, Heart Vessel, glints, Pip, Wren and Elder Hesper. The hashed deny-list scan covers this spec and its code like everything else.

## 16. Weak points (honest)

1. **Hybrid trust.** A modified client can move at the clamped speed wherever the walls allow with slack, auto-claim hits that pass the checks, and never report damage. That is acceptable among friends with nothing of value at stake. The fastest-clear board can be gamed, and an admin can reset stats.
2. **Fights degrade above about 500 ms RTT**, because claims older than the 16-tick ring are refused. Exploring still works up to about 800 ms.
3. **It is TCP.** Under loss, enemies hold for about one RTO, while projectiles keep flying because their paths are deterministic. Chat is unaffected (separate connection, in-flight cap).
4. **Victim-decided damage**: on other screens a laggy hero may seem to walk through a hit, and it lands 150–300 ms later. This is cosmetic.
5. **Deploys end sessions.** Saves keep all progress, and "Continue offline" bridges the gap.
6. **Party saves belong to the host.** Members cannot continue a shared tale without the host in v1.
7. **The web build cannot start offline**; only the desktop and Android shells can (P§12).

## 17. As built (Bellwick package)

Where the build fills in or differs from this spec. Each row also says why.

### 17.1 Rules and content

| # | Where | As built |
|---|---|---|
| 1 | Interact (§1.2) | Reach is 7 px ahead (`interactReach` 112 sub), not 6. At 6 px, standing one pixel off a tile's centre turned the press into a slash. |
| 2 | Pebble Sentinels (§1.3) | They fire repel shots every 20 ticks, alternating by spawn order. A repel shot deals no damage but pushes the hero back 64 sub per tick for 12 ticks, even through invincibility. The Buckler stops it, so Gloam Gate still needs the Buckler. |
| 3 | Gloam Gate | The south entrance moved to columns 2–3, with two rocks and the sign beside it, and the Meadow's north exit moved to match. With the old entrance, a repel shot pushed a hero straight back out of the screen. |
| 4 | Buckler | It blocks a projectile whose direction of travel points against the hero's facing. A projectile from behind or from the side always hits. |
| 5 | Shellback | Only a frontal slash clinks. A spin always lands. |
| 6 | Old Clapper | Rolls at 36 sub per tick in phase 2, so an ideal solo hero needs at least 45 s and four heroes at least 35 s (§13 test 12). The phase 3 chase is normalised: 14 sub per tick per axis on diagonals. |

### 17.2 Authority (§3.5)

| # | Check | As built |
|---|---|---|
| 7 | Slack | 4 px plus two ticks of walking, because UPs go out every 2 ticks and a claim can arrive before the UP of its tick. |
| 8 | Moves | Checked over at most 1 s since the last accepted UP; a hero standing still sends none. The sweep ignores walls the hero already stood in (a shutter that closed on it). After a `Correct`, failing UPs that were already in flight are dropped quietly for 20 ticks. |
| 9 | `seenTick` | Must not be in the future. The room must have stepped fewer than 16 times since then, counted in the ring, not in server ticks: a room whose only hero is in a slide does not step, and its entities stay where the client saw them. The spec's bound "not later than the hero's heroTick" uses the server tick instead, again because a still hero sends no UPs. |
| 10 | Claims | Each target counts once per swing (keyed by the swing's start), at most 24 per swing, instead of "one claim per swing". A slash adds targets over 4 ticks, and the client sends them as it finds them. A claim on a target that is already gone (killed by a claim that arrived first) gets no `Refused`. |
| 11 | Damage and blocks | A projectile or slam ring is checked along its path from `seenTick` to the server's tick. The client draws projectiles at its current tick, about a round trip later than `seenTick`. A repel shot is accepted through invincibility; a real hit allows 3 ticks of it for clock jitter. A refused hit sends `Hp` to the hero. |
| 12 | Resync | Three `Correct`s within 2 s send a keyframe with entry 5 (resync). |

### 17.3 Wire and routing (§4)

| # | Where | As built |
|---|---|---|
| 13 | KEYFRAME | Every keyframe carries the party block (flags, purse, keys, items, shards, vessels, lantern, max hp, cleared rooms). That is 42 B; the worst case still fits in 384 B. A rekey drops the recipient's pending events, so a party event pending at that moment would otherwise be lost. |
| 14 | Entry reason | A keyframe within 3 s of a rekey carries that rekey's entry, and later ones say resume. Reading a keyframe changes nothing, because the sender may hold one back a while. |
| 15 | Joining | Online, a joining hero is not rekeyed: the platform's WELCOME already brings its keyframe. Offline it is, because a Solo Tale starts after the local host's first frame. A joiner wears the first tunic nobody present wears. |

### 17.4 Sessions and saves (§5, §6)

| # | Where | As built |
|---|---|---|
| 16 | Accounts | The runtime knows heroes by seat and join order. Persist events carry the match id plus every hero of the session, present or departed. `persist`, which gets `accountOf` for the seats at that moment, learns a hero's account at its first save, one tick after it joins. On the next step the hero gets its saved tunic, Hearthbrew and counts back. A hero who leaves is saved at once, because on a restart the platform drains that save before the session goes. |
| 17 | Lobby options | The sheet's `saveSlot` field gives `'new'` or an existing slot, so `meta.ts` adds "New tale in" (Slot 1–3). The cfg schema turns both into `{tale, slot}`. The sheet does not ask before a new tale overwrites an occupied slot. That confirmation is the platform's (§4.1). |
| 18 | Clears | A clear adds `clears` for every hero at the bell. Results and the fastest-clear board count only clears with at least 2 heroes there, in tales started online (`online: true` in SaveV1) and not imported. |
| 19 | 3-minute rule | A visible hero with no input for 5,400 ticks rests on the server until its next input. When everyone rests, the session is idle and does no work. |
| 20 | Replay | `replay()` holds the world now plus the last 10 s of UPs and EVTs, deflated, at most 8 KB (inputs are cut from the oldest end). It does not hold the world as it was at the start of the ring. |
| 21 | HANDOVER | The game keeps a Party copy (SaveV1 with the device's own hero as `solo`) and says that Solo Tale can carry on from it. The game cannot switch its own host to offline, so "Continue offline" means opening Solo Tale. |
| 22 | Downed online | After 1.5 s the game offers "Wait" or "Rest at the lantern". Offline it offers rest at once. |

### 17.5 Tests (§13)

| # | Test | As built |
|---|---|---|
| 23 | 9, routing | `deltaFuzz` over a Party Tale that drives itself. Projectiles are left out of the comparison: a client also ends them by its own clock, and the fuzz's event sections carry no tick to replay that with. |
| 24 | 13, lossy link | Two halves. Bellwick's own traffic in the boss room (4 bot heroes, 167 ms each way) is sized frame by frame against the budget, and the claim acceptance is counted. The platform's `lossyLink` scenarios then run with a probe shaped like that traffic, because the scenario runner drives only its probe runtime. |
| 25 | 10, session | Runs on the live test server. It uses its own lane client (`test/arcade/bellwick/live.ts`), because the harness's HELLO names Fuseyard's codec only. |
| 26 | Bot | The walkthrough bot's "use" step first walks up to the thing it uses, because a fight can push it out of reach. |
| 27 | Not built | Pip, the helper hero, and the solo save import (both M7). |

### 17.6 Verification (2026-10-22)

| Check | Result |
|---|---|
| Server suite | 68 files, 457 tests, 24 s; Bellwick's 13 files and 68 tests take 4.8 s. Typecheck (with core purity) is clean. |
| Client | 60 files and 413 tests; lint clean. `npm run build` passes, with the Bellwick chunk at 58.4 KB gzip of 60 KB and the main bundle 74 B larger for the catalogue entry. |
| Bots | The walkthrough bot finishes the tale from seed 1. 32 seeded dungeon runs finish. Behind 167 ms each way, a bot clears the dungeon with no `Correct` and no refused claim. |
| Boss room traffic (4 heroes, 3G delay) | 1,709 B/s mean and 1,868 B/s peak per client (budget 2,750 and 4,000); snapshot at most 36 B; keyframe at most 196 B; no refused claim. |
| Shaped bench (real Chrome plus 3 Node bot heroes in the Belfry) | 3G: 15 frames/s, chat p95 171 ms, lane 13.9 kbit/s down. 3G + 1 % loss: median 11 frames/s, chat p95 170 ms. Both pass. |
| Web | Chrome and Firefox: a two-player Party Tale passed 10/10 checks (drop-in, both heroes seen within 3 px, the host's slot saved under both accounts, leaving). Solo Tale passed 11/11. |
| CPU | Boss fight at 4× throttle: 18.9 % main thread, no task over 16 ms. |
| Packaged desktop | Solo Tale and Party Tale pass 5/5, but only with `file://` added to `CORS_ORIGINS`. The shared origin check turns `file://` into `file:` and refuses the action lane with 403 (reported to the platform). |
| Android emulator | 7/7: joins and walks; fits the phone; in the background it draws no frames and the hero rests; back in front, active again. |
