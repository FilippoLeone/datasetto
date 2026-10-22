/**
 * Shared helpers for Bellwick's tests: a bot run through the lock-step loop (runtime + client mirror),
 * wired the way the device wires the real game (interactions on chests, locks, lanterns and people are
 * sent; the shop, brews and resting go through the bot's actions).
 */
import { ByteWriter } from '../../../src/arcade/core/bytes.js';
import { createHeroBot, type HeroBot } from '../../../src/arcade/core/bellwick/bots/hero.js';
import { sendInteract, type ClientWorld } from '../../../src/arcade/core/bellwick/client.js';
import { toBase64, writeBuy, writeRespawn, writeUseBrew, type SaveV1 } from '../../../src/arcade/core/bellwick/codec.js';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { T } from '../../../src/arcade/core/bellwick/content/legend.js';
import walkthrough from '../../../src/arcade/core/bellwick/content/walkthrough.js';
import { createLocalRun, type LocalRun } from '../../../src/arcade/core/bellwick/replay.js';

const INTERACT: ReadonlySet<number> = new Set([T.CHEST, T.LOCK, T.BOSSDOOR, T.LANTERN, T.LANTERN_LIT, T.NPC]);

export interface BotRun {
  run: LocalRun;
  bot: HeroBot;
  /** Steps until the bot is done or `maxTicks` passed; returns the ticks used. */
  play(maxTicks: number): number;
}

export const botRun = (seed: number, o: { save?: SaveV1 | null; script?: readonly string[] } = {}): BotRun => {
  let run: LocalRun | null = null;
  const flags = o.save ? fromSaveFlags(o.save) : null;
  run = createLocalRun({
    seed,
    heroes: 1,
    save: o.save && flags ? { data: o.save, flags } : null,
    hooks: () => ({
      interact: (tile: number) => {
        const c = run!.clients[0] as ClientWorld;
        if (INTERACT.has(c.tiles[tile] as number)) sendInteract({ up: () => undefined, evt: (p) => run!.core.onEvent(0, p) }, tile);
      },
    }),
  });
  const bot = createHeroBot(o.script ?? walkthrough);
  const w = new ByteWriter(8);
  const r = run;
  const act = {
    buy: (i: number) => r.core.onEvent(0, writeBuy(w.reset(), i).copy()),
    brew: () => r.core.onEvent(0, writeUseBrew(w.reset()).copy()),
    respawn: () => r.core.onEvent(0, writeRespawn(w.reset()).copy()),
  };
  return {
    run: r,
    bot,
    play(maxTicks) {
      const c = r.clients[0] as ClientWorld;
      let t = 0;
      for (; t < maxTicks && !bot.done; t += 1) r.step([bot.tick(c, act)]);
      return t;
    },
  };
};

const fromSaveFlags = (s: SaveV1): Uint8Array => {
  const out = new Uint8Array(32);
  const raw = Buffer.from(s.flags, 'base64');
  out.set(raw.subarray(0, 32));
  return out;
};

/** A save standing at the Bellhouse's Entry Hall lantern with what the overworld gives before it. */
export const dungeonSave = (seed: number): SaveV1 => {
  const flags = new Uint8Array(32);
  for (const name of ['chest_sword', 'gift_hesper', 'chest_windmill', 'chest_cave', 'cave_shutter', 'shard_cave', 'shard_orchard', 'lantern_village', 'lantern_entry']) {
    const id = flagId(name);
    flags[id >> 3] = (flags[id >> 3] as number) | (1 << (id & 7));
  }
  return {
    v: 1,
    seed,
    flags: toBase64(flags),
    playSec: 0,
    purse: 6,
    keys: 0,
    bossKey: false,
    map: false,
    compass: false,
    sword: true,
    buckler: true,
    hook: false,
    shards: 2,
    vessels: 0,
    lantern: 2,
    heroes: {},
  };
};

/** The walkthrough from the Bellhouse's Entry Hall on. */
export const dungeonScript = (): readonly string[] => walkthrough.slice(walkthrough.indexOf('go entry 2,3'));
