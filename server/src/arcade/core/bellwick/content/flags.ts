/**
 * World flags (bellwick.md §3.4). A flag's id is its position in this list: APPEND ONLY. Saves store the
 * flags as 32 bytes, so renumbering one would corrupt old saves; the content test compares this list with
 * the committed flags.lock.json and fails when an existing id changed. At most 256 flags.
 */
export const FLAG_NAMES: readonly string[] = [
  'chest_sword',
  'gift_hesper',
  'chest_windmill',
  'chest_cave',
  'cave_shutter',
  'shard_cave',
  'shard_millpond',
  'shard_orchard',
  'gift_fennick',
  'shard_shrine',
  'chest_lookout',
  'stash_oaks',
  'shop_shard',
  'lantern_village',
  'lantern_mossy',
  'lantern_entry',
  'lantern_ante',
  'key_a',
  'chest_map',
  'key_c',
  'lock_l1',
  'lock_l2',
  'gallery_open',
  'chest_compass',
  'chest_hook',
  'key_b',
  'shard_crypt',
  'shard_ossuary',
  'lock_l3',
  'clock_bridge',
  'chest_bosskey',
  'boss_door',
  'boss_down',
];

/** Name → id. */
export const flagId = (name: string): number => FLAG_NAMES.indexOf(name);

export const FLAG = {
  bossDown: 32,
} as const;
