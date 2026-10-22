# Lamplight Hold'em: game spec on the Arcade platform

No-limit Texas Hold'em with virtual chips. Nothing can be bought, sold, transferred or cashed out. You can play offline against bots with no server, or online with people in your voice channel who choose to sit down.

| | |
|---|---|
| Code id | `lamplight` |
| Shared core | `server/src/arcade/core/lamplight/`, imported by the client as `@arcade/core/lamplight/*` |
| Server runtime | `server/src/arcade/tables/{lamplight,cup,trio}.ts`, event-driven, no tick |
| Client chunk | `client/src/arcade/lamplight/` (lazy, ≤ 50 KB gzip) plus a bot Worker chunk (≤ 10 KB, offline only) |
| Transport | **table lane** only: `lamplight:*` and `arcade:*` JSON events on the main Socket.IO connection. Lamplight never opens the action lane. |
| Authority | the server shuffles, deals, validates, runs the clocks and moves chips; offline, the device does all of that |
| Wallet | the Arcade chips wallet, shared with Glimmerhall (`arcade_*` tables, migration 14) |

Every byte figure here is **wire bytes** unless marked as payload. A table-lane event costs its JSON payload plus about 92 B of framing: Socket.IO packet, WebSocket, TLS and TCP/IP (platform §5.1, §5.4).

---

## 0. What changed from the first spec

| Topic | First spec | On the platform | Why |
|---|---|---|---|
| Where the engine lives | "a folder the platform provides" | `server/src/arcade/core/lamplight/`, under the core purity rules (no `Math.random`, no `Date`, no `crypto`, no `enum`, loops bounded) | platform §3.1 |
| Currency | chips kept apart from slots credits | one chips wallet for poker and slots | platform decision "Wallet" |
| Tables in the database | `poker_*` | `arcade_wallets`, `arcade_txns` + `arcade_ledger`, `arcade_escrow`, `arcade_poker_hands`, `arcade_results`, `arcade_stats` | platform §11 |
| Deck fairness | "no deck reveal" | per-card commitments, with a proof fetched on demand. Mucked cards are still never revealed. | platform §8.1 |
| Cup and Trio registration | `lamplight:register` | `arcade:lobby:join {as: 'player'}`, which escrows the buy-in. `lamplight:register` is dropped. | one path for every lobby seat |
| Online bots | "if the host allows", any format | **cash:** Pebble and Cobble only, house-backed, rebuys capped. **Cup:** at least 2 humans, and only human buy-ins go into the pool. **Trio:** humans only. | stops chips being printed by beating weak bots |
| Server bot effort | 1 / 3 / 4 ms, in slices of 500 trials | ≤ 2 ms of CPU per decision, in slices of ≤ 200 trials. Trial caps 300 / 1,000 / 1,500. | platform §8.1 and §13.4 |
| Weekly-net leaderboard | ledger query | `arcade_stats` counters, updated in the per-hand transaction | the platform's ledger query would mix in slots spins and Glimmer Dash |
| Signals | `lamplightOpen`, `myTurn`, `seatState` | the platform's `arcadeSession` (plus a new `attention` flag). `myTurn` and `seatState` stay local to the module's own action-bar root. | platform §10.1 |
| Hidden spectator | unsubscribes | `arcade:away` / `arcade:back`, which keeps the slot for 60 s | spectators are capped at 8 per table |
| Turn timing on slow links | not covered | `ms` is stamped when the event actually leaves the queue, and time spent waiting in the queue is credited | fair clocks on 3G |
| Gamepad | polled at 10 Hz on your turn | polled by the 10 Hz turn-ring timer, so no extra timer | no idle timers |
| History after a reload | memory only | adds `lamplight:hands` (paged) and `lamplight:record` | history survives a reload |
| Slow tests | `test:slow` and a 2-minute network check | 5-card enumeration moves into the default suite (about 1 s). Chi-square is dropped (the exhaustive mapping is exact). The network check becomes a virtual-clock scenario (< 1 s). | the owner's verification-time complaint; platform §15 |
| Soak | ≤ 2 min | ≤ 60 s on 4 worker threads, stopping as soon as the result is certain | platform rule: no run over 60 s |

---

## 1. Names

| What | Name |
|---|---|
| Game | Lamplight Hold'em |
| Cash tables | Open Tables, in four stake tiers: Pebble 5/10, Cobble 25/50, Boulder 100/200, Summit 500/1000 |
| Sit-and-go | Lamplight Cup |
| 3-player jackpot | Firefly Trio, with the Firefly multiplier |
| Online currency | chips (the Arcade wallet, shared with Glimmerhall) |
| Offline currency | Practice chips (the device's practice wallet, badged PRACTICE) |
| Bot levels | Greenhorn, Regular, Sharp |
| Bots | Marlow Finch, Auntie Brine, Pip Tanager, Vesna Corr, Old Tamsin, Jory Vane, Nell Ashcombe, Captain Wick, Bramble |

All names, art, sounds and text are original. The naming rules and the pre-release name check are in platform §18.

---

## 2. Formats

### 2.1 Open Tables (cash)

- **Table setup.** The table's creator (the host) picks the stakes tier, the number of seats (2 to 9, default 6) and the bots (off by default online). Creating a table is `arcade:lobby:create {ch, game: 'lamplight', mode: 'open', cfg}`. The table exists at once: an Open Table has no registration phase.
- **Buying in.** A buy-in is 40 to 100 BB from the wallet, default 100. You can rebuy or top up to 100 BB between hands. Sitting down needs at least the minimum buy-in (400 at Pebble).
- **Sitting out.** "Sit out next hand" keeps your seat. If you missed your BB, or you are new at the table, you choose "post BB now" or "wait for BB".
- **Leaving.** Your stack is paid back when the hand ends. "Leave now" folds first. If you come back to the same table within 10 minutes, you must buy in with at least the stack you left with. The server keeps that amount in memory for 10 minutes.
- **No rake.**
- **Online bots** are allowed only at Pebble and Cobble, only when the host turns them on and the admin setting `serverBots` is on, and only within the server-wide cap of 6 poker bots.
  - Bot stacks are backed by the house (§12).
  - A bot seat may buy in at most 3 times per table session, then the bot leaves.
  - So the house's exposure is at most 3 × 100 BB per bot seat: 3,000 chips at Pebble, 15,000 at Cobble.

### 2.2 Lamplight Cup (2 to 9 players)

- **Buy-in and prizes.** The buy-in is 500, 2,000 or 10,000. Everyone starts with 1,500 tournament chips. Tournament chips are not wallet chips.
- **Registering** is `arcade:lobby:join {id, as: 'player'}`. It moves the buy-in from your wallet into escrow in the same transaction. `arcade:lobby:leave` before the start refunds it. The host starts the Cup once at least 2 have registered, or it starts by itself when every seat is taken.
- **Blinds:** 10/20, 15/30, 25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, 400/800, 600/1200, 800/1600, 1000/2000, then ×1.5, rounded to 10.
- **Levels** last 5 minutes online (wall time, checked at each hand start) and 10 hands offline.
- **Payouts** depend on the number of **humans** online, or on all players offline:

  | Players | Split |
  |---|---|
  | 2–3 | 100 % |
  | 4–5 | 70 / 30 |
  | 6–9 | 50 / 30 / 20 |

  Shares are floored, and first place gets the remainder.
- **Bots online** (if the host allows, with at least 2 humans registered):
  - Bots buy in nothing. The pool is the human buy-ins only, and places are counted among humans only. A bot never takes a prize.
  - The Cup ends as soon as the human places are settled. With 2 humans that is the moment one of them busts. Bots never play on alone.
- **Offline,** bots fill the seats, the pool is practice chips, and places count everyone.

### 2.3 Firefly Trio (3 players)

- **Buy-in and stacks.** The buy-in is 200, 1,000 or 5,000, and everyone starts with 500. Registration works as in the Cup. Online, the Trio is **humans only**: with fewer than 3 people, the sheet offers the Trio offline against bots.
- **Blinds** rise every 2 minutes online, or every 5 hands offline: 10/20, 15/30, 20/40, 30/60, 40/80, 50/100, 60/120, 80/160, 100/200, 120/240, 150/300, 200/400, then ×1.25, rounded to 10.
- **The multiplier draw.** When the third player registers, the server draws `crypto.randomInt(1_000_000)` against the multiplier table below (`arcade.trioTable`, default shown). Pool = buy-in × multiplier.
  - The draw is sent in `lamplight:trio`.
  - The client reveals it over 3 s, and the server deals the first hand 3.5 s after the draw.
  - Once the multiplier is drawn, nobody can unregister.

| Multiplier | Weight per million | Payout 1st / 2nd / 3rd |
|---|---|---|
| ×2 | 740,000 | 100 / 0 / 0 |
| ×3 | 160,000 | 100 / 0 / 0 |
| ×5 | 65,000 | 100 / 0 / 0 |
| ×10 | 26,000 | 100 / 0 / 0 |
| ×25 | 7,500 | 84 / 8 / 8 |
| ×100 | 1,400 | 80 / 10 / 10 |
| ×1000 | 100 | 80 / 10 / 10 |

- **Expected value.** The expected multiplier is 2.9725 buy-ins against the 3 paid in, so 0.9 % is a sink against the daily claim. The admin validator rejects any table with EV ≥ 3 or weights that do not sum to 1,000,000.
- **Offline,** the draw uses the default table from `core/lamplight/trio.ts` with the device's seeded generator, and the pool is practice chips.

### 2.4 Tournament edge cases

- **Busts in the same hand:** the bigger starting stack places higher. Equal stacks split those prizes, and the odd chip goes to the first of them clockwise from the button.
- **Disconnected seats** keep posting blinds and fold when facing a bet (check when possible). Once a seat is sitting out it acts instantly, so it does not slow the table.
- **Abandoned tournaments.** If every human has been disconnected for 10 minutes, the server ends the tournament. Unpaid prizes are split among the remaining humans in proportion to their stacks: floored, with the remainder to the biggest stack.
- **No humans connected.** Bots use the cheap decision path (preflop chart, at most 100 trials), so a stranded tournament costs almost no CPU until the 10-minute rule ends it.

---

## 3. Rules engine (`core/lamplight/engine.ts`)

The engine is pure TypeScript, shared by the server and the device. It has no RNG and no clock: the host passes in the shuffled deck and `now`. String unions and `as const` objects replace enums.

**Cards** are integers 0 to 51. `rank = c >> 2`, where 0 is a 2 and 12 is an ace. `suit = c & 3`, in the order ♣ ♦ ♥ ♠. The shuffle is `cards.ts: shuffle(deck, randInt)`, a Fisher–Yates with an injected `randInt(n)`:
- on the server, `crypto.randomInt(i + 1)`;
- offline, xoshiro128** from `core/rng.ts`, seeded from `crypto.getRandomValues`, with rejection sampling.

**Deal order** (fixed, because the deck proof names deck positions): hole cards go round-robin from the seat left of the button, in two passes, then the flop, turn and river take the next positions. There are no burn cards.

**Rotation (the big blind moves forward one seat).**
- The first button is random.
- Each hand, the BB moves to the next active seat clockwise.
- With 3 or more players, the SB is the nearest active seat counter-clockwise of the BB, and the button is the nearest active seat counter-clockwise of the SB.
- Heads-up, the other player has the button and posts the SB.
- Nobody skips a BB, though someone may occasionally pay the SB or hold the button twice. There are no dead buttons.

**First to act.** Heads-up, the button acts first preflop and the BB on later streets. Otherwise, the seat after the BB acts first preflop, then the first active seat after the button.

**Antes** are supported (unused by default). They are dead money: counted in `totalBet`, not in `streetBet`.

**Betting**
- **State.** Each street tracks `currentBet` and `lastFullRaise`, which starts at the BB. Each seat stores `actedAt`: the value of `currentBet` at its last voluntary action, or `null` if it has not acted. Posting a blind is not an action, which is why the BB keeps its option.
- **Basic actions.** With `toCall = currentBet − streetBet`:
  - fold is always legal;
  - check is legal when `toCall == 0`;
  - call costs `min(toCall, stack)`, so a short call is an all-in.
- **Bet or raise to `T`** requires `currentBet + lastFullRaise ≤ T ≤ streetBet + stack`. The smallest opening bet is the BB. An all-in below the minimum is always legal.
- **Full raise:** `T − currentBet ≥ lastFullRaise`, which sets `lastFullRaise = T − currentBet`. A short all-in moves `currentBet` but leaves `lastFullRaise` unchanged.
- **Reopening.** A seat may raise only if `actedAt == null` or `currentBet − actedAt ≥ lastFullRaise`. One short all-in therefore does not reopen the betting, but several that add up to a full raise do.
- **Street end.** The street ends when every seat that can still act has acted and matched `currentBet`, or when at most one seat can act and it has matched the largest all-in. If everyone else folds, the last player wins without showing.
- **Uncalled bet.** When the street closes, any amount the top bettor put in above the second-highest `streetBet` (folded seats count) goes back to them.
- **Runout.** When at most one seat can act and bets are matched, every live hand is turned face up. The remaining streets are dealt 900 ms apart, or instantly in offline fast mode.

**Pots** are built from each seat's `totalBet` after uncalled refunds. A player folds only when facing a bet, so the largest contribution always belongs to a live seat. Chips from folded players feed every level they reach. The loop is bounded by the seat count, as the core rules require: every pass empties at least one live seat.

```ts
export function buildPots(seats: readonly { seat: number; total: number; folded: boolean }[]): Pot[] {
  const rem = seats.map(s => s.total);
  const pots: Pot[] = [];
  for (let pass = 0; pass < seats.length; pass++) {
    let level = 0;
    for (let i = 0; i < seats.length; i++)
      if (!seats[i].folded && rem[i] > 0 && (level === 0 || rem[i] < level)) level = rem[i];
    if (level === 0) break;
    let amount = 0; const eligible: number[] = [];
    for (let i = 0; i < seats.length; i++) {
      if (!seats[i].folded && rem[i] > 0) eligible.push(seats[i].seat);
      const take = Math.min(rem[i], level); amount += take; rem[i] -= take;
    }
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligible, eligible)) prev.amount += amount; else pots.push({ amount, eligible });
  }
  return pots; // pots[0] = main pot; a test asserts the pots sum to all contributions
}
```

**Showdown**
- **Order.** The last river bettor or raiser shows first. If the river was checked through, the first live seat after the button shows first. Then it goes clockwise.
- **Auto-muck** is on by default. A hand that cannot beat or tie the best hand already shown, in any pot it is eligible for, is mucked. It is never sent anywhere, and it is not revealed by the deck proof either (§8).
- **Always shown:** winning hands, and every hand in an all-in runout.
- **Uncontested win:** the winner may tap "Show" within 4 s (`lamplight:show`). The next hand waits for it.

**Awarding**
- Pots are paid from the last side pot back to the main pot. The best `eval7` among the eligible seats wins.
- A k-way tie pays `floor(amount / k)` to each winner. Odd chips go one each, clockwise, starting from the seat after the button.
- All amounts are integers, and blinds are multiples of 5.

---

## 4. Hand evaluator (`core/lamplight/evaluate.ts`)

`eval7(cards)` takes 5 to 7 cards. It returns `cat << 20 | r0 << 16 | r1 << 12 | r2 << 8 | r3 << 4 | r4`, with ranks 0 to 12 and `cat` from 8 (straight flush) down to 0 (high card).

```
build suitMask[4], counts[13], allMask
for each suit with popcount(suitMask) ≥ 5:      // with ≤ 7 cards a flush rules out quads and full house
   h = straightHigh(suitMask); return h ≥ 0 ? pack(8,h) : pack(5, top5(suitMask))
scan ranks 12→0 into quads[], trips[], pairs[]          // fixed 13-step for loop
quads:            pack(7, q, highest other rank)
trips + (2nd trips or pair): pack(6, t0, max(trips[1], pairs[0]))
straightHigh(allMask) ≥ 0: pack(4, h)
trips:            pack(3, t, k1, k2)
two pairs:        pack(2, p0, p1, highest remaining rank incl. pairs[2])
pair:             pack(1, p, k1, k2, k3)
else              pack(0, top5)
straightHigh(m): x = (m << 1) | ((m >> 12) & 1)  // bit0 = ace low
   for h = 13..4: if ((x >> (h-4)) & 31) == 31 return h-1; return -1
```

It uses no lookup tables. It is about 3 KB minified and takes roughly 0.3 to 0.5 µs per call.

| Cards | Expected |
|---|---|
| As Ks Qs Js Ts 2d 3c | straight flush, ace high |
| Ad 2d 3d 4d 5d 9c 9h | straight flush, 5 high |
| Ah 2c 3d 4s 5h Kd Kc | straight, 5 high; loses to 6c 2c 3d 4s 5h Kd Kc |
| 7h 8h 9h Th Jc 2h Qd | flush T-9-8-7-2, beats the Q-high straight |
| 2h 4h 6h 8h Th Qh Ah | flush A-Q-T-8-6 |
| Kh Kd Kc 7s 7h 7d 2c | full house, K over 7 |
| Qs Qh Qd 9s 9h 5c 5d | full house, Q over 9 |
| 8s 8h 8d 8c Ad Kc Qh | four 8s, A kicker |
| As Ah Ks Kh 9c 9d 7s | two pair A-K, 9 kicker |
| 5c 6d 7h 8s 9c 9d 9h | straight, 9 high |
| Board Ah Kh Qh Jh Th, any hole cards | split |
| Board Ac 7d 4s 2h 9c: AK vs AQ | AK wins on kicker |
| Board 9s 9d 6c 6h Ks: A2 vs QJ | A2 wins (A beats the board K) |

**Equity oracle:** Ah Kh against Qs Qd on 2h 7h Qc 9s has 7 outs in 44, or 15.909 %. The test enumerates every river card.

---

## 5. Clocks, disconnects, idle, hidden

| | Open Tables | Lamplight Cup | Firefly Trio |
|---|---|---|---|
| Action clock | 15 s | 15 s | 10 s |
| Time bank | 30 s, +5 s per 10 hands, max 60 s | 30 s | 15 s |

- **One timer per table.** The server table holds one `setTimeout`, armed for the earliest of: the action deadline, a bot's act time, the next runout street, or the next hand's start. Nothing is armed while no hand can run. Cup and Trio levels are read from wall time at each hand start, so they need no timer of their own (platform §9.5).
- **The clock.** The time bank starts by itself when the action clock ends. When both run out, the server checks if it can, and otherwise folds. Actions are accepted up to 500 ms past the deadline.
- **Displaying it.** Clients count down from the `remainingMs` they receive and never compare clocks. They subtract half of the main socket's recent ack round trip, from `socketClient.ackRtt()` (platform §6.4).
- **Queue credit.** `ms` is computed when the event leaves the server's per-socket queue, not when it was produced (§7.4). If the event that gave a seat its turn waited more than 250 ms in that seat's queue, its deadline is extended by the wait, up to 3 s per turn. The table then gets a `lamplight:bank` clock update.
- **Timeouts.** Two in a row mark the seat as sitting out. Cash games skip a sitting-out seat. Tournaments keep posting its blinds and folding, instantly.
- **Disconnects** (main socket):
  - The seat keeps its place and the action clock, but not the time bank, and sits out after 2 hands.
  - A cash seat is released after 5 minutes disconnected, or 10 minutes sitting out, and the stack goes back to the wallet.
  - Seats belong to account ids. A reconnect brings your own cards back (§7.4).
- **Idle.** An online table closes 2 minutes after the last human leaves its seats, or once all of a cash table's humans have sat out for 5 minutes. Tables never run with only bots.
- **Hidden** (the platform's merged visibility, §10.3: window hidden or minimized, stage minimized, or stage off screen):
  - **Seated players** keep the small event stream. The client applies events to its view model and draws nothing. On their turn they get one chime and the attention signal (§14.6).
  - **Spectators** send `arcade:away {id}` and get nothing. `arcade:back {id, since}` brings the missed events or a snap. The spectator slot is kept for 60 s while away.
  - **Offline tables** pause completely: clocks freeze, bots stop and the Worker goes idle.
- **Closing the view.** At a cash table, closing means "leave after this hand". In a tournament it changes nothing: the seat stays and the timeout rules apply. Minimizing ("Back to call") is hidden, not leaving.

---

## 6. State model and core API

```ts
type Card = number;
type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'done';
type SeatStatus = 'empty' | 'waiting' | 'active' | 'sittingOut' | 'busted';
interface PlayerRef { accountId: string | null; botId: string | null; avatarSeed: number }   // names resolved from presence on display
interface Seat {
  seat: number; player: PlayerRef | null; status: SeatStatus; stack: number;
  inHand: boolean; folded: boolean; allIn: boolean;
  streetBet: number; totalBet: number; actedAt: number | null;
  timeBankMs: number; timeouts: number; connected: boolean; missedBB: boolean;
  hole: [Card, Card] | null;               // host only; a view carries only its own
}
interface Pot { amount: number; eligible: number[] }
interface BlindLevel { index: number; sb: number; bb: number; ante: number; endsAt: number | null; endsAfterHand: number | null }
interface TableConfig {
  format: 'open' | 'cup' | 'trio'; tier?: 'pebble' | 'cobble' | 'boulder' | 'summit'; seats: number;
  schedule: readonly BlindLevel[]; buyInMin: number; buyInMax: number;
  actionMs: number; timeBankMs: number; bots: BotLevel | null;
}
interface HandState {
  handNo: number; button: number; sbSeat: number; bbSeat: number; street: Street;
  board: Card[]; currentBet: number; lastFullRaise: number; lastAggressor: number | null;
  toAct: number | null; turnQ: number; deadline: number; pots: Pot[]; deck: Card[]; deckPos: number;
}
interface TableState { id: string; config: TableConfig; seats: Seat[]; hand: HandState | null; q: number; level: BlindLevel; handsPlayed: number; prizePool?: number; multiplier?: number }
type Action = { kind: 'fold' | 'check' | 'call' | 'allin' } | { kind: 'bet' | 'raise'; to: number };
type Result = { ok: true; events: GameEvent[] } | { ok: false; code: 'not_your_turn' | 'stale' | 'illegal' | 'amount' };
```

**API.** The API mutates the host's state in place and returns events.
- **Setup:** `createTable(config)`, `seat(state, n, player, stack)`, `startHand(state, deck, level, now)`.
- **Play:** `act(state, seat, action, now)`, `timeout(state, seat, now)`, `legal(state | view, seat)`. `legal` works on a view too, so the client computes `{toCall, minTo, maxTo, pot, canRaise}` itself and no "legal actions" message is needed.
- **Serializers and mirrors** (`views.ts`): `viewFor(state, seat | null)`, `publicEvent(e)`, `privateEvent(e, seat)` and `applyEvent(view, e)`. These are the only functions that produce anything sent to a client.

**Rules for `turnQ` and `deadline`.**
- `turnQ` is the `q` of the event that gave the current seat its turn. An action is stale only if its `q` is older than `turnQ`. That way, a seat change or level event arriving in between does not reject a valid action.
- `deadline` is `now + actionMs`, with `now` passed in by the host. Core never reads a clock.

**Core files**

```
server/src/arcade/core/lamplight/
  cards.ts      card ints, parse/format, shuffle(deck, randInt)
  evaluate.ts   eval7, straightHigh
  engine.ts     createTable, seat, startHand, act, timeout, legal, buildPots, awards
  views.ts      viewFor, publicEvent, privateEvent, applyEvent
  schedule.ts   blind schedules; levelAt({elapsedMs} | {hands})
  payouts.ts    Cup/Trio splits, human-only places, abandoned split
  trio.ts       default multiplier table, drawMultiplier(u ∈ [0, 1e6)), validateTable, exact EV
  proof.ts      leaf/root byte layouts and verify(proof, sha256) with an injected hash
  bots.ts       createThinker(view, level, rng) → { step(maxTrials): boolean; decide(): Action }
  ranks169.ts   committed 169-class strength table (generated once, about 1 KB)
  ranges.ts     opening, 3-bet and push/fold tables
```

---

## 7. Networking: the table lane

### 7.1 Rooms and recipients

| Room | Who | Gets |
|---|---|---|
| `table:<id>` | seated players and watchers who are not away | every public `lamplight:*` event |
| `acct:<accountId>` | all of that account's sockets | `lamplight:hole`, `arcade:wallet` |
| `lobby:<id>` | Cup and Trio registrants before the start | `arcade:lobby` (≤ 2 Hz, coalesced) |
| voice channel viewers | through `arcade:activity` only | `{g: 'lamplight', id, st, n, max, w, x: 'Cobble 25/50'}`, on seat changes, at most once per 2 s |

- **No broad emits.** `io.to(channelId)` is never used. A running Open Table's seat changes go to its members as `lamplight:seat`, not as `arcade:lobby`, so nobody gets both.
- **Delivery.** Rooms define who receives an event. Delivery goes through the platform's per-socket paced emitter (§7.4): the hub iterates the room's local socket set and calls `emitPaced(socket, ev, data)`.

### 7.2 Server → client events

Every public event carries the table id `t` (8 characters) and the table sequence number `q`, which is consecutive per table. The private `hole` and the droppable `emote` carry no `q`. Sizes are typical payloads; add 92 B for the wire.

| Event | Shape | To | Payload |
|---|---|---|---|
| `lamplight:snap` | `{t, q, cfg:{f, tier, sb, bb, an, seats, act, tb}, lv:{i, sb, bb, an, ends}, me, seats:[{n, a\|b, st, stk, sb, tb, fl}], h:{no, btn, sb, bb, st, board, cb, lfr, toAct, ms, cr} \| null, hole?, s?, pool?, mult?, pay?}` | the joiner, after sit, watch, sync or overflow | ≤ 1.5 KB (9 seats) |
| `lamplight:hand` | `{t, q, no, btn, sb, bb, lv, stk:[…], cr}`. `cr` is the commitment root, base64url, 43 characters. | table | ~150 |
| `lamplight:hole` | `{t, no, c:[a, b], s:[salt, salt]}`. Salts are 16 B each, base64url (22 characters). | owner's `acct:` room | ~80 |
| `lamplight:act` | `{t, q, s, k, a, st, cb, mr, n, ms}`. `k` is one of `f x c b r a`. A timeout's automatic action sets `to: 1`. | table | ~75 |
| `lamplight:street` | `{t, q, st, c:[…], n, ms}` | table | ~60 |
| `lamplight:bank` | `{t, q, s, ms, b}`. `b: 1` means the time bank started; otherwise it is a deadline credit. | table | ~30 |
| `lamplight:show` | `{t, q, rv:[{s, c}], pots:[{a, w:[…], each}]}`. Also sent for an uncontested win, with no reveals. | table | 100–300 |
| `lamplight:end` | `{t, q, stk:[…], next}`. `next` is the ms until the next hand: 3,000, or 4,000 after an uncontested win, or 5,000 after reveals. | table | ~70 |
| `lamplight:seat` | `{t, q, s, a\|b, st, stk, fl}`. Changes to a seat's connected flag are coalesced to at most one event per 2 s per seat. | table | ~80 |
| `lamplight:level` | `{t, q, i, sb, bb, an, ends}` | table | ~60 |
| `lamplight:trio` | `{t, q, mult, pool, pay:[…]}` | table and lobby | ~60 |
| `lamplight:cupEnd` | `{t, q, places:[{a, p, won}]}` | table | ~150 |
| `lamplight:emote` | `{t, s, id}`, newest-wins | table | ~30 |

**Not sent.** There are no pot events: the client mirror computes pots and uncalled refunds with the shared engine. There are no "legal actions" events: `legal()` runs on the view.

### 7.3 Client → server intents (all acked, zod-validated, through `handle()`)

| Event | Shape → ack | Limiter |
|---|---|---|
| `lamplight:act` | `{t, h, q, k, a?}` → `{ok}` \| `{ok: false, code}`. A retry with the same `(h, q, k, a)` after a lost ack returns `{ok: true, dup: true}`. | `arcadeAct` (4/s) |
| `lamplight:sit` | `{t, seat, buyIn, post: 'now'\|'wait', id}` → `{ok}`, then a `snap`. `id` is the idempotency key for the buy-in txn. | `arcadeAct` |
| `lamplight:leave` | `{t, now?, id}` → `{ok}` | `arcadeAct` |
| `lamplight:sitOut` | `{t, on}` → `{ok}` | `arcadeAct` |
| `lamplight:topUp` | `{t, amount, id}` → `{ok}`, applied between hands | `arcadeAct` |
| `lamplight:show` | `{t, h}` → `{ok}` (uncontested show, within 4 s) | `arcadeAct` |
| `lamplight:emote` | `{t, id}` → `{ok}`; at most 1 every 3 s, enforced by the table | `arcadeAct` |
| `lamplight:sync` | `{t, since}` → `{ok, mode: 'events'\|'snap'}`, then the events or the snap through the queue | `arcade` |
| `lamplight:hands` | `{t?, before?}` → `{rows:[{t, h, at, f, tier, net, pot}]}`, at most 20 rows (≤ 1.6 KB) | `arcade` |
| `lamplight:record` | `{t, h}` → one hand record filtered for the caller (≤ 1.2 KB) | `arcade` |
| `lamplight:proof` | `{t, h}` → the deck proof (≤ 3.2 KB, §8.2) | `arcade` |
| Platform events | `arcade:lobby:create`, `:join` (sit as a spectator, or register for Cup/Trio), `:leave`, `:config`, `:bots`, `:start`, `arcade:invite`, `arcade:board`, `arcade:away`, `arcade:back` | `arcade` |

Invalid input is dropped quietly: debug log only, no toast. Only the sender's own refused action gets a short code, shown as a one-line hint above the action bar.

### 7.4 Ordering, resync and pacing

- **Order.** `hole`, the snap and every table event for one socket go through that socket's single app-side queue, so they arrive in the order they were produced. Acks bypass the queue but carry no table state, which is why the snap is an event and not an ack payload.
- **Gaps.** The client keeps `lastQ`.
  - `q == lastQ + 1`: apply.
  - `q ≤ lastQ`: ignore (a duplicate after a sync).
  - `q > lastQ + 1`: send `lamplight:sync {since: lastQ}`. That should never happen on a reliable socket, so the server logs it at debug level.
- **Ring.** Each table keeps a ring of the last 64 public events (about 3 hands, about 6 KB), plus each seat's `hole` for the current hand.
  - If `since` is still inside the ring, `sync` replays from it. When the replay includes the current hand's `hand` event, the requester's own `hole` follows it.
  - Otherwise it sends a snap built at send time.
- **Pacing** (platform §4.2, shared by all Arcade non-ack emits on that socket):
  - The bucket is 3 KB/s with a 6 KB depth. Lamplight's own peak of 3 KB in any second never empties it on its own (§7.5).
  - **Chat first:** while the socket's `conn.writeBuffer` is non-empty, Lamplight events wait in steps of 50 ms. Chat and signalling therefore never queue behind poker inside engine.io.
  - **Overflow:** more than 32 queued Lamplight events, or an oldest event over 2 s old, drops that socket's Lamplight queue and sends one fresh `lamplight:snap`.
  - **Emotes** are newest-wins per seat and are dropped first.
  - `ms` fields are computed from the absolute deadline when the event leaves the queue.
- **Reconnect** (main socket). After `auth:success`, the client sends `lamplight:sync {t, since: lastQ}` for its seat or watched table. The seat was never released (§5), so this is all a reconnect needs.
- **Version.** `GET /api/config` and `auth:success` carry `arcade.proto.lamplight = 1`. A client with another version shows "Update the app to play online" and still plays offline.

### 7.5 Byte budget

**Per hand, to one seated client** (wire bytes = payload + 92 per event):

| Event | 4-handed typical | 6-max typical | 9-max long hand |
|---|---|---|---|
| `hand` + `hole` | 1 + 1 → 414 | 1 + 1 → 424 | 1 + 1 → 432 |
| `act` (167 each) | 8 → 1,336 | 12 → 2,004 | 24 → 4,008 |
| `street` (152 each) | 3 → 456 | 3 → 456 | 3 → 456 |
| `bank`, `seat` | — | — | 3 → 416 |
| `show` + `end` | 404 | 514 | 564 |
| Acks for own actions (107 each) | 2 → 214 | 2 → 214 | 2 → 214 |
| **Down per hand** | **2.8 KB** (17 messages) | **3.6 KB** (21) | **6.1 KB** (35) |
| **Up per hand** (own acts at 141 B, TCP ACKs at 26 B per message received) | 282 + 442 = **0.7 KB** | 282 + 546 = **0.8 KB** | 282 + 910 = **1.2 KB** |

The deck commitment adds about 100 B per hand (`cr` plus two salts), about 3 % of the total.

**Rates**

| Table | Hand length | Down avg | Up avg |
|---|---|---|---|
| 4 humans | ~45 s | **0.5 kbit/s** | **0.13 kbit/s** |
| 6 humans | ~60 s | 0.5 kbit/s | 0.11 kbit/s |
| 1 human + 5 bots (worst sustained) | ~15 s | **1.9 kbit/s** | **0.44 kbit/s** |
| Spectator | as the table | ≈ the same, minus `hole` and acks | TCP ACKs only |
| Hidden spectator | — | **0** | **0** |
| Arcade closed | — | **0** | **0** |

**Peaks**
- **Any 1-s window, down:** at most 3 KB (24 kbit/s). That is a runout second (2 acts, 2 streets, `show`, `end`, about 1.4 KB) plus a snap (≤ 1.6 KB) at worst. A typical showdown second is about 1.2 KB.
- **Any 1-s window, up:** about 0.35 KB (2.8 kbit/s): one act plus the TCP ACKs for up to 8 messages.
- **On demand:** a proof is ≤ 3.2 KB and a history page ≤ 1.6 KB. Both are acks, counted against the bucket and rate-limited.

**3G check.** One 3G phone (750 kbit/s down, 250 up, 300 ms RTT) at a 4-player table, in a 4-person voice call with the cellular voice cap (platform §2.1):

| | Down (750) | Up (250) |
|---|---|---|
| Voice, 3 streams at 24 kbit/s with overhead | 147 | 147 |
| App socket (chat, presence, signalling, heartbeat) | ~4 | ~3 |
| Lamplight, worst sustained (bot-heavy) | 1.9 | 0.44 |
| **Total average** | **153 (20 %)** | **150 (60 %)** |
| Lamplight peak second | 24 | 2.8 |
| **Total in the peak second** | **175 (23 %)** | **153 (61 %)** |
| Without the voice cap | ~500 (67 %) | ~480 (192 %): the call overflows the link, not the game |

This is inside the platform's table-lane ceilings (≤ 4 kbit/s average and ≤ 3 KB in any second down; ≤ 2.4 kbit/s average up).

**Effect on chat**
- **Queueing.** Lamplight waits whenever chat is queued in engine.io, so chat can only wait for poker bytes already handed to TCP. That is at most one peak burst of 3 KB, or ≤ 40 ms at the ~600 kbit/s left after voice. A single event (~170 B) adds about 2 ms.
- **Loss.** At 1 % segment loss, Lamplight adds about 0.4 segments/s to the shared stream at a human table and about 1.4 at a bot-heavy one. That is one extra head-of-line stall of about one RTO (~600 ms) every ~250 s or ~70 s respectively, and only when a chat message happens to be in flight behind the lost segment. For comparison, an action game on the same stream would cause one every few seconds, which is why action games have their own lane.

**Server**
- **Egress:** 1.9 kbit/s × (seated humans + spectators, up to 8). Worst case is about 17 kbit/s per table (1 human + 5 bots + 8 spectators), and 10 tables at most is ≤ 0.2 Mbit/s. The paced emitter adds these bytes to the "Arcade egress" usage counter.
- **CPU:** < 0.2 ms per action, excluding bots. A bot decision is ≤ 2 ms of CPU in slices of ≤ 200 trials (§13).
- **Memory:** about 22 KB per table, including the 64-event ring.

---

## 8. Authority, hidden information, deck proof

### 8.1 Hidden information

- **The deck lives only in server memory.** Clients never see the RNG, a seed or the undealt deck.
- **Only the views serialize.** `viewFor`, `publicEvent` and `privateEvent` produce everything a client receives. The emitter only accepts their output types, never `TableState`.
- **Hole cards** go only to `acct:<accountId>`. Spectators and bot seats get `null`, and bot cards never leave the server.
- **The board** is sent one street at a time.
- **Bots** decide from `viewFor(botSeat)` only: a fresh object, never the table state.
- **Validation.** Only the server calls `startHand` and `act`. It checks the turn, the hand number, `turnQ`, amount bounds, and the wallet when someone sits down.
- **Collusion over voice** cannot be prevented, and it is accepted for play chips. The history drawer says so.

### 8.2 Deck commitment and proof

**At the deal**, the server draws a 32-byte `handSecret` with `crypto.randomBytes` and computes:
- for each deck position `i` (0–51), a salt: `salt_i = HMAC-SHA-256(handSecret, u8 i)[0..16]`;
- for each position, a leaf: `leaf_i = SHA-256(u8 i ‖ u8 card_i ‖ salt_i)`;
- the root: `root = SHA-256(leaf_0 ‖ … ‖ leaf_51)`.

**What clients get during the hand.** `lamplight:hand` carries `cr = base64url(root)` before any card is visible. `lamplight:hole` carries the owner's two salts.

**Storage.** `handSecret`, the 52-byte deck and the root go into `arcade_poker_hands` with the hand record, in the per-hand transaction.

**The proof.** `lamplight:proof {t, h}` is allowed for 30 days, only after the hand has ended, and only for accounts listed in that hand's `seats`. Anyone else gets `{ok: false, code: 'forbidden'}`. The answer:

```json
{"ok":true,"root":"<43>","L":"<base64url of 52 × 32 B leaves, 2,219 chars>",
 "rv":[{"i":12,"c":47,"s":"<22>"}, …]}
```

- **`rv` holds** the board, the caller's own two cards, and the hands shown at showdown. Each entry has its deck position.
- **Mucked cards and the undealt deck** appear only inside `L`, as salted hashes, so they stay hidden.
- **The client** (`proof.ts verify`, with `crypto.subtle.digest`) checks:
  1. every `rv` entry hashes to its leaf;
  2. the leaves hash to `root`;
  3. `root` equals the `cr` it received live;
  4. its own cards, the board and the shown cards match what it saw.
- **Results.** The history drawer shows "Deck verified" or "Mismatch". `crypto.subtle` needs a secure context: https, the desktop `file://` page or the Capacitor localhost. On plain http it says verification needs https.
- **Honest limits** (also shown in the drawer). The proof shows that the deck did not change during the hand. It cannot stop whoever runs the server from choosing the deck.
- **Firefly Trio** needs no commitment, because the multiplier is public before any play.
- **Offline** there is nothing to prove. The history keeps the seed instead.

---

## 9. Lifecycle

### 9.1 Opt-in and entry

- **The LobbyChip** in the voice header shows passive chips: "Lamplight · Cobble 25/50 · 3/6 · Sit · Watch", "Lamplight Cup · 2k · 4/6 · Join", "Firefly Trio · 1k · 2/3 · Join". The channel-list badge uses the same `arcade:activity` summary.
  - No toast, no sound, no change of view.
  - "Hide Arcade", or its Lamplight toggle, hides all of it.
- **Who can do what**
  - **Sitting down and registering:** voice members of that channel. Membership is checked at that moment only. Leaving voice later does not unseat you, so `onVoiceLeft` does nothing for Lamplight.
  - **Watching:** voice members and anyone with `view` on the channel, up to 8 per table.
- **One seat per account.** Online, an account may hold one Lamplight seat or registration at a time. Each socket watches at most one table.
  - Another device on the same account sees the same seat, cards included, and may act. `q` and the `dup` rule make double actions harmless.
  - Starting another Arcade game while seated asks "Leave the table after this hand?"
- **Host.** The host may change the bots between hands at a cash table, and the config before the start in Cup and Trio. If the host leaves, the role passes to the longest-seated human.
- **Late join.** At a cash table you are dealt in from the next hand, with "post BB now" or "wait for BB". Cup and Trio cannot be joined late.
- **Invites** use `arcade:invite`, as in platform §9.2.

### 9.2 Limits (platform §9.3)

| Limit | Value |
|---|---|
| Tables per voice channel | 2 |
| Tables server-wide | 10 |
| Server poker bots | 6 server-wide |
| Spectators | 8 per table |
| Unstarted Cup or Trio lobby | closes after 10 min and refunds the buy-ins |
| A registrant who disconnects before the start | seat held 30 s, then released and refunded |

### 9.3 Restarts, crashes, admin

- **`onRestarting()`:**
  - the hand in progress is voided, and clients get `lamplight:end {void: 'restart'}`;
  - every cash escrow row, which still holds the stack from the start of the hand, is refunded to the wallet (`restart-refund`), and bot rows to the house;
  - unfinished Cup and Trio buy-ins are refunded, with the multiplier forfeited;
  - the client shows "Server restarting. This hand is void, and your chips are back in your wallet."
- **Boot.** Leftover escrow rows are refunded the same way, which covers crashes without notice.
- **Continue offline.** Hidden cards cannot be handed over, so poker sends no HANDOVER. The stage offers "Play offline vs bots (practice)" with the same format, or "Wait and rejoin".
- **Admin.** Turning `arcade.games.lamplight` off, or "void table", does the same as a restart for the tables concerned.

---

## 10. What runs where

| Part | Online | Offline |
|---|---|---|
| Rules engine | server (`tables/*.ts` around `core/lamplight/engine`) | client main thread, event-driven (microseconds per action) |
| Shuffle | server, `crypto.randomInt` | xoshiro128** seeded from `crypto.getRandomValues`, seed kept in history |
| Bots | server, sliced (§13) | Web Worker started on demand and terminated on close; main-thread sliced fallback |
| Clocks | the server table's single timer | `LocalTable` `setTimeout`s, frozen while hidden |
| Render, animation, sound | client | client |
| Wallet, history, boards | server SQLite | practice wallet in `localStorage` (try/catch, in-memory fallback); last 50 hands in memory |
| Deck proof | server stores it, client verifies | none (seed) |

**`TableHost`** is the turn-based counterpart of the platform's `MatchHost`, and the platform must add it (§19):

```ts
export interface TableHost {
  readonly mode: 'local' | 'remote';
  request<T>(ev: string, data: unknown): Promise<T>;        // acked intent; remote = socketClient.request
  on(ev: string, cb: (data: unknown) => void): () => void;  // S→C events for the open table
  setVisible(visible: boolean): void;                       // remote spectator: arcade:away/back; local: pause/resume
  close(): void;
}
```

- **Remote.** `remoteHost` implements it over the main socket.
- **Local.** `localHost` implements it over `LocalTable`. `LocalTable` runs the same engine, emits the same event shapes asynchronously through `queueMicrotask`, and gives bots `viewFor(botSeat)` like the server does.
- **The game module** therefore has one code path. Offline it is simply authoritative, with no proof and no sync.

---

## 11. Offline mode

- **Where it starts.** "Play offline" on the login screen and on the ConnectionBanner, or "Arcade" in the user menu (solo, even while online; results do not count). It mounts with defaults and needs no socket, no `/api/config` and no account.
- **Formats.** All three, against bots, in practice chips:
  - Cup levels advance every 10 hands and Trio levels every 5;
  - the Trio multiplier uses the default table;
  - a fast mode sets bot think time to 150 ms and makes runouts instant.
- **Practice wallet** (`datasetto.arcade.practice.v1`, shared with Glimmerhall):
  - It never syncs, in either direction.
  - A free refill to 10,000 is offered when the balance is below 400, the smallest cash minimum buy-in.
  - **Table stacks.** `practiceWallet.escrow(ref, amount)` records the hand-start stack after every hand. If the app is closed mid-table, the next open returns it to the balance. This is the offline twin of the online escrow refund.
- **Bot Worker** (`lamplight/local/bots.worker.ts`, ≤ 10 KB gzip):
  - It is created with `new Worker(new URL('./bots.worker.ts', import.meta.url), {type: 'module'})`, the same pattern as `services/voice/neuralSuppression.ts:109`.
  - It starts on the first bot decision, idles when the table is hidden, and is terminated on close or after 60 s hidden.
  - If the constructor throws, or the Worker does not answer within 1 s (for example a desktop `file://` edge case), bots run on the main thread instead: in slices of ≤ 200 trials yielded through `setTimeout(0)`, at the server's caps (§13).
- **Hidden.** Everything pauses. Remaining clock time is stored, no bot acts, and no timer runs except the Worker's idle event loop. On return the table resumes exactly where it was.
- **History** keeps the last 50 hands in memory, with seeds. Offline stats go to `localStorage` and are never uploaded.
- **Platforms.** It works in the desktop and Android shells with no network, and on the web only when the page and the Lamplight chunk were already loaded (platform §12).

---

## 12. Wallet and persistence

All chip movement goes through the platform's `wallet.transfer(kind, ref, actor, idem, legs[])`, in one `db.transaction` each.

| Flow | `kind` | `ref` | Legs |
|---|---|---|---|
| Sit down (cash) | `buyin` | `lamplight:<T>` | `w:A −x`, `e:lamplight:<T>:A +x` |
| Top-up between hands | `buyin` | same | same |
| Hand end (cash) | `hand` (**new kind**) | same | each seat's net: `e:…:A ±`, `e:…:bot:<n> ±`. Sums to 0 (no rake). |
| Leave (cash) | `cashout` | same | `e:…:A −stack`, `w:A +stack` |
| Bot sits or rebuys (online cash) | `buyin` | same | `house −x`, `e:lamplight:<T>:bot:<n> +x` |
| Bot leaves, or table closes | `cashout` | same | `e:…:bot:<n> −`, `house +` |
| Register (Cup or Trio) | `buyin` | `cup:<C>` / `trio:<R>` | `w:A −b`, `e:cup:<C>:A +b` |
| Unregister before the start | `refund` | same | reverse |
| Cup payout | `prize` | `cup:<C>` | every `e:cup:<C>:*` leg to 0; `w:` + shares (humans only) |
| Trio payout | `prize` | `trio:<R>` | `e:trio:<R>:* −3b`; `w:` + pool × shares; `house ±(3b − pool)` |
| Restart, crash or admin void | `restart-refund` | as above | every `e:` row to its owner's `w:`; bot rows to `house` |

- **One write per hand.** At the end of a hand, one transaction does all of this:
  1. the `hand` txn, with its escrow legs;
  2. the `arcade_poker_hands` insert: `table_ref`, `hand_no`, `format`, `seats` (human account ids dealt in), `commit_root`, `hand_secret`, `deck`, and `record`, about 1 KB of JSON holding actions, board, pots, winners, net per seat and shown cards (other hole cards are derivable only from the stored deck and are never served);
  3. the stats upserts below.

  Tournament hands move no wallet chips, so they write only the hand row and the stats.
- **Idempotency.** `sit`, `topUp` and `leave` carry a client `id`, stored as `arcade_txns.idem` with `actor = accountId`. System txns use `actor = 'system'`, not NULL, because SQLite treats NULLs as distinct in `UNIQUE (actor, idem)` (§19).
- **Stats** (`arcade_stats`, `game = 'lamplight'`). Updated in the hand transaction for each human, only when at least 2 humans were dealt in:
  - `net:<ISO week>` and `net:all` add the hand's net;
  - `hands` adds 1;
  - `pot_best` keeps the maximum;
  - `cup_wins` and `trio_best` are updated at payout.

  Week rows older than 8 weeks are deleted by the daily job.
- **Results.** Each Cup and Trio writes `arcade_results` (mode, humans, a summary `{buyIn, mult, pool, hands}`) and `arcade_result_players` (place, chips_delta). Cash tables write stats only.
- **Leaderboards** (`arcade:board {game: 'lamplight', board}`, 60 s cache): `net-week`, `net-all`, `cup-wins`, `trio-best` and `pot-best`, by account id, with names resolved on read.
- **Retention.** Hand rows are kept for 30 days, and at most 2,000 per table (the platform daily job). Ledger rows fold into months after 90 days.
- **Wallet rules** (platform §11.2):
  - new accounts get 20,000;
  - the daily claim is `max(2000, 10000 − (balance + escrow))`;
  - no balance goes negative;
  - no transfers between players.

---

## 13. Bots (`core/lamplight/bots.ts`)

Bots never decide outcomes. The thinker is a stepper, so core never needs a clock:

```ts
const th = createThinker(viewFor(state, botSeat), level, rng);  // rng: core xorshift32, seeded by the host
while (!th.step(200) && withinBudget()) yieldToEventLoop();     // host-side loop, not core
const action = th.decide();
```

**Where the thinking runs**

| | Server (online) | Worker (offline) | Main-thread fallback (offline) |
|---|---|---|---|
| Slice | ≤ 200 trials, then `setImmediate` | unsliced | ≤ 200 trials, then `setTimeout(0)` |
| Greenhorn | 300 trials, ≤ 1 ms of CPU | 300, ≤ 5 ms | as on the server |
| Regular | 1,000 trials, ≤ 2 ms | 1,500, ≤ 15 ms | as on the server |
| Sharp | 1,500 trials, ≤ 2 ms | 4,000, ≤ 30 ms | as on the server |
| Early stop | standard error < 0.01 after 300 trials | same | same |

- **Why fewer trials online.** At 1,500 trials the equity standard error is about 0.013, below the ±2 % noise Sharp adds anyway, so online Sharp plays nearly as well.
- **Timing.** The time budget is measured by the host (`process.hrtime` or `performance.now`). Thinking runs inside the cosmetic think time, and the bot acts at whichever is later: the think time or the end of thinking.
- **Cheap path.** With no human connected, the cheap path applies: the preflop chart, and at most 100 trials postflop.

**Equity.** Each trial deals opponents hands from their ranges (rejection sampling, 20 tries, then uniform), completes the board, and scores 1 for a win and 1/k for a k-way tie. Every loop is a `for` over a fixed cap.

| Level | Opponent range |
|---|---|
| Greenhorn | none (random) |
| Regular | raised: top 20 %; called: top 50 %; limped: top 70 % |
| Sharp | by action and position, narrowed each street |

**Preflop**
- **Hand ranks.** A 169-class strength table (equity against a random hand) is generated once by `server/scripts/gen-lamplight-ranks.mjs` and committed as `ranks169.ts`, about 1 KB. The script is manual, ≤ 60 s on 4 worker threads, and never part of CI.
- **Open-raise** when the hand's percentile is within the range for the position:

  | Level | EP | MP | CO | BTN | SB |
  |---|---|---|---|---|---|
  | Regular | 15 % | 20 % | 27 % | 38 % | 30 % |
  | Sharp | 14 % | 19 % | 27 % | 42 % | 36 % |

- **3-bet:** top 5 % for Regular. Sharp uses its top 7 %, plus suited aces as a 3 % bluff.
- **Calling a raise:** up to twice the 3-bet range, or the top 35 % when defending the BB.
- **Greenhorn** limps or calls with the top 60 % and raises only the top 8 %.
- **Push/fold** (stack ≤ 15 BB, Regular and Sharp) shoves this top share of hands. The ranges double when only the BB is left to act.

  | Stack | Shove range |
  |---|---|
  | ≤ 4 BB | 60 % |
  | 5–7 BB | 40 % |
  | 8–10 BB | 28 % |
  | 11–15 BB | 18 % |

**Postflop.** `E` = equity, `n` = number of opponents, `Q = E·(n+1)`, `odds = toCall / (pot + toCall)`.
- **Unopened pot.** Bet if `Q ≥ 1.25` (Sharp 1.2). Otherwise bluff at the `bluff` rate on a dry board with `n ≤ 2` (half that rate on wet boards). Otherwise check. A dry board has no pair, no three of a suit, and no three cards within a 4-rank span. Sharp c-bets 65 % of the time heads-up as the preflop raiser.
- **Facing a bet.** Raise if `Q ≥ 1.5`, call if `E ≥ odds + margin`, otherwise fold. Sharp also raises flop draws (`E ≥ 0.33`) 25 % of the time.

  | Level | Noise on E | margin | bluff |
  |---|---|---|---|
  | Greenhorn | ±10 % | −0.10 | 2 % |
  | Regular | ±5 % | +0.03 | 8 % |
  | Sharp | ±2 % | 0, or −0.03 with a flop or turn draw | 14 % |

**Sizing**
- Open 2.5 BB plus 1 BB per limper.
- 3-bet 3× in position, 3.5× out of position.
- Postflop: ⅓ pot on dry boards, ⅔ pot on wet ones, ¾ pot for river value.
- Shove when the stack is ≤ 1.2× the planned bet, or < 1.2× the pot.
- Round to the SB and clamp to the legal range.

**Think time:** 700 to 2,200 ms, skewed short; 400 to 1,000 ms in Firefly Trio; 150 ms in offline fast mode. The platform's "0.6–1.5 s" line in §8.1 should defer to these values (§19).

---

## 14. Client: UI integration, rendering, input

### 14.1 Module layout (`client/src/arcade/lamplight/`)

```
index.ts         mount(el, host: TableHost, opts) → GameHandle {pause, resume, unmount}
table.ts         view model: applyEvent, lastQ, pre-actions, 50-hand history
render/          layout.ts felt.ts cards.ts chips.ts seats.ts ring.ts atlas.ts
bar.tsx          action bar and raise sheet: its own Preact root, module-local signals
input.ts         keyboard and gamepad map
audio.ts         synth voices
proofView.ts     deck-proof check and drawer text
local/           localTable.ts bots.worker.ts thinkerMain.ts
```

### 14.2 Preact and signals

- **Platform signals.** `features/arcade/state.ts` signals (`arcadeSession`, `arcadeLobby`, `arcadeWallet`, `arcadeActivity`) are written only on seat, phase, wallet and turn changes.
- **The action bar** is a separate `render()` root inside the stage, owned by the module. Preact is already in the main bundle, so it adds no bytes. Its local signals are:
  - `myTurn`: `null` or `{toCall, minTo, maxTo, pot, canRaise}`, written at turn start and end;
  - `seatState`: written when your own seat changes.

  Neither is ever read by VoicePage.
- **Everything else** (table, cards, chips, stacks, bubbles, clocks) is drawn on the canvas.
- **Screen readers.** A live region gets `textContent` per event ("Vesna raises to 600").

### 14.3 Rendering

- **No idle loop.** An event or a resize marks the table dirty. Tweens (at most 12) run on `lib/frames` with `{maxFps: 60}` and unsubscribe when the last one ends, so a still table has `frames.active === 0`.
- **Turn ring.** It has its own 72 × 72 overlay canvas, redrawn at 10 Hz by one `setTimeout` chain, only while a clock runs and the table is visible.
- **Layers.**
  - a cached felt, rim and empty-seat layer, rebuilt on resize;
  - a dynamic layer for cards, chips and labels;
  - the ring overlay.

  `runtime/canvas.ts` sizes the canvas with a ResizeObserver, DPR capped at 2.
- **Hidden.** Events are applied to the view model only, tweens are skipped, the ring timer is cleared, and the AudioContext is suspended. Becoming visible again triggers one full redraw.
- **Unmount** frees everything: frame subscriptions, the ring timer, listeners, the Worker, the AudioContext, and the canvases set to 0 × 0.
- **Animations:**

  | What | Duration |
  |---|---|
  | Deal | 180 ms, with a 60 ms stagger |
  | Flip | 150 ms |
  | Chips | 250 ms to the pot, 400 ms to the winner |
  | Winner glow | 1.2 s, then still |
  | Firefly reveal | 3 s; the values cycle and slow onto the server's draw |

  `prefers-reduced-motion` makes all of them instant.

### 14.4 Layouts

- **Stage.** Opening a table replaces the video grid on your own screen only. The voice tiles collapse to a strip, and "Back to call" minimizes (platform §10.6). A minimized table shows a chip: "Lamplight · Return", or "Lamplight · Your turn" while `arcadeSession.attention` is true. The chip shows no countdown, so no per-second signal writes.
- **Phone portrait** (360 × 640 CSS px and up; poker is portrait-first):
  - A tall oval, with you at the bottom centre. Your cards are 64 × 90 px, board cards 44 × 62 px. Up to 8 other seats: a 40 px avatar, the name (8 characters), the stack ("1.2k") and a 1.5 s action bubble.
  - The action bar takes the bottom 64 px: Fold | Check/Call X | Raise, with targets ≥ 48 px.
  - The raise sheet has a slider, presets (Min, ½, ¾, Pot, All-in), ±1 BB steppers and a numeric field (`inputmode="numeric"`). All-in needs a second tap within 2 s.
  - Off-turn pre-actions: Check/Fold, Check, Call X (cleared if the amount changes), Call any. They fire the moment `myTurn` arrives.
- **Phone landscape:** a wide oval, with the action bar as a 96 px column on the right.
- **Phone extras:**
  - Android back closes the raise sheet first, then minimizes (`useBackClose`).
  - Wake Lock is held while you are seated, a hand is running and the stage is visible, and released when you sit out or hide the table.
- **Desktop:** a 16:9 canvas fitted to the stage, the action bar bottom right, the history drawer on the left.

### 14.5 Input

- **Keyboard** (only while the stage has focus, with the existing `isTyping` guard, so the raise field is safe):

  | Key | Action |
  |---|---|
  | F | fold |
  | C or Space | check or call |
  | R | raise sheet |
  | ↑ / ↓ | ±1 BB |
  | Shift+↑ / ↓ | ±¼ pot |
  | Enter | confirm |
  | A, twice | all-in |
  | H | history |
  | Esc | close the sheet |

  The configured push-to-talk key and the app shortcuts are never bound (platform §10.4). If the push-to-talk key is one of these, that binding is dropped and the hint shows the alternative.
- **Gamepad** (standard mapping, 0.3 dead zone; only on your turn, polled by the 10 Hz ring timer, and only after a `gamepadconnected` event):

  | Button | Action |
  |---|---|
  | A | check or call |
  | B | fold |
  | X | raise sheet |
  | LB / RB | adjust the amount |
  | Y, held 1 s | all-in |

### 14.6 Attention and audio

- **Your turn while hidden or minimized:**
  1. `arcadeSession.attention = true`; it is set back to false when the turn ends;
  2. one chime: the module resumes its AudioContext, plays the 250 ms chime and suspends it again;
  3. the platform's attention hook (§19): a "●" prefix on the web tab title, `flashFrame` on desktop Windows and Linux until focus, a dock bounce on macOS. Android has none, apart from the opt-in 10 ms vibration.
- **No push notification for turns.** Push delivery can take longer than the whole 15 s clock.
- **When the platform hides the page.** A backgrounded Android WebView or iOS page may stop running scripts. The seat then follows the disconnect rules, and that is accepted.
- **Volume.** Audio sits under the game-volume setting at −12 dB, below voice (platform §10.5).

---

## 15. Art and sound

All art and sound are original and generated from code. Nothing is downloaded.

**Art**
- 1 art pixel is 2 to 3 CSS px, with `imageSmoothingEnabled = false`.
- Palette: felt `#1f4d4a`, brass `#b08d57`, amber `#f2b84b`, card cream `#f4ead5`, ink `#1b1b24`.
- **Cards:**
  - 22 × 31 art px, built from 5 × 7 rank and 7 × 7 suit bitmaps stored as string arrays;
  - a four-colour deck by default (♠ ink, ♥ red, ♦ blue, ♣ green), two-colour optional;
  - all 52 faces in one `ImageBitmap` atlas, about 142 KB of memory, built at mount.
- **Card back:** a mirrored lantern motif. **Felt:** a 64 × 64 seeded value-noise tile. **Chips:** striped pixel ellipses coloured by value, at most 5 high, with the number beside them.
- **Avatars ("lantern spirits"):** symmetric 8 × 8 sprites coloured from a hash of the account or bot id. There is a brass dealer token. Text uses the platform's 5 × 7 bitmap font.

**Sound** (Web Audio synthesis, one context created after the first gesture)

| Sound | Synthesis |
|---|---|
| Deal | 30 ms of band-passed noise |
| Chip | 2.2 and 3.1 kHz sines with a 60 ms decay, plus a noise tick |
| Check | a 180 Hz knock |
| Fold | a 120 ms falling sweep |
| Your turn | an E5→B5 chime |
| Last 5 s of your clock | a 1 Hz tick |
| Win | a 4-note arpeggio |
| Firefly reveal | rising ticks, then a chord with more voices for bigger multipliers |

---

## 16. Performance budgets

- **Mid-range phone** (2021 Android, Chrome):
  - a full redraw takes ≤ 2 ms and an overlay redraw ≤ 0.3 ms;
  - a still table draws nothing except the 10 Hz ring while a clock runs, and keeps the main thread under 1 % busy;
  - Monte Carlo never runs on the main thread, except in the Worker-failure fallback, in slices of ≤ 200 trials.
- **Memory:** ≤ 8 MB of heap, plus about 4 MB of canvas at DPR 2.
- **Bundle (gzip):** no Lamplight code in the main bundle; the platform shell's ≤ 4 KB covers the chips and sheet.

  | Chunk | Budget |
  |---|---|
  | `lamplight` (engine 10, evaluator 2, renderer and art 18, audio 3, action bar 7, views, proof and trio 3), loaded when a table opens | ≤ 43 KB target, ≤ 50 KB enforced |
  | `lamplight-bots` Worker | ≤ 10 KB |

- **Server:** < 0.2 ms of CPU per action excluding bots, ≤ 2 ms per bot decision, about 22 KB per table, one database transaction per hand. Each intent handler is timed: over 20 ms logs a warn with the hand's deck and actions (enough to replay it), and over 20 ms twice voids the table like a restart.

---

## 17. Hand history

- **Records.** Each record (about 1 KB of JSON) holds:
  - hand number, format and level;
  - button and seats (id and starting stack);
  - actions as `[street, seat, kind, amount]`;
  - board, pots, winners and net per seat;
  - the cards a viewer may see: their own and the shown ones;
  - online, the commitment root; offline, the seed.
- **The client** keeps the last 50 hands it saw, with salts, so the proof can check them. They are listed as text ("Hand 214 · Cobble 25/50 · Pip raises to 150") with a step-through replay through `applyEvent`.
- **After a reload,** `lamplight:hands` pages summaries of the account's hands from the last 30 days, 20 per page, and `lamplight:record` fetches one hand on tap. Records are served only to accounts in that hand's `seats`, and filtered for them.
- **The drawer** shows "Verify deck" (§8.2) and the honest-limits note.

---

## 18. Tests and verification

**Time caps.** Poker adds at most 10 s to automated runs and 3 minutes of manual checks. No run takes over 60 s, and every launched browser uses `--mute-audio`, `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`.

| Check | Where | Wall time |
|---|---|---|
| Core unit suite | `server` `npm test` | ≤ 5 s |
| Server integration (Lamplight part) | `server` `npm test` | ≤ 4 s, injected clocks, think time 0 |
| Link-simulator scenario | `server` `npm test` (platform §15.2) | ≤ 1 s |
| Client runtime and UI | `client` `npm test` (jsdom) | ≤ 2 s |
| Soak (manual) | `npm run test:soak -w server -- lamplight` | ≤ 60 s, stops early |
| Layout screenshots (manual) | one headless Chrome, 3 layouts | ≤ 30 s |
| CPU traces (manual) | the bench Chrome through CDP, 4× throttle | 3 states × 15 s |

### 18.1 Core unit suite

- **Evaluator:**
  - the §4 vectors;
  - all 2,598,960 five-card hands with exact category counts: 40, 624, 3,744, 5,108, 10,200, 54,912, 123,552, 1,098,240, 1,302,540 (about 1 s);
  - 100k seeded 7-card hands against a brute-force best-of-21.
- **Equity:** the 7/44 oracle, by exact enumeration.
- **Betting scenarios** (scripted, asserting the legal actions and amounts):
  - BB option after limps;
  - min-raise after a raise;
  - a short all-in that does not reopen, and two that together do;
  - heads-up order, and 3-handed down to heads-up;
  - uncalled refund;
  - side pots with 3 and 4 all-ins plus folded chips;
  - odd chip in a 3-way split;
  - the board plays;
  - ante;
  - `turnQ` staleness: a seat event in between does not stale an action.
- **Properties** (2,000 seeded hands of random legal actions):
  - chips are conserved after every event;
  - no stack goes negative;
  - the seat to act always has a legal action;
  - every hand ends;
  - the pots sum to the contributions;
  - `buildPots` passes ≤ seat count.
- **Determinism:** the same seed gives the same event-log hash over 500 hands, and a mid-hand snapshot plus replayed events rebuilds the same state.
- **Economy:**
  - the exhaustive mapping of all 1,000,000 draw values reproduces the Trio table, so EV = 2.9725 exactly (< 50 ms);
  - the validator rejects EV ≥ 3 and bad weight sums;
  - payouts sum to the pool for every format and player count, including human-only Cup places and the abandoned split.
- **Proof:** building and verifying a proof passes; changing one card, one salt or one leaf fails; the proof's `rv` never contains a mucked or undealt card.
- **Purity:** covered by the platform's grep test over `core/` (no `Math.random`, `Date`, `crypto`, `enum`, `while` or `do` in `bots.ts`).
- **Ranks table:** the committed `ranks169.ts` matches its recorded hash and orders AA first and 72o last.

### 18.2 Server integration (`startTestServer`; accounts through `ctx.accounts.register` and `ctx.sessions.create`)

- **Hidden-card scan.** 200 bot hands with three sockets: two seated humans and one spectator. Every emit to every socket is scanned structurally. No other seat's hole cards may appear before showdown, and no mucked cards ever. A proof request reveals only the board, the caller's own cards and the shown cards. A non-seated account gets `forbidden`.
- **Wallet and escrow:**
  - concurrent buy-ins never go negative;
  - leftover escrow is refunded on boot;
  - `onRestarting()` voids the hand and refunds to hand-start stacks;
  - the conservation invariant (platform §11.2) holds after every flow in §12, including bot buy-ins and `hand` txns.
- **Reconnect.** Kill the main socket mid-hand: the seat stays and the clock runs without the time bank. `sync` inside the ring returns the events plus your `hole`. `sync` outside the ring returns a snap with your cards and salts.
- **Pacing.** A forced `writeBuffer` backlog delays Lamplight events but not chat. Overflow (more than 32 events or over 2 s) produces one snap. `ms` is stamped at emit, and a 1 s queue wait extends the deadline by 1 s.
- **Rules.**
  - A duplicate `act` returns `dup`.
  - A stale `q` returns `stale`.
  - An online Trio with bots is refused.
  - A Cup with bots pays humans only and ends when the human places are settled.
  - An online cash table refuses bots at Boulder and Summit.
  - The 6-bot server cap holds.
- **Idle.** An empty table closes after 2 minutes, and a cash table whose humans all sit out closes after 5. No table timer is armed between hands when nobody can play.

### 18.3 Link simulator scenario (virtual time)

**"Lamplight, 4 players, 3G":** 750 / 250 kbit/s, 300 ms ± 50 ms, with the 147 kbit/s voice flow and the platform's chat prober. It plays 20 fast-forwarded 4-handed hands plus one 6-max reference hand, then repeats with 1 % head-of-line loss.

Pass:
- per-hand wire bytes ≤ 3 KB (4-handed) and ≤ 4 KB (6-max reference);
- ≤ 3 KB in any 1-s window;
- chat one-way p95 < 300 ms, or < 450 ms with loss;
- `q` consecutive at every client;
- no turn deadline missed by a client that answered within 1 s of receiving its turn.

This replaces the first spec's 2-minute network check. The real shaped smoke (platform §15.5) gets no poker scenario, because poker's traffic is too small to change its outcome.

### 18.4 Client (jsdom)

- **Action bar:** the bounds (min, max, all-in, BB steps) and the pre-action reset when the amount changes.
- **Keyboard:** push-to-talk key exclusion, the `isTyping` guard, A twice for all-in.
- **Zero cost when closed.** After mount and unmount with a fake `TableHost`:
  - `frames.active === 0`;
  - no live timers;
  - the Worker is terminated;
  - the AudioContext is closed;
  - no listeners are left.
- **Hidden:** events are applied but nothing is drawn (canvas calls spied), and the ring timer is cleared. Coming back draws once.
- **Signals:** 50 table events write `myTurn` at most twice per turn and no platform signal except `arcadeSession.attention`. VoicePage renders 0 times.
- **Practice wallet** with a throwing `localStorage`: it falls back to memory, and the escrow is restored on the next mount.
- **Proof:** verify with a `crypto.subtle` stub, and the error message when `crypto.subtle` is absent.

### 18.5 Manual checks

- **Soak:** 5,000 bot-only 6-max hands with no think time and a quarter of the trials, on 4 worker threads, with a hard stop at 60 s. It passes if nothing throws, chips are conserved, and Sharp beats 5 Greenhorns at 95 % confidence. It stops as soon as that bound is crossed, typically within about 1,500 hands.
- **Screenshots:** portrait 360 × 640, landscape 640 × 360 and desktop 1280 × 720, from one Chrome launch with `--mute-audio`.
- **CPU** (15 s each, 4× throttle):

  | State | Pass |
  |---|---|
  | Table open, not your turn, tweens done | 0 rAF callbacks; at most the 10 Hz ring timer; main thread < 1 % |
  | Seated and minimized or hidden | 0 rAF; 0 ring timer; event handling only |
  | After closing | equal to the Arcade-closed baseline (platform §15.6) |

---

## 19. What the platform must add or change for Lamplight

1. **`TableHost`** in `client/src/arcade/runtime/types.ts` (§10), implemented by `remoteHost` over the main socket and by `localHost` over a local table. `GameModule.mount` accepts either a `MatchHost` or a `TableHost`.
2. **`emitPaced(socket, ev, data)`** with a room fan-out helper in `arcade/handlers.ts`. It needs:
   - per-game overflow hooks: Lamplight replaces its queue with a snap built at send time;
   - **send-time field stamping**: a callback that computes `ms` from an absolute deadline when the event leaves the queue;
   - a **queue-wait report** back to the table, for the turn credit;
   - **egress accounting** into "Arcade egress".
3. **`arcade:away {id}` / `arcade:back {id, since}`** for table-lane spectators, with the slot held for 60 s. `glimmer:away` can become an alias of the same pair.
4. **`ActivitySummary.x`**: an optional label of ≤ 24 characters ("Cobble 25/50", "Cup 2k", "Trio 1k") in `arcade:activity`.
5. **`arcadeSession.attention: boolean`**, plus an attention hook in the shell:
   - web: a tab-title prefix;
   - desktop: a new `desktopAPI.requestAttention()` in `desktop/preload.js`, which calls `mainWindow.flashFrame(true)` until focus (`desktop/main.js` already uses `flashFrame` for the single-instance warning) and `app.dock.bounce('informational')` on macOS.
6. **Wake Lock rule:** hold it also while seated at a Lamplight table, in a hand and visible.
7. **Ledger kinds:** add `hand` (escrow-to-escrow settlement per hand). Bot escrow accounts `e:<ref>:bot:<n>` are refunded to `house` on boot.
8. **System txns** use `actor = 'system'`, not NULL. `UNIQUE (actor, idem)` does not deduplicate NULL actors in SQLite.
9. **§11.3 boards:** replace the "Lamplight weekly net" ledger query with the `arcade_stats` counters (§12). The ledger query would count slots spins and Glimmer Dash too, and it cannot apply the 2-human rule per hand.
10. **§5.4 event list:**
    - drop `lamplight:register` (registration is `arcade:lobby:join`);
    - add `lamplight:sync`, `lamplight:hands`, `lamplight:record` and the `bank.b` flag;
    - `lamplight:proof` takes `{t, h}`.
11. **§8.1 and §13.4 wording:**
    - "Monte Carlo capped at 200 samples" means 200 trials per slice;
    - the per-decision server budget is 2 ms of CPU with level caps of 300 / 1,000 / 1,500;
    - bot think times follow §13, not "0.6–1.5 s".
12. **Online bot economy rules** (§2) in the hub and the admin text:
    - cash bots at Pebble and Cobble only, with a rebuy cap;
    - Cup pools and places are human-only;
    - the Trio is humans only.
13. **Public config:** `arcade.proto.lamplight` in `GET /api/config` and `auth:success`, for version skew on the table lane.
14. **Bundle check:** `check-bundle.mjs` also budgets the `lamplight-bots` Worker chunk (≤ 10 KB).
15. **Practice wallet:** `practiceWallet.escrow(ref, amount)` and its restore on mount.
16. **Desktop smoke:** add one line to confirm that the module Worker starts from the packaged `file://` client (the pattern in `neuralSuppression.ts`). The fallback covers it if it does not.

---

## 20. Milestones (platform phase 2)

1. **Engine core:** cards, `eval7`, betting, pots, rotation, views and the default suite.
2. **Offline Open Table against Greenhorn bots:** the canvas renderer, the portrait layout, `LocalTable`, and the practice wallet with escrow.
3. **Bot Worker:** Regular and Sharp, the 169-class table, push/fold, the main-thread fallback and the soak.
4. **Online Open Tables:**
   - server authority and the views;
   - the paced emitter, sync and the ring;
   - wallet, escrow and the `hand` txn;
   - reconnect and idle close;
   - the lobby chip and activity summary;
   - the deck commitment.
5. **Lamplight Cup,** offline and online: schedules, human-only payouts, abandoned splits.
6. **Firefly Trio:** the draw and reveal, high-multiplier payouts, the admin table validator.
7. **History, proof drawer and leaderboards.**
8. **Polish:**
   - landscape and desktop layouts;
   - keyboard and gamepad;
   - sounds and the attention hook;
   - deck colours;
   - reduced motion;
   - 6 pixel emotes, at most 1 every 3 s.

## 21. Out of scope

Straddles, running it twice, rabbit hunting, multi-table tournaments, rake, spectator delay (spectators never see hidden cards), push notifications for turns, and anything to do with real money or purchases.
