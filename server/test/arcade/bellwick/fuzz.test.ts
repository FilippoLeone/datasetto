/** Fuzz (bellwick.md §13 test 5), first half of the rooms; the routine is in fuzzRooms.ts. */
import { describe, it } from 'vitest';
import { fuzzRooms } from './fuzzRooms.js';

describe('Bellwick fuzz', () => {
  it('survives random input from four heroes in the first 18 rooms', () => fuzzRooms(0, 18));
});
