# Glimmerhall: slot machines (fitted to the Arcade platform)

Glimmerhall has three original slot machines played for **chips**, the Arcade's one virtual-chips wallet. Chips cannot be bought, sold, transferred or cashed out. The game runs on the platform's **table lane**: JSON events on the existing Socket.IO connection, with no tick, no action lane and no frame stream.

- **Online,** every spin is decided on the server in one SQLite transaction. The people in a voice channel who open the hall see each other's notable wins and share the Glimmer Pot and the **Glimmer Dash** tournament.
- **Offline,** the same pure engine runs on the device against four bot neighbours, using the shared Practice chips.

Code id `glimmer`. Delivery phase 3 (platform §19).

---

## 0. What changed from the draft spec

| Topic | Draft spec | This version | Why |
|---|---|---|---|
| Tournament name | Spin Sprint, `sprint:*` | **Glimmer Dash**, `glimmer:dash:*` | Platform §1 |
| Shared code | `shared/games/glimmer/` | `server/src/arcade/core/glimmer/`, imported as `@arcade/core/glimmer/…` | Platform §3.1 |
| Wallet and tables | `poker_wallets`, `poker_ledger`, `poker_escrow`, `glimmer_*` | `arcade_wallets`, `arcade_txns` + `arcade_ledger`, `arcade_escrow`, `arcade_jackpots`, `arcade_pending`, `arcade_stats`, `arcade_results` (migration 14) | Platform §11 |
| Stops on the wire | JSON arrays; a free-spin run is about 22 B per spin, up to 5 KB | One base64url character per reel stop (every strip has fewer than 64 stops). Run of 200 spins (the cap) ≤ 1.2 KB. Longest run in a 200k-spin sample: 30 spins, 150 chars. | A 5 KB ack breaks the table lane's ≤ 3 KB-per-second ceiling (platform §7.1). |
| Hall pushes | Separate `feed`, `brag`, `pot` and reaction events | One `glimmer:feed` push per recipient, ≤ 1 Hz, sent only when something changed, carrying all sections | At 20–150 B bodies, the 92 B of framing per message dominates, so fewer messages save the most. |
| Recipients | Room emit to `glimmer:<channelId>` | A separate emit to each hall member who is not away, so the per-socket bucket and the "chat first" writeBuffer rule apply (platform §4.2) | A room emit bypasses per-socket pacing. |
| UI shell | Preact chrome plus a canvas class | Framework-free DOM built once at mount, plus the canvas. Only the platform's coarse signals are written. | Platform §3.3 and §10.1: lazy chunks are framework-free, and VoicePage never re-renders on game traffic. |
| Server memory | `Seat.recent` ring of 8, session net | Receipts live in `arcade_txns.result` (looked up by a unique index). Session stats live on the client. | One source of truth |
| Dash vault | Auto-pick after 8 s | The vault opens at once (server-random door) and the result is in the spin ack | No pending state inside a timed tournament |
| Gamepad | `setInterval` poll at 10 Hz | A 10 Hz `lib/frames` subscription, only while a pad is connected and the hall is visible | Platform §10.4: no game timers outside the frame scheduler |
| Reality check | An armed 30-minute timeout | Active time is accumulated on each spin, and the check shows at the next settle | No timer at all while idle |
| Hidden hall | Stop locally | Also `glimmer:away {}`, which stops pushes server-side | Platform §9.4 |
| Pot win in the channel | Posts a line to the channel's activity | The LobbyChip says "Glimmer Pot won" for 60 s, through the activity summary. No chat line, sound or toast. | Opt-in: nobody is pushed |
| Verification | 4 Chrome clients for 60 s, plus profiles | Simulator scenarios under 1 s; one 45 s shaped smoke with 1 Chrome and 3 Node bots; two 15 s CPU traces. ≤ 3 min of manual wall time in total. | Platform §15 time budget |

---

## 1. Names

- **Game:** Glimmerhall (`glimmer`).
- **Machines:**

  | Machine | Wire index | Code | Volatility |
  |---|---|---|---|
  | Pocket Orchard | 0 | `orchard` | low |
  | Tidepool Treasures | 1 | `tidepool` | medium |
  | Ember Vault | 2 | `embervault` | high |

- **Features:** Harvest Wheel (Orchard), Tide Turn free spins (Tidepool), Three Vaults pick into Forge Spins (Ember Vault).
- **Shared progressive:** Glimmer Pot, one per server, ledgered as `p:glimmer`.
- **Timed tournament:** Glimmer Dash.
- **Offline bot neighbours:** Juniper, Wex, Saffi and Gus. They do not reuse the poker bots' names.
- **Currency:** chips, from the one Arcade wallet shared with Lamplight Hold'em. Offline play uses the shared Practice chips (`runtime/practiceWallet.ts`).

---

## 2. Rules common to all machines

- **Strips and stops.** Each reel is a circular strip of symbols. A spin draws one uniform stop index per reel. Stop `i` shows `strip[i]`, `strip[i+1]` and `strip[i+2]` (mod length) as the top, middle and bottom rows.
  - What is drawn is exactly what is shown: no virtual reels, no weighting, no engineered near misses.
- **Wild** stands in for every paying symbol, but never for a scatter or bonus symbol.
- **Lines** pay left to right from reel 1, on consecutive reels.
  - The line's symbol is the first non-wild symbol.
  - Each line pays only its highest win, and line wins add up.
- **Ways** (Ember Vault): for each paying symbol, count the reels from reel 1 that show that symbol or a wild, stopping at the first reel without one.
  - Ways = the product of the matching positions on those reels.
  - Win = pay[k] × ways.
- **Scatter and bonus** symbols count anywhere in the window of the reels they sit on. The strips are built so that a window never holds two of them, and a test checks this.
- **Integer amounts:**
  - Orchard: line bet = bet / 5.
  - Tidepool and Ember Vault: coin = bet / 20. Tidepool pays coins per line, Ember Vault coins per way.
- **Bet ladders:** Orchard 5, 10, 25, 50, 100. Tidepool and Ember Vault 20, 40, 100, 200, 500. Steps above the admin's `slotsMaxBet` are hidden in the client and refused by the server.
- **Free spins.** A feature cannot trigger during free spins, except as a retrigger. Free spins stop at a hard cap of 200 per feature; the effect on RTP is below 1e-9. The cap also bounds the loop, as core's rule requires.
- **"How it works".** Each machine has a page that shows its RTP, hit frequency, trigger odds and paytable.

---

## 3. The machines (exact content, unchanged)

Hit frequency is the share of base spins that return anything, including a feature trigger. SD is the standard deviation of one spin's return in bets, features included.

### 3.1 Pocket Orchard: 3 reels × 3 rows, 5 lines

Lines (row per reel, 0 = top): `111`, `000`, `222`, `012`, `210`.

| Code | Symbol | Pays per line bet |
|---|---|---|
| A | Acorn | 2 from left: 1, 3: 5 |
| P | Plum | 3: 9 |
| R | Pear | 3: 14 |
| H | Honeycomb | 3: 28 |
| F | Fig | 3: 60 |
| W | Sunseed (wild, also pays) | 3: 150 |
| B | Basket (bonus) | one on each reel triggers the Harvest Wheel |

On a line with wilds, the line pays the higher of the wild run and the symbol run.

All three strips are identical (22 stops): `BAPRHAFPRAPWHARPAFHRPA`

**Harvest Wheel.** Twelve equal segments, each equally likely, paying × bet: 5, 5, 8, 8, 10, 10, 12, 15, 20, 25, 40, 75. Mean 19.4167×.

| Orchard math | Value |
|---|---|
| Line RTP | 89.923 % |
| Wheel RTP (trigger 27 / 10,648 = 1 in 394.4) | 4.923 % |
| **Machine RTP (exact)** | **94.8465 %** (`0.948464500375662`) |
| Hit frequency (exact, exhaustive) | 55.13 % |
| Spins returning at least the bet | 30.66 % |
| SD per spin / maximum win | 2.48 / 77.8× |

### 3.2 Tidepool Treasures: 5 × 3, 20 fixed lines

Lines: `11111 00000 22222 01210 21012 00122 22100 10001 12221 01110 21112 10121 12101 01010 21212 11011 11211 02020 20202 02220`.

| Code | Symbol | 2 | 3 | 4 | 5 (coins per line) |
|---|---|---|---|---|---|
| S | Spiral Shell | | 10 | 35 | 120 |
| C | Crab | | 10 | 35 | 120 |
| K | Kelp | | 15 | 45 | 150 |
| U | Urchin | | 15 | 45 | 150 |
| H | Seahorse | | 25 | 100 | 300 |
| L | Lanternfish | | 35 | 140 | 500 |
| T | Turtle | | 60 | 250 | 900 |
| O | Octopus | 5 | 120 | 500 | 2500 |
| W | Pearl (wild, reels 2–4, no pay of its own) | | | | |
| X | Starfish (scatter, reels 1, 3, 5) | | | | |

Strips:
- Reels 1 and 5 (49 stops): `XSCKUHLTSCKUOSHCXKULSCKTSUHCKSLUXCKHSOUCKSTLHUCKS`
- Reels 2 and 4 (48 stops): `WSCKUHLTSCKUOSHCKULSCKTSWUHCKSLUCKHSOUCKSTLHUCKS`
- Reel 3 (51 stops): `XSCKUHLTWSCKUOSHCXKULSCKTSUHCKSLUWXCKHSOUCKSTLHUCKS`

**Tide Turn.** A starfish on reels 1, 3 and 5 pays 2× bet and gives 10 free spins on the same strips. All free-spin wins are ×2. Three starfish during free spins pay 2× (×2) and add 10 spins.

| Tidepool math | Value |
|---|---|
| Line RTP (exact) | 82.441 % |
| Trigger | (9/49)(9/51)(9/49) = 1 in 167.97 |
| Expected free spins | 10.633 |
| Feature average, scatter pay included | 19.785× |
| Feature RTP | 11.779 % |
| **Machine RTP (exact)** | **94.2205 %** (`0.9422046018125284`) |
| Hit frequency / at least the bet (Monte Carlo, 1M spins) | 45.1 % / 24.5 % |
| SD / largest win seen in 1M spins | 2.68 / 284× |

### 3.3 Ember Vault: 5 × 3, 243 ways

| Code | Symbol | 3 | 4 | 5 (coins per way) |
|---|---|---|---|---|
| a | Ash Rune | 4 | 10 | 30 |
| f | Frost Rune | 4 | 10 | 30 |
| m | Moss Rune | 4 | 12 | 40 |
| s | Storm Rune | 4 | 12 | 40 |
| g | Glow Rune | 6 | 20 | 50 |
| H | Forge Hammer | 20 | 50 | 200 |
| A | Anvil | 25 | 75 | 300 |
| P | Cinder Plume | 40 | 150 | 600 |
| D | Ember Drake | 75 | 400 | 2000 |
| W | Molten Core (wild, reels 2–4, no pay of its own) | | | |
| K | Vault Key (scatter, reels 1, 3, 5) | | | |

Base strips:
- Reels 1 and 5 (48 stops): `KafmsgHAafmsgPafKmsgDafHmsAafgmsKafPgmsafHAgmsaf`
- Reels 2 and 4 (47 stops): `afmsgHAafmsgPafmsgDafHmWsAafgmsafPgmsafHAgmsafW`
- Reel 3 (50 stops): `KafmsgHAWafmsgPaKfmsgDafHmsAafgmsKWafPgmsafHAgmsaf`

Forge Spins strips (more wilds):
- Reels 1 and 5 (41 stops): `KafmsgHAPafmsKgDafmsgHAafmsKgPafmsHAgafms`
- Reels 2 and 4 (42 stops): `WafmsgHAPaWfmsgDafmsgWHAafmsgPaWfmsHAgafms`
- Reel 3 (45 stops): `KafmsgHWAPafmsgKDaWfmsgHAafmsWKgPafmsHAgWafms`

**Three Vaults and Forge Spins.**
- A key on reels 1, 3 and 5 pays 3× bet and shows three vault doors.
- At trigger time the server shuffles three prizes behind the doors: 10 spins ×2, 8 spins ×3 and 6 spins ×4. The pick is a reveal: each door is equally likely to hold each prize.
- After the pick, all three doors open, then the Forge Spins play on the Forge strips.
- Three keys during Forge Spins pay 3× (× the multiplier) and add 3 spins.

| Ember Vault math | Value |
|---|---|
| Base ways RTP (exact) | 71.109 % |
| Trigger | (9/48)(9/50)(9/48) = 1 in 158.02 |
| Forge spin value before the multiplier | 1.4411× bet; retrigger chance 0.9637 % per spin |
| Door values (before the 3× scatter pay) | 30.28×, 36.33×, 36.33×; mean 34.313× |
| Feature RTP | 23.612 % |
| **Machine RTP (exact)** | **94.7209 %** (`0.9472091408049044`) |
| Hit frequency / at least the bet (Monte Carlo, 1M) | 50.9 % / 24.4 % |
| SD / largest win seen in 1M spins | 4.36 / 478× |

### 3.4 Rates that size the social traffic

These come from a 200k-spin Monte Carlo per machine (0.6 s).

| Machine | Spin returns ≥ 5× bet | ≥ 25× (brag) | ≥ 100× | Feature | Free-spin run p50 / p99.9 / max |
|---|---|---|---|---|---|
| Orchard | 4.5 % | 0.11 % | 0 | wheel, 0.25 % | — |
| Tidepool | 4.2 % | 0.24 % | 0.007 % | 0.58 % | 10 / 30 / 30 spins |
| Ember Vault | 2.4 % | 0.44 % | 0.04 % | 0.63 % | 8 / 14 / 16 spins |

---

## 4. Glimmer Pot (online only)

### 4.1 Contribution, draw and payout

**Contribution.** Every online base spin (not free spins, not Dash spins) adds `bet × 75` e4-units (0.75 % of the bet), following platform §11.2:
1. `carry_e4 += bet × 75`.
2. `whole = floor(carry_e4 / 10000)`, and `carry_e4 -= whole × 10000`.
3. `whole` chips move house → `p:glimmer` as one leg of the spin's txn.

The sub-chip carry is house-owned, so the ledger only ever holds whole chips.

**Draw.** After the base spin's own draws, the server checks `crypto.randomInt(1_000_000) < bet`. Every chip wagered has the same one-in-a-million chance, whatever the bet.

**Win.**
- The winner gets the whole `pool`, including this spin's contribution, on top of the spin's win.
- In the same database transaction, a separate `pot_seed` txn moves 7,500 house → `p:glimmer`.
- `arcade_jackpots.last_winner`, `last_amount` and `last_won_at` are set.

**Return.** The expected pot when won is 7,500 + 0.0075 × 1,000,000 = 15,000, so the pot returns **1.5 %** of every wager.

| Total RTP | Orchard | Tidepool | Ember Vault |
|---|---|---|---|
| Online, pot included | 96.35 % | 95.72 % | 96.22 % |
| Offline (no pot) | 94.85 % | 94.22 % | 94.72 % |

### 4.2 Concurrency and display

- **Concurrency.** The pot is global and every spin is one synchronous `better-sqlite3` transaction, so no two spins race on it. It survives restarts.
- **Display.**
  - Your own spin ack carries `pot` whenever the amount changed since the last value sent to that socket.
  - Idle hall members get it in `glimmer:feed`, at most once every 2 s per hall, and only on change.
  - A pot win shows as a hall banner. Through the activity summary, the channel's LobbyChip reads "Glimmer Pot won · 15,240" for 60 s.

---

## 5. Social play

### 5.1 Opt-in and the hall

**Entry.** Each person opens Glimmerhall themselves, from the voice channel's **Arcade** sheet (platform §10.6). Nobody is pulled in: there is no toast, no sound and no change of view.
- **Everyone else in voice** sees only the passive LobbyChip, "Glimmerhall · 3 playing · Open".
  - It is fed by `arcade:activity` with `{g:'glimmer', id, st, n, max:16}`.
  - `n` counts hall seats, away members included, so hiding and showing never change the summary.
- **Channel viewers outside the call** get only that summary. There is no slots spectating; the feed is the shared view.
- **Hiding.** An account with "Hide Arcade", or with the per-game "Hide Glimmerhall" toggle, sees no tile, chip or badge (§15).

**The hall.**
- **One hall per voice channel,** with at most 16 members (`arcade.limits.hallMembers`). Only voice members of that channel can enter.
- **Hall slots.** Each member gets a hall slot 0–15 at entry. Feed entries name the slot, never the account id (25 chars), to keep pushes small.
- **Friends strip.** It shows each member's avatar and display name (looked up from presence), their machine, an away dim, and their last notable win.
- **Feed entries** are created for:
  - spins returning at least **5× bet** (about 2.4–4.5 % of spins);
  - every feature total;
  - pot wins;
  - machine changes.
- **Brag banner** (client-side, from feed entries):
  - a win or feature total of at least 25× bet;
  - any pot win.

  The banner reads, for example, "Saffi hit 1,240 on Tidepool (×62)".
- **Reactions.** Members can react with one of 6 original pixel emotes (sparkle, clap, grin, wow, flame, heart), at most 1 per 3 s per account.
- **Privacy.** Balances are never sent to anyone else. Only wins are shared.

### 5.2 Leaving voice

`arcade.onVoiceLeft(accountId, ch)` takes the seat out of the hall (`hall = null`):
- The player may keep spinning online with their own chips, with no feed and no pushes.
- The stage shows "You left the call · hall closed".
- They can no longer join a Dash. An entry in a running Dash stays valid until it ends.

### 5.3 Glimmer Dash

**Setup.**
- Any hall member can open a Dash, choosing:
  - the machine;
  - the length: 3, 5 or 10 minutes;
  - the buy-in: 0, 100, 500 or 1,000 chips.
- One Dash per hall at a time, and at most 4 server-wide (`arcade.limits.dashes`).

**Lobby.**
- The lobby stays open for up to 60 s, or until the host starts. A Dash needs 2 to 8 human entrants.
- If fewer than 2 have joined at 60 s, it is cancelled and buy-ins are refunded (`refund`).
- Buy-ins move wallet → `e:dash:<id>:<accountId>` (escrow row `ref = 'dash:<id>'`, `kind = 'buyin'`).

**Play.**
- Each entrant gets 100 spins at a fixed 20-point bet, in sprint points. Dash spins do not touch the wallet, add nothing to the pot, and write no ledger rows.
- Features play automatically.
  - In a Dash, the Three Vaults open at once: the server draws the door, and the ack carries the whole Forge run.
  - The client opens all three doors in turn and highlights the drawn one. Nothing is presented as a choice.
- **Score** = points won.

**End.**
- A Dash ends when every entrant has used their spins or time runs out. Unplayed spins are forfeited.
- The server holds one `setTimeout` per Dash: the lobby deadline, then the end.

**Payout.**
- The pool pays 100 % to the winner with 2 entrants, 70/30 with 3–4, and 50/30/20 with 5–8.
- Each share is `floor(pool × pct / 100)`. The remainder goes to first place, so the payout sums to the pool exactly.
- Ties split the tied places' combined shares. The odd chip goes to the entrant who finished earlier.
- Prizes move escrow → wallet as `prize` txns.
- A freeroll (buy-in 0) awards a trophy (`arcade_stats glimmer dash.wins`) and no chips.

**Record.** The result is written to `arcade_results` (`game 'glimmer', mode 'dash'`, summary `{m, len, buy, n}`) and `arcade_result_players` (place, score, chips_delta).

**Disconnect and hidden.**
- The entry stays. Spins resume when the player is back, and time keeps running.
- No auto-play.

**The lobby states plainly:** "A Dash is pure luck."

---

## 6. Authority, RNG and hidden information

| Part | Online | Offline |
|---|---|---|
| RNG | `crypto.randomInt(n)` injected as `Rng`. Core never imports `crypto`. | `crypto.getRandomValues` with rejection sampling (client runtime). Tests use core's seeded xoshiro128**. |
| Spin, feature, Dash, pot | Server, shared engine | Client main thread, same engine (no pot) |
| Wallet | `arcade_wallets` through `wallet.transfer()` | Practice wallet in `localStorage` (`datasetto.arcade.practice.v1`, try/catch, in-memory fallback), never synced |
| Hall, feed, Dash | Server | Local bots and a local Dash |
| Line and way details, animation, sound | Client | Client |

**Server sends stops and totals only.**
- The client rebuilds line and way details with the shared `evaluate()`.
- If its total differs from the server's, the server's total wins, and the client logs one warning per session.

**Definitions version.**
- `core/version.ts` gains `DEFS = {glimmer: 1}`, bumped whenever strips, paytables, lines or feature rules change.
- `glimmer:enter` sends `v`. On a mismatch the server answers `{ok:false, code:'update'}`, and the hall offers Practice only, with "Update the app to play online".
- Old Android APKs and desktop builds therefore never mis-draw an online result.

**Hidden from other clients:**
- RNG state;
- door contents until the pick, kept server-side in `arcade_pending.data`;
- every balance except your own;
- other members' bets on non-notable spins.

`viewFor`-style filtering is trivial here: hall pushes carry only feed entries, and nothing else is ever sent to non-owners.

**Draw order** is part of the core contract (for golden replays offline). Online the order is unobservable, because the RNG is cryptographic.
1. `rng(len_r)` for each reel, in order.
2. The feature:
   - wheel: `rng(12)`;
   - Tide Turn: per free spin, `rng(len)` per reel;
   - Three Vaults trigger: Fisher–Yates door shuffle (`rng(3)`, `rng(2)`); the Forge spins are drawn at the pick.
3. The pot draw, server only, last.

---

## 7. Code layout

### 7.1 Shared core: `server/src/arcade/core/glimmer/`

Pure TypeScript. No enums (`as const` objects plus unions), no platform APIs, integer maths, and bounded `for` loops only: the platform's purity test applies to all of `core/glimmer`.

```
machines.ts   # MACHINES = ['orchard','tidepool','embervault'] as const; defs: strips, fsStrips, lines, pays, bets, features
evaluate.ts   # evaluate(def, stops, bet, strips?) → Evaluation (lines or ways, scatter count, trigger)
spin.ts       # spinBase(def, bet, rng); playFeature(def, bet, rng, prize?) (free-spin loop: for i < 200)
feature.ts    # shuffleDoors(rng); wheel; Tide Turn and Forge run builders
rtp.ts        # exactRtp(def) → {base, feature, total, triggerP} (tests and "How it works")
wire.ts       # stop codec (one base64url char per stop), ack/feed/enter types, size constants
bots.ts       # offline bot habits: nextDelay, bet step, machine changes (rng injected)
```

```ts
export type MachineIdx = 0 | 1 | 2;
export type Rng = (n: number) => number;                 // uniform integer in [0, n)
export interface BaseResult { stops: number[]; win: number; trigger: boolean }
export interface FeatureResult {
  kind: 'wheel' | 'tide' | 'vault';
  segment?: number;      // wheel
  doors?: number[];      // vault: prize index behind each door
  picked?: number;       // vault
  mult: number;
  stops: number[];       // free spins, 5 per spin, flat
  win: number;           // multiplied, scatter pays included
}
export const STOP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const encodeStops = (s: readonly number[]): string => { /* one char per stop */ };
export const decodeStops = (t: string, def: MachineDef, fs: boolean): number[] | null => { /* range-checked per reel */ };
```

### 7.2 Server: `server/src/arcade/halls/`

- **`glimmer.ts`** holds the seats and halls, the `enter`, `leave`, `spin`, `pick`, `resume`, `away` and `react` handlers, and the feed flush.
- **`dash.ts`** holds the Glimmer Dash lifecycle.
- **Registration.** Handlers go through `handle()` in `arcade/handlers.ts`, with zod schemas, auth, the password-change gate and the limiters in §8.4.

### 7.3 Client: `client/src/arcade/glimmer/` (one lazy chunk, framework-free)

```
index.ts          # mount(el, host, opts) → GameHandle {pause, resume, unmount, back}
hall.ts           # DOM chrome built once: top bar, balance, bet −/+, SPIN, Auto, friends strip, banner, pot, Dash panel
reels.ts          # canvas: static layer (cabinet) + dynamic layer (reels, win lines)
effects.ts        # wheel, doors, celebrations (≤ 64 particles, ≤ 4 s)
art/*.ts          # 24×24 palette-indexed grids per machine, 9-slice cabinets
sounds.ts         # recipes rendered by runtime/audio.ts
auto.ts           # auto-spin, loss limit, reality check
paytable.ts       # "How it works" pages, built on first open
hosts/remote.ts   # GlimmerHost over socketClient.request()/on()
hosts/local.ts    # GlimmerHost over core engine + practice wallet + bots
```

The table-lane host interface, which the platform's `MatchHost` does not cover (§19):

```ts
export interface GlimmerHost {
  readonly mode: 'local' | 'remote';
  enter(): Promise<EnterView>;
  spin(m: MachineIdx, bet: number, id: string): Promise<SpinAck>;
  pick(door: 0 | 1 | 2): Promise<PickAck>;
  resume(id: string): Promise<ResumeAck>;
  react(to: number, emote: number): void;
  dash: { create(c: DashCfg): Promise<DashAck>; join(id: string): Promise<DashAck>;
          leave(id: string): Promise<DashAck>; start(id: string): Promise<DashAck>;
          spin(id: string, sid: string): Promise<DashSpinAck> };
  onFeed(cb: (f: FeedView) => void): () => void;
  onWallet(cb: (bal: number) => void): () => void;   // other devices' changes
  onMoved(cb: () => void): () => void;                 // another tab took the seat
  setVisible(v: boolean): void;   // remote: glimmer:away / re-enter; local: freeze bots and Dash clock
  close(): void;                  // remote: glimmer:leave
}
```

Bundle: the lazy `glimmer` chunk is ≤ 40 KB gzip (platform §3.1), of which the shared engine and math are ≤ 8 KB. The art grids are text and compress to about 5 KB.

---

## 8. Server state, lifecycle and limits

### 8.1 Memory (keyed by accountId, never socket id)

```ts
Seat   { accountId, socketId, hall: channelId | null, slot, machine: MachineIdx, away: boolean,
         lastInputAt, disconnectedAt?: number }
Hall   { channelId, members: Map<accountId, Seat>, lastNotable: Map<slot, [win, x100]>,
         pending: { e: Entry[]; r: Reaction[]; h: Member[]; d?: DashView; p?: number },
         lastFlushAt, lastPotAt, flushTimer?: Timeout, dash?: Dash }
Dash   { id, ch, machine, buyIn, len, state: 'lobby' | 'running' | 'done', hostSlot,
         deadline, timer, entrants: Map<accountId, { slot, score, left, finishedAt? }> }
```

**Spins in flight.** The spin handler is synchronous (a `better-sqlite3` transaction), so "one spin in flight per account" holds structurally. The 2/s limiter is the only rate rule.

### 8.2 Lifecycle

| Event | What happens |
|---|---|
| First `glimmer:enter` in a channel | The hall is created |
| `glimmer:enter` from a newer socket of the same account | The seat moves to it. The old socket gets `glimmer:moved {}` and shows "Playing in another window · Play here". Its spins are refused with `code:'moved'`. |
| `glimmer:away {}` (merged visibility false, or 10 min without input) | `away = true`: pushes stop. Shown dimmed in friends strips, at most one membership change per member per 5 s. |
| Visible again | The client re-sends `glimmer:enter`. It is idempotent for an existing seat and returns a fresh snapshot. |
| Main-socket disconnect | The seat is kept. After 120 s it is dropped, the slot is freed and members get `h`. Nothing is lost: every spin is settled. |
| Last member leaves | The hall is deleted. No timers remain. |
| `server:restarting` (`arcade.onRestarting()`) | Halls are dropped. Every Dash in lobby or running is voided and refunded (`restart-refund`), with `d:{st:3}` pushed first. Pending vaults persist. Clients re-enter after reconnecting. |
| Boot | Leftover `dash:*` escrow rows are refunded (platform §9.6). Vaults pending for over 24 h are auto-picked. |
| Admin turns `games.glimmer` off | Halls close (`glimmer:closed {r:'disabled'}`), Dashes are refunded, pending vaults are auto-picked and credited, and spins are refused with `code:'disabled'` |

**Pending vault auto-pick.** A vault pending for over 24 h is auto-picked (random door, credited as a `feature` txn). This runs from the platform's daily maintenance job, at boot, and on that account's next `glimmer:enter`, so no extra timer is needed and value is never held hostage. While a vault is pending, base spins are refused with `code:'pending'`. The hall reopens the door screen on every device.

### 8.3 Timers (none while nothing is open)

| Timer | When it is armed |
|---|---|
| Hall flush | One timer per hall, only while it has pending content. It fires at `max(lastFlushAt + 1000, now)`. |
| Pot change | Marks every hall with a non-away member as dirty. Pot is included only if 2 s have passed since that hall's last pot value. |
| Seat drop | One 120 s timer per disconnected seat |
| Away shown | One timer per member, only when an away or back change falls inside the 5 s gap; it fires when the gap ends |
| Dash | One timer per Dash (lobby deadline, then end) |

### 8.4 Limiters (platform §13.3)

| Event | Limiter | Refusal |
|---|---|---|
| `glimmer:spin`, `glimmer:pick`, `glimmer:dash:spin` | `spin` (2 per second) | Quiet `{ok:false, code:'busy'}` |
| `glimmer:enter`, `leave`, `dash:create`, `join`, `leave`, `start` | `arcade` (20 per 10 s) | `{ok:false, code:'busy'}` |
| `glimmer:react` | 1 per 3 s per account, kept in the hall | Dropped silently |
| `glimmer:away` | `arcade` | Dropped silently |

**Client spin floor.** The client never sends spins less than **700 ms** apart, even with turbo and slam-stop. That keeps the uplink inside the platform ceiling (§11).

### 8.5 CPU

| Work | Budget |
|---|---|
| A base spin, including its transaction (about 10 prepared statements, WAL with `synchronous = NORMAL`, no fsync per commit) | ≤ 0.5 ms |
| A 200-spin feature: engine ≤ 2 ms, plus one transaction | — |
| One hall flush | ≤ 16 emits |
| Worst case: 16 members at the 2/s cap | 32 spins/s ≈ 16 ms/s, under 2 % of a core |

---

## 9. Persistence (migration 14 tables, no new ones)

| Draft table | Platform table and use |
|---|---|
| `poker_wallets` | `arcade_wallets` |
| `poker_ledger` rows `glimmer:bet/win/pot` | One `arcade_txns` row (`kind 'spin'`, `ref 'glimmer:<m>'`, `actor`, `idem 'g:<spinId>'`, `result` = the ack JSON) plus its `arcade_ledger` legs |
| `glimmer_pot` | `arcade_jackpots` row `scope 'glimmer'` (`pool`, `carry_e4`, `last_*`) |
| `glimmer_pending` | `arcade_pending (account_id, 'glimmer', 'vault', txn_id, data = {m, bet, doors})` |
| `glimmer_last` | `arcade_txns.result`, cleared after 24 h |
| `glimmer_stats` | `arcade_stats (account_id, 'glimmer', stat)`: `<m>.spins`, `<m>.wagered`, `<m>.won`, `<m>.best` (chips), `<m>.bestx` (×100, `max()` upsert), `pot.wins`, `pot.best`, `dash.played`, `dash.wins` |
| `poker_escrow` under `sprint:<id>` | `arcade_escrow (ref 'dash:<id>', kind 'buyin')` |
| — | `arcade_results` / `arcade_result_players` for Dash results |

**One spin is one `db.transaction`:**
1. Idempotency: if `(actor, idem)` exists, return `result`, or `{settled:true, bal}` if it was cleared, and stop.
2. Guards: the vault is not pending, the bet is on the ladder and ≤ `slotsMaxBet`, and **the balance is at least the bet** (an explicit check, §19).
3. Draws, evaluate, the feature (wheel or Tide Turn in the same txn; a vault trigger writes `arcade_pending`), the pot contribution and the pot draw.
4. `transfer('spin', 'glimmer:<m>', actor, idem, legs)`. There is one leg per account per txn, so legs are **net**:

   | Leg | Delta |
   |---|---|
   | `w:<id>` | `win − bet + potWin` |
   | `p:glimmer` | `whole − potWin` (only when non-zero) |
   | `house` | balancing |

   On a pot win, a second txn `pot_seed` (house → pot, 7,500) runs inside the same database transaction.
5. `arcade_jackpots` update (`carry_e4`, `pool` via the leg, `last_*` on a win) and the `arcade_stats` upserts.
6. The ack JSON is stored in `result`.

A throw anywhere rolls the whole spin back.

**Pick.** `transfer('feature', 'glimmer:embervault', actor, 'gp:<pendingTxnId>', [w +win, house −win])` and the `arcade_pending` row is deleted, all in one transaction.

**Retention.**
- **Size.** About 455 B of rows and indexes per spin (one txn row with a receipt, three ledger rows).
- **Folding.** `spin` and `feature` ledger rows are folded into `arcade_ledger_months` after **7 days**. Their txn rows are deleted then (§19). Idempotency only needs 24 h.
- **Bound.** A heavy evening (8 people × 2,000 spins) adds about 7 MB, and the folding keeps the steady state bounded.

**Boards** (platform §11.3): "Glimmerhall best win" (by `bestx` and by chips) and "Glimmer Dash wins" come from `arcade_stats`.
- All online spins count. Slots are luck only, so there is nothing to farm against bots, and there are no online bots.
- Offline stats stay on the device.

---

## 10. Network messages (table lane, JSON on the main socket)

**Conventions.**
- Payload sizes exclude framing. On the wire, a downlink message adds about 92 B (Socket.IO header and event name, WebSocket, TLS and TCP/IP), and an uplink message adds about 96 B (the 4 B mask).
- Acks use the platform's `{ok, …}` and `{ok:false, code}` shape.
- Stops are base64url strings (`STOP_ALPHABET`, one char per reel).
- Machines are wire indices 0–2.

### 10.1 Client → server

| Event | Shape | Ack | Payload (req / ack) |
|---|---|---|---|
| `glimmer:enter` | `{ch, v}` | `{ok, bal, pot, me, maxBet, mem:[[slot, acct, m, away, lw, lx]], pend?:{m, bet}, dash?}` | 40 / ≤ 1 KB (16 members) |
| `glimmer:leave` | `{}` | `{ok}` | 2 / 8 |
| `glimmer:spin` | `{m, b, id}` (`id`: 12 base64url chars, 72 random bits) | see §10.3 | 36 / 60–160 |
| `glimmer:pick` | `{door}` | `{ok, dr:[p0, p1, p2], f:{k:'v', d, r, w}, bal}` | 10 / 100–1,200 |
| `glimmer:resume` | `{id}` | the stored ack, `{settled:true, bal}`, or `{found:false, bal}` (never reached the server, not charged) | 20 / ≤ 1.2 KB |
| `glimmer:away` | `{}` | none | 2 |
| `glimmer:react` | `{to, e}` (slot, emote 0–5) | none | 14 |
| `glimmer:dash:create` | `{m, len, buy}` | `{ok, dash}` | 30 / 150 |
| `glimmer:dash:join` / `:leave` / `:start` | `{id}` | `{ok, bal?}` | 20 / 30 |
| `glimmer:dash:spin` | `{d, id}` | `{ok, id, st, w, f?, sc, left}` | 40 / 60–1,200 |

### 10.2 Server → client

| Event | Recipients | Shape | Payload |
|---|---|---|---|
| `glimmer:feed` | Each hall member who is not away, per socket, ≤ 1 Hz, only when non-empty | `{e?:[[slot, m, bet, win, k]], p?:pot, r?:[[from, to, e]], h?:[[slot, acct\|null, m, away]], d?:DashView}`. Entry kind `k`: 0 win ≥ 5×, 1 feature total, 2 pot win, 3 machine change. | typical 12–40, cap 400 |
| `glimmer:moved` | The socket that lost the seat | `{}` | 2 |
| `glimmer:closed` | Hall members | `{r}` | 20 |
| `arcade:wallet` | `acct:<id>`, **except** the socket that got the spin ack. Coalesced, trailing 2 s for `spin`, `feature` and `pot_seed` changes. | `{bal, esc, claim}` | 40 |
| `arcade:activity` | Channel viewers (platform) | `{g:'glimmer', id, st:'open'\|'dash', n, max:16, j?:{amt}}` (`j` lasts 60 s after a pot win) | ≤ 60 per game |

`DashView` = `{id, st (0 lobby, 1 running, 2 done, 3 void), m, len, buy, host, ms, s:[[slot, score, left]], pay?:[[slot, chips]]}`, ≤ 150 B with 8 entrants.

### 10.3 Spin ack

```json
{"ok":1,"id":"q7Xc2LmA9fZk","st":"kD3aP","w":40,"bal":18420}                                  // 58 B
{"ok":1,"id":"…","st":"…","w":120,"bal":18500,"pot":15234,"f":{"k":"h","g":7,"w":75}}             // wheel
{"ok":1,"id":"…","st":"…","w":40,"bal":18460,"f":{"k":"t","r":"<5 chars per free spin>","w":380}} // Tide Turn: 150 B typical, ≤ 1.2 KB at the 200-spin cap
{"ok":1,"id":"…","st":"…","w":60,"bal":18480,"v":1}                                               // Three Vaults pending: pick next
{"ok":1,"id":"…","st":"…","w":0,"bal":18440,"pt":15240}                                           // pot win (pt), reseed follows
{"ok":false,"code":"busy"|"pending"|"funds"|"moved"|"disabled"|"update"}
```

The client validates every stop string with `decodeStops`. If one is out of range, it shows the server totals with the reels set to the first stops, and logs one warning.

### 10.4 Latency tolerance and reconnect

**Latency tolerance.**
- **Reels.** They start on the tap. They stop at 500, 625, 750, 875 and 1,000 ms, but never earlier than 250 ms after the ack. At 3G (300 ms RTT plus about 0.5 ms on the server) this feels normal.
- **Waiting.** After 5 s without an ack: "Waiting for the hall…". After 15 s (the `request()` timeout) or a disconnect: "Your spin will settle when you're back".
- **Offline socket.** While the main socket is down, SPIN is disabled ("Reconnecting…"), because `request()` rejects at once.

**Reconnect.**
1. The client re-sends `glimmer:enter`.
2. It sends `glimmer:resume {id}` for the last unacknowledged spin or pick id.
3. `{found:false}` means the spin never reached the server: the reels return to rest and nothing was charged.
4. A pending vault reopens the door screen.

---

## 11. Byte budget per client (3G, 4 people in the hall)

The link is the platform's 3G case: 750 kbit/s down, 250 kbit/s up, 300 ms RTT, occasional loss, in a 4-person call with the cellular voice cap (platform §2.1). Figures are wire bytes: downlink payload + 92 B, uplink payload + 96 B, and 26 B of TCP ACK per message received, counted on the opposite direction.

### 11.1 Rates

**Typical:** four players spinning by hand, one spin per 2 s each; the phone is one of them.

| Flow | Rate | Wire bytes each | B/s |
|---|---|---|---|
| Down: own spin acks | 0.5/s | 70 + 92 | 81 |
| Down: hall pushes (pot ≤ 0.5/s; feed entries 3 × 0.5 × ~5 % ≈ 0.07/s, merged into the same pushes) | ≈ 0.5/s | 25 + 92 | 59 |
| Down: TCP ACKs for the phone's uplink | 0.5/s | 26 | 13 |
| **Down total** | | | **153 B/s = 1.2 kbit/s** |
| Up: spin requests | 0.5/s | 36 + 96 | 66 |
| Up: TCP ACKs for downlink | ~1/s | 26 | 26 |
| **Up total** | | | **92 B/s = 0.7 kbit/s** |

**Worst sustained:**
- the phone spins at the 700 ms client floor;
- three others spin at the 2/s server cap;
- reactions run at their cap;
- a Dash is running.

| Flow | B/s |
|---|---|
| Down: own acks 1.43/s × (75 + 92) | 239 |
| Down: hall pushes, capped by the **Glimmerhall push bucket** (200 B/s wire, 800 B depth, per recipient, on top of the platform's 3 KB/s socket bucket) | ≤ 200 |
| Down: TCP ACKs for (1.43 spins + 0.33 reacts)/s | 46 |
| **Down total** | **≤ 485 B/s = 3.9 kbit/s** |
| Up: spins 1.43/s × (36 + 96) | 189 |
| Up: reacts 0.33/s × (14 + 96) | 37 |
| Up: TCP ACKs for ≤ 2.9 down messages/s | 75 |
| **Up total** | **≤ 301 B/s = 2.4 kbit/s** |

**Peak in any 1 s window.** A 200-spin feature ack (≤ 1.2 KB + 92) plus a full push bucket (800 B) comes to ≤ 2.1 KB, inside the table lane's 3 KB per second. That case has never been seen in sampling: the longest run in 200k spins was 30 free spins, about 230 B.

**Against the platform ceilings** (table lane ≤ 4 kbit/s average and ≤ 3 KB in any 1 s down, ≤ 2.4 kbit/s up): worst sustained 3.9 down and 2.4 up. Both fit.

### 11.2 Does it fit at 3G?

| kbit/s | Down (750) | Up (250) |
|---|---|---|
| Voice, 3 streams at 24 kbit/s with overhead | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | ~4 | ~3 |
| Glimmerhall, worst sustained | 3.9 | 2.4 |
| Lamplight seat hidden on the side (optional) | 0.8 | 0.2 |
| **Total** | **≈ 156 (21 %)** | **≈ 153 (61 %)** |

**Chat delay.**
- A typical Glimmerhall message (≤ 170 B wire) adds about 2 ms of queueing ahead of chat on the roughly 600 kbit/s left after voice. The rare 2.1 KB worst burst adds about 28 ms.
- Hall pushes are deferred 50 ms whenever the main socket's writeBuffer is non-empty, and merged. Acks are never deferred, but they count against the socket bucket (platform §4.2).
- Head-of-line exposure: about 1.5 Glimmerhall segments per second typical. At 1 % loss, that is one lost segment about every 70 s, and it delays chat only if chat is in flight at that moment.

### 11.3 When nothing should cost anything

| State | Down | Up | CPU |
|---|---|---|---|
| Arcade closed, or the hall never opened | 0 | 0 | 0; chunk not loaded |
| Hall open but hidden, minimized, or 10 min without input (`glimmer:away`) | 0, unless another device changes the wallet | 0 | 0 frames, 0 timers (bots frozen, auto-spin stopped) |
| Hall visible, reels still | pot and feed pushes only (≤ 0.5/s typical, ≈ 0.5 kbit/s) | TCP ACKs | 0 frames; DOM text updates per push |
| Voice member who never opened the hall | `arcade:activity` on enter or leave only (≤ 60 B, ≤ 1 per 2 s) | 0 | 0 |

### 11.4 Server egress

| Case | Egress |
|---|---|
| Typical 4-person hall | 4 × 1.2 ≈ 5 kbit/s |
| Worst full hall (16 members) | 16 × 3.9 ≈ 62 kbit/s |

Both are negligible against the platform's 1.5 Mbit/s degrade threshold. Glimmerhall uses no action lane, so it adds nothing to lane egress.

---

## 12. Client: rendering, UI integration, input, audio

### 12.1 Where it shows up

**Entry points.**
- **Voice channel.** The ArcadeSheet tile "Glimmerhall" opens `GameStage` with the `glimmer` chunk. The video grid collapses to the voice strip on your screen only, and "Back to call" minimizes the stage (counted as away).
- **Elsewhere.** "Arcade" in the user menu, and "Play offline", open Glimmerhall with `LocalHost` (Practice). It costs the server nothing.
- **Mode choice.** When the server is reachable and you came from a voice channel, the hall asks "Play online" or "Practice". Without a server, it offers Practice only, with "Practice chips stay on this device".

**Phone portrait** (≥ 360 × 640), portrait-first:
- a top bar with back, machine name and balance;
- the reels at full width with an 8 px gutter;
- the win meter;
- a collapsible friends strip;
- the thumb zone: bet − and bet + (48 px), a round SPIN button (76 px), and Auto.

**Phone landscape:**
- the reels take the left 66 %;
- a control column on the right puts SPIN under the right thumb;
- the friends strip becomes a 4-avatar column at the far left.

**Desktop:** reels up to 720 px wide, with a hall sidebar (friends, pot, Dash).

**Android back.** `GameStage` calls `handle.back()`. Glimmerhall consumes it to close the paytable or the Dash panel. Otherwise the stage minimizes (§19).

### 12.2 Coarse state only

**Signals.** Glimmerhall writes only the platform's signals (platform §10.1):

| Signal | When it is written |
|---|---|
| `arcadeSession` | on enter, leave, away, ended |
| `arcadeWallet` | through the WalletPill outside the stage, coalesced to at most 1 write per 2 s while spinning |

**DOM chrome.**
- Balance, bet, win meter, friends strip and pot are plain DOM nodes built once at mount and updated by direct `textContent` and `classList` writes.
- That is at most 2 DOM updates per spin and one per push.
- VoicePage never re-renders on Glimmerhall traffic.
- Spin results reach the renderer by direct call (`reels.play(result)`).

### 12.3 Canvas and frame loop

**Canvas layers.** Sizing uses `runtime/canvas.ts`: a ResizeObserver on the stage, DPR capped at 2, integer device-pixel scaling, smoothing off.
- **Logical reel area:** 136 × 80 for 5 reels (5 × 24 px symbols plus 4 px gaps; 3 rows plus a frame); 80 × 80 for Orchard. It is letterboxed.
- **Static layer** (cabinet, paytable strip): redrawn only on resize or machine change.
- **Dynamic layer:** only the reel rectangle is cleared, with ≤ 25 `drawImage` calls per frame.

**Frame loop.** `runtime/loop.ts` subscribes to `lib/frames` with `{maxFps: 60}` only while reels move or a celebration runs (about 2 s per spin, ≤ 4 s for a celebration), then unsubscribes.
- **Win lines** cycle with one `setTimeout` per line change (1.2 s each, ≤ 3 rounds). Each change draws a single frame through `frames.once`, and the timer is cleared on the next spin, on hide and on unmount.
- **Reduced motion** (`prefers-reduced-motion`): reels stop within 300 ms with no blur variant, and there are no particles.
- **Accessibility.** An `aria-live="polite"` node announces "Won 1,240 (×62)" or "Returned 4".

### 12.4 Visibility (`runtime/visibility.ts`)

**When hidden** (app hidden, Electron minimized, stage minimized, or under 10 % on screen), the game:
- cancels the frame subscription and the win-line timer;
- suspends audio;
- stops auto-spin;
- freezes bots and the offline Dash clock;
- calls `host.setVisible(false)`: online, that sends `glimmer:away`.

**Idle.** Ten minutes without input while visible count as hidden ("Paused · tap to return"), so a forgotten hall costs nothing.

**Return.** Resuming re-enters, and a tap resumes auto-spin; it never resumes on its own.

### 12.5 Input

**Touch.**
- `touch-action: manipulation` on all controls.
- Buttons act on `pointerup` inside the button and handle `pointercancel`.
- A downward swipe on the reels also spins.
- Optional 10 ms haptics on reel stop, off by default.

**Keyboard** (only while the stage has focus, under the `isTyping` guard; the push-to-talk key and the app shortcuts are never bound, per platform §10.4):

| Key | Action |
|---|---|
| Enter, or Space unless Space is the push-to-talk key | Spin; during a spin, slam-stop |
| ↑ / ↓ | Bet |
| A | Auto-spin |
| P | Paytable |
| Esc | Back |

**Gamepad** (standard mapping): A spins, D-pad up and down change the bet, Y opens the paytable, B goes back. It is polled from a `frames.add(poll, {maxFps: 10})` subscription only while a pad is connected (`gamepadconnected`) and the hall is visible.

**Wake Lock** is held only while auto-spin runs and the hall is visible.

### 12.6 Spin timing and auto-spin

**Spin timing.**
- Reels stop at 500, 625, 750, 875 and 1,000 ms, never earlier than 250 ms after the ack.
- A second tap slam-stops all reels within 150 ms.
- Turbo halves the timings, for manual play only.
- The client floor between spins is 700 ms.
- There are no anticipation slowdowns.

**Auto-spin.**
- **Settings:** 10, 25 or 50 spins, never more, and a required loss limit of 10, 25 or 50 % of the starting balance.
- **Cadence:** a `setTimeout` chain with at least 1.6 s between spins, only while auto-spin is on, and no turbo.
- **Stops on:**
  - a feature;
  - a win ≥ 50× (default on);
  - a pot win;
  - hidden or away;
  - a disconnect;
  - a balance below the bet;
  - the reality check;
  - `glimmer:moved`.

### 12.7 Audio (`runtime/audio.ts`)

- **Context.** One `AudioContext` per open game, created on the first gesture in the hall, suspended when hidden, and closed on unmount.
- **Rendering.** Recipes are pre-rendered once with an `OfflineAudioContext` into mono 22.05 kHz buffers, ≤ 1 MB in total.
- **Volume.** The master defaults to 40 %, because speaker audio leaks into the mic.
- **Deafen.** Deafening in the app (`localDeafened`, `client/src/state/voice.ts:32`) silences the game.

---

## 13. Offline mode

**`hosts/local.ts`** runs the same `core/glimmer` engine on the main thread. Each spin takes ≤ 0.1 ms, and features ≤ 2 ms.
- The RNG is `crypto.getRandomValues` with rejection sampling.
- The wallet is the shared Practice wallet: a teal "PRACTICE" badge and a leaf icon. Online chips are gold, with the lantern coin.
- There is no import, export or conversion either way.
- A free one-tap refill to 10,000 is offered whenever the balance is below the current machine's minimum bet.

**What is stored on the device** (each access in try/catch with an in-memory fallback):

| What | Key |
|---|---|
| An offline pending vault (the base spin already debited Practice chips) and offline stats | `datasetto.arcade.glimmer.v1` |
| Turbo, last machine, haptics | `datasetto.arcade.prefs.v1` |

**Offline Dash.** It runs against the bots with the same rules and Practice buy-ins, and its clock pauses when the hall is hidden.

**Where it works.**
- The desktop and Android shells work with no network at all.
- Web works warm only (platform §12).
- Started from "Play offline", the hall needs no socket, no `/api/config` and no account.

---

## 14. Bots (offline hall and offline Dash only)

Bots spin the real engine with the local RNG, so their wins are genuine draws.
- **When they run.** Only while the hall is visible. Hidden means frozen, with no catch-up.
- **Scheduling.** One `setTimeout` is armed for the soonest bot. Each bot spin costs about 0.05 ms, and the DOM is touched only for feed-worthy results.

| Bot | Machine | Bet | Cadence | Habit |
|---|---|---|---|---|
| Juniper | Orchard | minimum | 2.5–4 s | After losing 40 % of a session's bankroll, takes a 60–120 s break |
| Wex | Tidepool | 2nd step | 1.6–2.5 s | Steady; reacts with sparkle to wins ≥ 25× |
| Saffi | Ember Vault | 3rd–4th step | 1.2–2 s | Raises one step after a feature, drops one after 20 dead spins |
| Gus | any | 1st–2nd step | 2–3.5 s | Changes machine every 30–60 spins |

- **Cadence and bankrolls.** Cadence is uniform jitter within the range. Each bot has a hidden 10,000-chip in-memory bankroll that refills after a 30 s break when broke.
- **In a Dash,** bots spin every 1.4–2.2 s, so 100 spins take about 3 minutes, and the vault opens at once, as online.
- **Online** there are no bots, and a Dash needs 2 humans.

---

## 15. Responsible-play framing

- **Notice.** A first-open card, which also stays as the footer, says: "Chips are play money. They can't be bought, sold, cashed out or traded, and they're worth nothing."
- **Wording.** No purchase flows, ads, "deposit", "cash" or "VIP" wording anywhere.
- **Small returns.** Wins smaller than the bet show as "Returned 4" in grey, with a soft tick and no celebration.
- **Celebrations** scale with the win: ≥ 1× small, ≥ 10× medium, ≥ 25× big, ≥ 100× huge.
- **Reality check.** After 30 minutes of active play, it shows time played, spins and net change, with Keep playing or Leave.
  - Active time accumulates per spin: the time since the previous spin, capped at 120 s.
  - The check shows at the next settle. No timer is needed.
- **Session net change** is always one tap away, and is kept on the client.
- **"Hide Glimmerhall"** is the self-exclusion option, an account setting under platform §10.6.
  - The server enforces it: `glimmer:enter` gets `code:'hidden'`.
  - Turning it back on takes effect after 24 h (§19).

---

## 16. Art and sound direction (unchanged in substance)

**Art.**
- Every symbol is a hand-authored 24 × 24 grid string: `.` is transparent, and `0`–`b` index a 12-colour palette per machine.
- At first open, `runtime/sprites.ts` rasterizes the symbols into one `ImageBitmap` atlas per machine, with:
  - a 1 px dark outline;
  - a lit variant (+25 % value) for win highlights;
  - a spin variant averaged from 4 vertical offsets.
- Cabinets are 9-slice frames from 16 × 16 grids. Digits use the platform's 5 × 7 bitmap font.
- **Orchard:** warm wood, amber and plum. The Sunseed is a rayed golden seed, the Basket woven wicker.
- **Tidepool:** teal water with coral accents. The Pearl sits in an open clam; the Starfish is orange.
- **Ember Vault:** charcoal stone with an orange glow. The runes are stone tablets with invented glyphs: circle-bar, chevrons, leaf, zigzag, dot ring.

**Sounds** are recipes built from oscillator, pitch envelope, noise, filter and ADSR:

| Sound | Recipe |
|---|---|
| Spin whirr | band-passed noise loop with 12 Hz ticks |
| Reel stop | 180 → 90 Hz sine in 60 ms, plus a click |
| Small win | two square-wave notes |
| Medium win | a 4-note pentatonic arpeggio |
| Big win | 1.5 s triangle-wave chords with a noise shimmer |
| Scatter land | FM bell, ratio 3.5, rising a step per scatter |
| Wheel tick | short click, ≤ 15 per second |
| Door | band-swept noise creak |
| Reveal | sparkle of high sine grains |
| Pot | 2.5 s fanfare |

Each machine colours its timbre: Orchard is a marimba (sine plus 4th harmonic), Tidepool bubble chirps, Ember Vault metallic FM.

---

## 17. Performance budgets

| Item | Budget |
|---|---|
| Main thread while spinning, mid-range phone (Chrome 4× CPU throttle as proxy) | ≤ 4 ms per frame at the 60 fps cap; desktop ≤ 1 ms |
| Reels still, hidden or away | 0 frames scheduled, 0 game timers (win-line timer at most 3.6 s after a win; auto-spin timer only while on) |
| Hall closed | 0 bytes of game code in the main bundle beyond the Arcade shell's tile; 0 listeners, 0 timers, 0 sockets |
| First open, one time | art ≤ 30 ms; audio rendering ≤ 50 ms (async) |
| Memory | atlases ≤ 100 KB per machine; canvases (DPR capped at 2) ≤ 4 MB; audio ≤ 1 MB; JS heap growth ≤ 8 MB |
| Bundle | `glimmer` chunk ≤ 40 KB gzip; engine and math ≤ 8 KB gzip |
| Server | base spin ≤ 0.5 ms including the transaction; feature engine ≤ 2 ms; one transaction per spin |
| Network | §11: ≤ 3.9 kbit/s down and ≤ 2.4 up worst sustained, ≤ 3 KB in any second |

---

## 18. Tests and verification (time-capped)

**Time budget.** Glimmerhall adds ≤ 10 s to the server suite and ≤ 3 s to the client suite, plus ≤ 3 min of manual checks. No run exceeds 60 s, there are no soak runs, and a scenario aborts as soon as pass or fail is certain. Every browser launched uses `--mute-audio`, `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`.

### 18.1 Server and shared core (Vitest)

| # | Suite | What it checks | Time |
|---|---|---|---|
| 1 | Purity | `core/glimmer` is in the platform grep (no `Math.random`, `crypto`, `Date`, timers, `enum`, `while`/`do`, or imports outside core) | — |
| 2 | Rules | ≥ 40 hand-built windows per machine: Orchard wild run against symbol run, Acorn and Octopus pairs, a scatter on a line paying nothing, ways of 2 × 3 × 1, a wild extending a run. Also: integer results for every ladder bet, strip lengths and counts as in §3, never two scatters in a window, every strip < 64 stops. | — |
| 3 | Exact math | `exactRtp(def)` matches §3 to 1e-9, and each machine lies in [0.94, 0.97]. Methods: per-reel symbol frequencies for lines, per-symbol E[matches] for ways, window scans for scatters, N / (1 − pR) for free spins, exhaustive search for Orchard. | < 1 s |
| 4 | Engine against math | 1M base spins through `spinBase` and `evaluate` with seeded xoshiro128** land within 4 SE of the exact base RTP, and 50k features within 4 SE of the feature mean | ≈ 3 s (the Monte Carlo above ran 600k spins in 0.6 s) |
| 5 | Determinism | A fixed seed gives a golden FNV-1a hash (`core/hash.ts`) of 10k encoded spins and features, identical in the server (Node) and client (jsdom) suites. The draw order is part of the contract, and a change needs a `DEFS.glimmer` bump. | — |
| 6 | Wire sizes | Base ack ≤ 80 B; Tide Turn ack ≤ 160 B at 10 spins and ≤ 1.2 KB at the 200-spin cap; enter ack ≤ 1 KB with 16 members; `glimmer:feed` ≤ 400 B; `decodeStops` rejects out-of-range characters per reel | — |
| 7 | Wallet and atomicity | An injected throw after the guard and after the draw rolls back everything. Retries by spin id are idempotent, including after the receipt is cleared (`settled:true`). An unknown id gives `found:false`. The balance-below-bet guard holds even when the would-be win exceeds the bet. | — |
| 8 | Conservation | The platform property test gains spins, pot contributions with carry, pot wins with reseed, vault pending, pick and 24 h auto-pick, and Dash buy-in, prize, refund and restart-refund. The §11.2 invariant holds after every operation. | — |
| 9 | Pot | Carry arithmetic over 10k random bets equals `floor(Σ bet × 75 / 10000)` chips moved. The pot draw is called once per online base spin, never for free spins or Dash spins. | — |
| 10 | Hidden information | Three sockets in one hall, scripted spins, a pending vault and a Dash. No emit to a non-owner contains `bal`, `dr` or door data before the pick, or a non-notable spin. Non-members and away members receive nothing. | — |
| 11 | Pacing | 16 members at max cadence. Per recipient: Glimmerhall wire bytes ≤ 3.9 kbit/s averaged over 10 s, ≤ 3 KB in any 1 s, pushes ≤ 1 Hz. A non-empty writeBuffer defers pushes by 50 ms and merges them. | virtual time |
| 12 | Lifecycle (injected timers, milliseconds) | seat moved to a new socket (`glimmer:moved`); 120 s seat drop; hall deleted when empty; voice leave → `hall = null`, spinning still allowed; restart voids and refunds a Dash; boot refunds leftover `dash:*` escrow; disabling the game auto-picks vaults; a `DEFS` mismatch gives `update` | — |
| 13 | Dash | 2-entrant minimum and 60 s lobby cancel; payout splits sum exactly to the pool; ties with the odd chip to the earlier finisher; freeroll gives a trophy only; immediate vault | — |
| 14 | Bot soak (fake timers) | An offline Dash of 4 bots × 100 spins and a 100k-spin hall soak. No negative balance, no NaN, every Dash ends, wallet deltas equal the sum of results. | < 2 s |

### 18.2 Virtual-clock link simulator (platform §15.2)

One extra scenario runs at 3G (750/250, 300 ms ± 50 ms, 147 kbit/s of voice each way): four members at the worst-sustained cadence for 60 simulated seconds, in under 1 s.

| Check | Pass |
|---|---|
| Chat one-way delay | p95 < 300 ms; < 450 ms with 1 % loss |
| Spin ack round trip | p95 < RTT + 100 ms |
| Table lane bytes | inside the ceilings |
| Main-socket backlog of 3 s injected | pushes deferred and merged, never queued in engine.io |

### 18.3 Client (Vitest, jsdom)

- **Zero cost.** After mount and unmount behind a fake host:
  - `frames.active === 0`;
  - no live timers;
  - no listeners;
  - the AudioContext is closed;
  - canvases are 0 × 0.

  Reels still for 5 s (fake clock) schedule 0 frames.
- **Signals.** 100 spins write `arcadeWallet` at most once per 2 s and never touch VoicePage.
- **Visibility.** Hidden stops audio, bots, auto-spin and the Dash clock (local), and sends `glimmer:away` (remote).
- **Input.** Space is skipped when it is the push-to-talk key; `pointercancel` cancels a spin; the 700 ms floor holds; a gamepad subscription exists only while a pad is connected.
- **Layout.** 360 × 640 and 640 × 360 have no horizontal scroll.
- **Storage.** A throwing `localStorage` falls back to memory.

### 18.4 Manual, bounded (≤ 3 min total)

| Check | How | Wall time |
|---|---|---|
| Shaped smoke | One scenario in `ops/bench/arcade-netbench.mjs`: one shaped headless Chrome (600/100 kbit/s, the non-voice share of 3G) auto-spinning in a hall with 3 unshaped Node bot clients at 2 spins/s, while the chat prober runs. Pass: chat p50 < 300 ms, Glimmerhall down ≤ 4 kbit/s average, no ping timeout. | 45 s |
| CPU, spinning | 15 s trace at 4× throttle, 8 spins. Pass: p95 frame cost ≤ 4 ms, no long task over 50 ms. | 15 s |
| CPU, idle | 15 s trace, reels still. Pass: 0 game frames and 0 game timers. | 15 s |
| Desktop minimized | Desktop CDP smoke: minimize the hall (`window:visibility` false) and confirm 0 rAF and that `glimmer:away` was sent | ≤ 1 min |

---

## 19. What the platform must add or change for Glimmerhall

1. **Sizes in platform §5.4, §7.1 and §15.1.** Replace "free-spin result ≤ 5 KB" with **≤ 1.2 KB**, using one base64url char per stop. The Glimmerhall row in §7.1 becomes: down 1.2 typical, 3.9 worst sustained, 18 kbit/s peak 1 s window; up 0.7 / 2.4.
2. **Event list (§5.4).** Glimmerhall events are:
   - `glimmer:enter`, `leave`, `spin`, `pick`, `resume`, `away`, `react` (C→S);
   - `glimmer:feed`, `moved`, `closed` (S→C);
   - `glimmer:dash:create`, `join`, `leave`, `start`, `spin`.

   `glimmer:brag` and `glimmer:pot` are folded into `glimmer:feed`.
3. **Per-socket emits with a per-game sub-bucket** in `arcade/handlers.ts`. Glimmerhall pushes get 200 B/s of wire bytes with an 800 B depth, merged newest-wins: the six biggest feed entries are kept, and the latest pot, membership and Dash view. Pushes are emitted per member socket rather than to a room, so the socket bucket and the writeBuffer rule apply.
4. **`wallet.transfer()` guard option**, for example `{min: {'w:<id>': bet}}`. With one leg per account per txn, spin legs are net, so the balance-≥-bet check must be explicit, or a winning spin could pass with too few chips.
5. **Lamplight weekly-net board (§11.3)** must allow-list poker kinds (`buyin`, `cashout`, `prize`, `fold`) or filter on `ref`. Its current deny-list would count slots spins in the poker board, now that the wallet is shared.
6. **Retention by kind (§11.2).** `spin` and `feature` ledger rows fold after 7 days and their `arcade_txns` rows are then deleted. Otherwise each spin keeps about 455 B for 90 days.
7. **Daily job:** auto-pick `arcade_pending` vaults older than 24 h (also at boot and on enter).
8. **`Broadcaster.toAccount(…, {except: socketId})`**, and trailing 2 s coalescing of `arcade:wallet` for `spin`, `feature` and `pot_seed` changes. The spinning socket already has `bal` in its ack.
9. **Client interfaces (§3.3).** Make `GameModule` generic in its host (`GameModule<H>`), so table-lane games mount with `GlimmerHost` (and the poker equivalent) instead of the action-lane `MatchHost`. Add an optional `GameHandle.back(): boolean` for Android back and Esc.
10. **`lib/frames` low-rate mode.** When every subscriber asks for ≤ 15 fps, schedule with `setTimeout` plus one rAF instead of a rAF every display frame. The only user is the 10 Hz gamepad poll; without this mode it costs a display-rate rAF while a pad is connected.
11. **`core/version.ts`:** add `DEFS = {glimmer: 1}`. `glimmer:enter` sends `v`, and a mismatch keeps that client on Practice.
12. **`handle()` quiet refusals.**
    - Today a limiter refusal acks `{success:false, error, code:'RATE_LIMITED'}`, and a refused non-acked event emits `error` for every kind except `signal` and `game`.
    - Needed: the `spin` and `arcade` kinds ack `{ok:false, code:'busy'}`, and non-acked Glimmerhall events (`react`, `away`) never emit `error`.
    - The platform should settle on one ack shape (`ok` or the codebase's `success`).
13. **Activity summary:**
    - optional `j:{amt}` for 60 s after a pot win, shown in the LobbyChip, with no chat line, sound or toast;
    - `st:'dash'` while a Dash is forming or running.
14. **Arcade settings (§11.4):**
    - `limits.hallMembers` (16) and `limits.dashes` (4);
    - `slotsMaxBet` trims ladders server-side;
    - turning `games.glimmer` off also auto-picks pending vaults.
15. **Self-exclusion.** The account-level "Hide Glimmerhall" is stored server-side and enforced on `glimmer:enter` (`code:'hidden'`). Re-enabling waits 24 h. Recommended, not required.
16. **Runtime helpers:**
    - `runtime/audio.ts` follows `localDeafened`;
    - a shared Wake Lock helper that table-lane games may hold while auto-play runs;
    - the 10-minute no-input "away" rule as a runtime option for table-lane games.

---

## 20. Milestones (inside platform phase 3)

| # | Milestone | Contents |
|---|---|---|
| 1 | Engine and math | `core/glimmer` defs, `evaluate`, `spinBase`, `playFeature`, `exactRtp` and the wire codec; tests 1–6 green |
| 2 | Playable offline | Tidepool on canvas with LocalHost, the Practice wallet, art, basic sounds, spin, slam-stop and phone portrait |
| 3 | All machines | Orchard with the Harvest Wheel, Ember Vault with Three Vaults and Forge Spins, the paytable pages, landscape and desktop layouts |
| 4 | Online authority | `halls/glimmer.ts`, spin transactions with net legs and the guard, idempotency, pending vault, resume, the `DEFS` check; tests 7–10 and 12 |
| 5 | Social | hall slots, `glimmer:feed` with the push bucket, reactions, the Glimmer Pot with carry, LobbyChip activity; test 11 and the simulator scenario |
| 6 | Glimmer Dash | online with escrow, offline with bots; tests 13–14 |
| 7 | Polish | sound palettes, celebrations, auto-spin limits, the reality check, keyboard, gamepad, haptics, the client tests, the bounded manual checks (§18.4), and the README section |

---

## 21. As built (Glimmerhall package)

Where the implementation fills in or differs from the sections above. The machines, strips, paytables, features and their maths are exactly §3.

### 21.1 Measured

| What | Result |
|---|---|
| Exact return (`exactRtp`, CI) | Orchard 0.948464500375659, Tidepool 0.942204601812526, Ember Vault 0.947209140804904: each within 3e-15 of §3 |
| Exact hit frequency (`exactHit`, CI) | Orchard 55.128 %, Tidepool 45.077 %, Ember Vault 50.894 % (a 5-reel win needs a run of 3, so reels 1–3 are enumerated and the trigger's reel 5 is a factor) |
| Engine against the maths (CI, seeded) | 1M base spins and 50k features per machine, every one within 4 standard errors; about 3.7 s for all three |
| Hand-built windows (CI) | 41 Orchard, 41 Tidepool, 42 Ember Vault, each checked against the engine and an independent naive reading of the rules |
| Golden replay | FNV-1a `0x6562190a` over 10k seeded spins per machine, the same in the Node and jsdom suites |
| Wire | base ack ≤ 80 B with a 7-digit balance; Tide Turn ack ≤ 160 B at 10 spins, ≤ 1.2 KB at the 200-spin cap; enter ack ≤ 1 KB with 16 members and a running Dash; a hall push ≤ 400 B |
| Bundle | `glimmer` chunk 33.9 KB gzip (budget 40), of which the shared engine and maths 6.6 KB (budget 8); the main bundle unchanged |
| Audio | the shared set plus every machine's own two win sounds render to under 1 MB |
| Server spin | one transaction, about 0.3–0.4 ms in the test harness (10k spins in 2.9 s) |
| CPU at 4× slowdown (headless Chrome, offline hall) | spinning: p95 frame cost 0.9 ms, no long task; still reels: 0 game frames |
| Simulated 3G (CI, `link.sim.test.ts`, virtual time) | chat one-way p95 170 ms, spin ack p95 341 ms, Glimmerhall down 432 B/s with framing (worst second 709 B), up 293 B/s; with 1 % loss chat p95 209 ms |
| Shaped bench (`node ops/bench/arcade-netbench.mjs --game glimmer`: real Chrome on 600/100 kbit/s, 300 ms RTT; 3 bots at about 1.9 spins/s each, reacting every 3 s; 25 s) | chat p50 168 ms, p95 172 ms; Glimmerhall down 1.75 kbit/s of Socket.IO payload (its events and all acks, the platform's probe included), about 3.4 kbit/s with framing; 21 pushes; the phone's spin acks p50 326 ms, p95 340 ms; no disconnect or ping timeout; 40.6 s wall |
| Web, two players (Chrome and Firefox, private stack) | hall from the Arcade sheet, play-money notice, friends strips, machine change and reactions seen by the other player, away and back, one Glimmer Pot for both, auto-spin at 1.6 s, a Dash for both with matching scoreboards, newcomers joining while a Dash runs; balances on screen equal the ledger, which sums to zero |
| Desktop (packaged, scratch profile) | joins from the sheet and spins; still and minimized, 0 frames. Minimized, the hall pauses and the others see the player away about 50 ms later only with the window-visibility bridge of phase 0 (P0b); without it the window still reports itself visible |
| Android (emulator, debug APK) | fits 411 × 866 dp with no sideways scroll; HOME pauses the hall and the others see the player away within 0.6 s, back 5 s later (the away gap) |

### 21.2 Differences

| # | Topic | As built | Why |
|---|---|---|---|
| 1 | Hosts (§7.3) | `GlimmerHost` (hosts/remote.ts) is one adapter over the platform's `TableHost`, used in both modes. Offline the `TableHost` wraps `hosts/local.ts`, a `LocalTableServer` that answers the same `glimmer:*` events on the device. | One code path online and offline, as the platform's table hosts intend. |
| 2 | Acks | `{ok: true, …}`, not `ok: 1`. | The platform's convention; it costs 3 B. |
| 3 | `glimmer:pick` | `{door, id}` with a 12-character id, stored under idem `g:<id>` like spins. | Resume after a lost pick answer uses the same lookup as a spin. |
| 4 | Vault feature on the wire | `{k: 'v', d, x, r, w}`: `x` is the multiplier. | A Dash ack carries no door contents, so the client needs the multiplier to show the run. |
| 5 | `DashView` | `t` is seconds left (stamped at send time), and `s` and `pay` are flat arrays. | 8 entrants fit in about 145 B. |
| 6 | Hall pushes | Each member has their own pending push. A push the platform has not sent yet (no `onSent`) is merged into the next one, which replaces it (`coalesce`), so newest-wins loses nothing. | §19 item 3's merge, done per recipient. |
| 7 | Sounds (§16) | The spin, stop, wheel, door, reveal, scatter, big and huge wins and the pot are one shared set; each machine colours its small and medium wins (marimba, bubble chirps, metallic FM). | All three machines' full sets would render to 2.6 MB, over the 1 MB budget. |
| 8 | Art | Tidepool's palette has 13 colours (a dark purple at `c`). | The platform's sprites take indices `0`–`z`. |
| 9 | `arcade_pending` | Pending vaults live in `TableApi.pending` (get, put, remove, olderThan, usable inside `wallet.tx`), which the platform added at M2 on request. | The frozen interface left it out. |
| 10 | Resume lookup | A zero-leg `wallet.transfer(…, idem, [])` tells "settled, receipt cleared" from "never arrived": a duplicate answers `dup`, anything else is refused before anything is written. | `wallet.receipt()` returns null for both. |
| 11 | Catalogue modes | The client meta lists one mode, the hall; a Dash is opened inside it. | Nothing to choose before entering. |
| 12 | Admin setting | `slotsMaxBet` (5–500) in Glimmerhall's `TableGameDef.settings`. | §19 item 14. |
| 13 | Dev rig | Dev builds expose the offline hall's debug hooks as `window.__glimmerLocal` (`rig` queues the next draws, for the browser checks). Production builds never set it, and it only reaches the offline Practice hall. | Features can be forced in a real browser. |
| 14 | Offline Dash | Every bot neighbour joins at once; the host leaving the lobby calls it off. A Dash still open when the hall closes is void and the buy-in goes back. | No humans to wait for offline. |
| 15 | `glimmer:away`, `glimmer:react` | Acknowledged with a bare `{ok: true}` (a reaction refused by the 3 s rule is still `{ok: true}`, and dropped). | The `TableHost` only has `request()`; an unanswered request would time out and count in the app's ack round-trip ring, which the chat-first guard reads. |
| 16 | Away gap (§8.2) | A change inside the 5 s gap is held and shown when the gap ends, with the state as it is then; away and back inside one gap shows nothing. | Dropping it left a player who came back within 5 s shown as away until something else changed. |
| 17 | First pot | The first `glimmer:enter` (and boot) seeds 7,500 into a pot that was never won, as a `pot_seed` txn with the fixed key `ps:first`. | The 1.5 % pot return (§4.1) assumes the seed; a fresh pot started at 0. |
| 18 | Hall seats during a Dash | While a Dash is live in a channel, nobody else gets an entrant's hall seat, and an entrant who comes back gets theirs again; this holds across the hall closing and opening again. A finished Dash is let go when its hall closes. | `DashView` names entrants by seat. A newcomer on a departed entrant's seat took that Dash row as their own. |
| 19 | Dash sheet clock | While the Dash sheet is open on a lobby or running Dash and the hall is visible, it ticks once a second from the last view's `t`. | A waiting lobby gets no pushes, so its clock stood still. No timer runs otherwise. |
| 20 | Bench | `ops/bench/games/glimmer.mjs` uses the netbench's table-game exports (`ready`, `criteria`, `stage`, `startProbes`); the phone's samples go to `window.__bench.game` and are summarized in the plugin's `stats()`. | A hall sends no lane frames; the platform added table-game support on request. |
| 21 | Reactions for screen readers | The live region says who reacted to whom ("Bo reacted to you: clap"). | It said "You: clap". |

<!--
Notes for the orchestrator (not part of the spec):
- Rates in §3.4 come from a Monte Carlo run: 200k spins per machine, 0.6 s wall time.
- Repo facts used:
  - account ids are newId('acct', 20) (server/src/services/accounts.ts:223), about 25 chars, hence hall slots;
  - the handle() refusal shape is {success:false, error, code:'RATE_LIMITED'} (server/src/socket/context.ts:110-137);
  - toAccount iterates the account's sockets (server/src/socket/index.ts:107);
  - SQLite runs WAL + synchronous=NORMAL (server/src/db/index.ts:27-28);
  - request() rejects while disconnected and defaults to an 8 s timeout (client/src/services/socket/client.ts:100);
  - localDeafened is at client/src/state/voice.ts:32.
-->
