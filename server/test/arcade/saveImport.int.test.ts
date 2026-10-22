/**
 * `arcade:saves:import` (platform.md §20.2 note 51): an imported save is the client's bytes, so the
 * game's `importSave` decides what is stored; a game without the hook refuses imports.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { b64url } from '../../src/arcade/core/bytes.js';
import { probeGame } from './harness/probeGame.js';
import { startArcadeServer, type ArcadeTestServer } from './harness/server.js';

let server: ArcadeTestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const stored = (s: ArcadeTestServer, ownerId: string): number[] | null => {
  const row = s.ctx.db.prepare('SELECT data FROM arcade_saves WHERE owner_id = ? AND game = ? AND slot = 0').get(ownerId, 'fuseyard') as { data: Buffer } | undefined;
  return row ? Array.from(row.data) : null;
};

describe('save import', () => {
  it("stores what the game's importSave returns, and refuses what it rejects", async () => {
    // Byte 0 is a "server-only" claim the game clears; a file starting with 0xff is refused.
    server = await startArcadeServer({
      arcade: { matchGames: [probeGame({ importSave: (data) => (data[0] === 0xff ? null : Uint8Array.of(0, ...data.subarray(1))) }), null] },
    });
    const account = await server.account();
    const socket = await account.socket();
    const imp = (bytes: number[]) => socket.request('arcade:saves:import', { game: 'fuseyard', slot: 0, version: 1, data: b64url(Uint8Array.from(bytes)) });
    expect(await imp([1, 7, 7])).toEqual({ ok: true });
    expect(stored(server, account.id)).toEqual([0, 7, 7]);
    expect(await imp([0xff, 1])).toEqual({ ok: false, code: 'invalid' });
    expect(stored(server, account.id)).toEqual([0, 7, 7]);
  });

  it('refuses imports for a game without the hook', async () => {
    server = await startArcadeServer({ arcade: { matchGames: [probeGame(), null] } });
    const account = await server.account();
    const socket = await account.socket();
    expect(await socket.request('arcade:saves:import', { game: 'fuseyard', slot: 0, version: 1, data: b64url(Uint8Array.of(1, 2)) })).toEqual({ ok: false, code: 'invalid' });
    expect(stored(server, account.id)).toBeNull();
  });
});
