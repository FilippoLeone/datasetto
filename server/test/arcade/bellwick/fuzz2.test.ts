/** Fuzz, second half of the rooms (see fuzz.test.ts). */
import { describe, it } from 'vitest';
import { fuzzRooms } from './fuzzRooms.js';

describe('Bellwick fuzz', () => {
  it('survives random input from four heroes in the last 18 rooms', () => fuzzRooms(18, 36));
});
