/**
 * Every line of Bellwick's text (bellwick.md §1). Each entry is a list of pages; the dialogue box wraps a
 * page to 29 characters a line, 3 lines at most. Signs and dialogue are local and send nothing online.
 */

export const TEXT: Readonly<Record<string, readonly string[]>> = {
  hesper: [
    'Wren! The bells of Kettlebrook have gone silent, and the Gloam creeps out of Gloamwood.',
    'Old Clapper, the first bell, has swallowed the chime, down in the Drowned Bellhouse.',
    'Take my old Rootsword from the chest, and these 5 glints. Be brave, little lamplighter.',
  ],
  hesper_after: [
    'Pebble Sentinels guard Gloam Gate. Pell sells a Bark Buckler: hold it up and walk on through.',
    'Light a lantern to rest and keep your tale. I will keep the hearth warm.',
  ],
  pell: ['Welcome to Pell\'s Sundries! Pick something off the counter.'],
  buy_buckler: ['Bark Buckler, 30 glints. Hold B to block pebbles, notes and shockwaves.'],
  buy_brew: ['Hearthbrew, 20 glints. Drink it from the pause menu to refill your hearts.'],
  buy_shard: ['A heart shard, 80 glints. Four shards make a whole heart.'],
  sold_out: ['Sold out! That one was the last.'],
  no_glints: ['You need more glints for that.'],
  have_brew: ['You already carry a Hearthbrew.'],
  fennick: ['Few come this way but by hook and vine. Fennick is my name, and this shard is yours.'],
  fennick_after: ['The Gloam thins where the bells ring. Ring them again, little lamplighter.'],
  sign_square: ['Kettlebrook Square. North: the Windmere meadows. Mind the Gloam.'],
  sign_crossroads: ['North: Gloamwood. West: Windmill Hill. South: Kettlebrook.'],
  sign_gate: ['Gloam Gate. The Sentinels let none pass who do not hold up a shield.'],
  sign_shore: ['The Drowned Bellhouse. Its bells have not rung since the Gloam came.'],
  lantern: ['The lantern glows. Your tale is saved.'],
  locked: ['Locked. A small key would open it.'],
  locked_boss: ['A great door with a bell on it. It needs the Boss Key.'],
  got_sword: ['You found the Rootsword! Press A to swing. Hold A, then let go, to spin.'],
  got_buckler: ['You got the Bark Buckler! Hold B to block from the front.'],
  got_hook: ['You found the Vinehook! Tap B to throw it. It pulls you to hook posts.'],
  got_map: ['You found the Map of the Bellhouse!'],
  got_compass: ['You found the Compass! It marks the boss and the chests still closed.'],
  got_key: ['You found a small key!'],
  got_bosskey: ['You found the Boss Key!'],
  got_shard: ['You found a heart shard! Four of them make a heart.'],
  got_vessel: ['The Heart Vessel! Your hearts grow by one.'],
  got_brew: ['You got a Hearthbrew! Drink it from the pause menu.'],
  got_glints: ['You found some glints!'],
  victory: [
    'The chime rings free! Across Kettlebrook the bells sing again, and the Gloam melts away.',
    'Thank you for playing Bellwick: The Silent Bells.',
  ],
  rest: ['You are down. Rest at the lantern?'],
};

/** Screen names for the map and the banner when you arrive somewhere new. */
export const SCREEN_NAME: Readonly<Record<string, string>> = {
  oaks: 'Hollow Oaks',
  logtunnel: 'Log Tunnel',
  shore: 'Bellhouse Shore',
  shrine: 'Old Shrine',
  lookout: 'Cliff Lookout',
  woodsedge: 'Wood\'s Edge',
  mossy: 'Mossy Path',
  gate: 'Gloam Gate',
  ring: 'Stone Ring',
  glade: 'Hermit Glade',
  windmill: 'Windmill Hill',
  crossroads: 'Crossroads',
  meadow: 'North Meadow',
  rocky: 'Rocky Rise',
  bridge: 'Broken Bridge',
  millpond: 'Millpond',
  westlane: 'West Lane',
  square: 'Kettlebrook Square',
  eastlane: 'East Lane',
  orchard: 'Orchard',
  hesper: 'Hesper\'s House',
  shop: 'Pell\'s Sundries',
  cave: 'Rocky Rise Cave',
  entry: 'Entry Hall',
  cistern: 'Cistern',
  stair: 'Belfry Stair',
  nave: 'Great Nave',
  chapel: 'Chapel',
  gallery: 'Switch Gallery',
  vault: 'Hook Vault',
  ropehall: 'Bell Rope Hall',
  ossuary: 'Ossuary',
  clockwork: 'Clockwork Room',
  crypt: 'Flooded Crypt',
  ante: 'Antechamber',
  belfry: 'Clapper\'s Belfry',
};

/** Wraps one page to lines of at most `width` characters (words longer than a line are split). */
export const wrap = (page: string, width: number): string[] => {
  const lines: string[] = [];
  let line = '';
  const words = page.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    let word = words[i] as string;
    for (let guard = 0; guard < 8 && word.length > width; guard += 1) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
};
