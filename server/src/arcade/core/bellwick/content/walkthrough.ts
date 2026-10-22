/**
 * The walkthrough the hero bot ("Pip", bellwick.md §9) follows: one step per line. The bot finds its own
 * way between steps (BFS across screens, over doors, edges and ledges); the steps say what to do where.
 *
 *   go <screen> x,y            walk to the tile
 *   use <d|u|l|r>             face that way and press A (chests, locks, lanterns, people)
 *   push <d|u|l|r>            push the block next to you that way until it slides
 *   hook <d|u|l|r>            throw the Vinehook that way and wait for the pull
 *   item <buckler|hook>       select a B item
 *   shield <screen> x,y <dir> walk to the tile holding the Buckler up, facing <dir>
 *   buy <item>                buy at the counter in front of you
 *   clear                     defeat every enemy in the room
 *   boss                      fight Old Clapper until the Heart Vessel lies there, then take it
 */
export default [
  // Kettlebrook: Hesper's gift and the Rootsword.
  'go hesper 2,3',
  'use u',
  'go hesper 9,3',
  'use u',
  // Glints for the Buckler: Windmill Hill, then the Rocky Rise cave (and its two-switch shard).
  'go windmill 3,4',
  'use u',
  'go cave 1,2',
  'use u',
  'go cave 3,2',
  'push d',
  'go cave 4,4',
  'push l',
  'go cave 6,4',
  'push r',
  'go cave 7,4',
  'push r',
  'go cave 9,1',
  'use r',
  // The Orchard's block maze.
  'go orchard 5,6',
  'push r',
  'go orchard 8,7',
  'push u',
  'go orchard 9,6',
  'use r',
  // Pell's Sundries.
  'go shop 3,3',
  'buy buckler',
  'go shop 5,3',
  'buy brew',
  // Through Gloam Gate with the Buckler up.
  'go gate 3,5',
  'shield gate 7,1 u',
  'go entry 2,3',
  'use u',
  // The Drowned Bellhouse: key A, then key C in the Chapel.
  'go cistern 2,5',
  'use d',
  'go chapel 9,4',
  'clear',
  'go chapel 5,3',
  'use u',
  // L1, the Switch Gallery, the Compass and the Vinehook.
  'go nave 10,4',
  'use r',
  'go gallery 4,5',
  'push u',
  'go gallery 4,4',
  'push u',
  'go gallery 7,5',
  'push u',
  'go gallery 7,4',
  'push u',
  'go gallery 3,6',
  'use d',
  'go vault 6,6',
  'use d',
  'item hook',
  'go vault 4,4',
  'hook u',
  // The Flooded Crypt: key B and a shard.
  'go crypt 3,6',
  'hook u',
  'go crypt 2,2',
  'use u',
  'go crypt 3,3',
  'hook d',
  'go crypt 8,6',
  'hook u',
  'go crypt 9,2',
  'use u',
  'go crypt 8,3',
  'hook d',
  'go vault 7,1',
  'hook d',
  // L2, the Bell Rope Hall, the Ossuary's shard, L3 and the Boss Key.
  'go nave 5,1',
  'use u',
  'go ossuary 10,2',
  'use u',
  'go ropehall 3,6',
  'hook u',
  'go ropehall 10,2',
  'use r',
  'go clockwork 6,6',
  'hook r',
  'go clockwork 10,3',
  'use u',
  // The Antechamber's lantern, the boss door, Old Clapper.
  'go ante 2,5',
  'use u',
  'go ante 5,1',
  'use u',
  'item buckler',
  'boss',
] as readonly string[];
