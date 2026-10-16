import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutbox, FAILED_AFTER_TIMEOUT, OUTBOX_RETRY_DELAY_MS, OUTBOX_TIMEOUT_MS, type PendingMessage, type SendResult } from './outbox';

interface Deferred {
  message: PendingMessage;
  resolve: (result: SendResult) => void;
  reject: (error: Error) => void;
}

const make = (online = true) => {
  const sent: Deferred[] = [];
  const changes: PendingMessage[][] = [];
  const state = { online };
  let ids = 0;
  const outbox = createOutbox({
    send: (message) =>
      new Promise<SendResult>((resolve, reject) => {
        sent.push({ message, resolve, reject });
      }),
    canSend: () => state.online,
    onChange: (entries) => changes.push(entries),
    newId: () => 'id' + (ids += 1),
  });
  return { outbox, sent, changes, state };
};

describe('outgoing message queue', () => {
  beforeEach(() => vi.useFakeTimers({ now: 50_000 }));
  afterEach(() => vi.useRealTimers());

  it('keeps messages typed while offline in order and sends them one by one on reconnect', async () => {
    const { outbox, sent, state } = make(false);
    outbox.enqueue('general', 'first');
    outbox.enqueue('random', 'second');
    outbox.enqueue('general', 'third');
    expect(sent).toHaveLength(0);
    expect(outbox.entries().map((entry) => [entry.clientId, entry.status])).toEqual([
      ['id1', 'queued'],
      ['id2', 'queued'],
      ['id3', 'queued'],
    ]);
    expect(outbox.pending('general').map((entry) => entry.text)).toEqual(['first', 'third']);

    state.online = true;
    outbox.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({ clientId: 'id1', channelId: 'general', text: 'first', status: 'sending', attempts: 1 });
    // Only one message is in flight at a time, so the order holds even over a slow link.
    outbox.flush();
    expect(sent).toHaveLength(1);

    // The echo arrives before the acknowledgement and takes the pending copy away.
    expect(outbox.confirm('id1')).toBe(true);
    expect(outbox.entries().map((entry) => entry.clientId)).toEqual(['id2', 'id3']);
    sent[0].resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1].message.clientId).toBe('id2');
    // An acknowledgement without an echo still counts as delivered.
    sent[1].resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[2].message.clientId).toBe('id3');
    sent[2].resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.entries()).toEqual([]);
    expect(outbox.confirm('id3')).toBe(false);
  });

  it('sends at once while connected and shows the message as sending until the echo', () => {
    const { outbox, sent, changes } = make(true);
    const entry = outbox.enqueue('general', 'hi');
    expect(sent).toHaveLength(1);
    expect(entry.status).toBe('sending');
    expect(outbox.entries()[0].status).toBe('sending');
    expect(changes.at(-1)![0].status).toBe('sending');
    outbox.confirm(entry.clientId);
    expect(outbox.entries()).toEqual([]);
  });

  it('marks a refused message as failed with the server reason, and lets the user retry or discard it', async () => {
    const { outbox, sent } = make(true);
    outbox.enqueue('general', 'nope');
    sent[0].reject(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(0);
    // A transport failure puts it back in line rather than failing it, and tries again shortly.
    expect(outbox.entries()[0].status).toBe('queued');
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_DELAY_MS);
    expect(sent).toHaveLength(2);
    sent[1].resolve({ success: false, error: 'No permission to send messages in this channel', code: 'FORBIDDEN' });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.entries()[0]).toMatchObject({ status: 'failed', error: 'No permission to send messages in this channel', attempts: 2 });

    outbox.retry('id1');
    expect(sent).toHaveLength(3);
    expect(outbox.entries()[0]).toMatchObject({ status: 'sending', error: null, attempts: 3 });
    sent[2].resolve({ success: false, error: 'still no' });
    await vi.advanceTimersByTimeAsync(0);
    outbox.discard('id1');
    expect(outbox.entries()).toEqual([]);
    // Retrying something that is not failed (or gone) does nothing.
    outbox.retry('id1');
    expect(sent).toHaveLength(3);
  });

  it('fails a message that is not confirmed within 60 s, even while still queued offline', async () => {
    const { outbox, sent, state } = make(false);
    outbox.enqueue('general', 'stuck');
    vi.advanceTimersByTime(OUTBOX_TIMEOUT_MS - 1);
    expect(outbox.entries()[0].status).toBe('queued');
    vi.advanceTimersByTime(1);
    expect(outbox.entries()[0]).toMatchObject({ status: 'failed', error: FAILED_AFTER_TIMEOUT });

    // Failed messages are not flushed; a retry restarts the clock.
    state.online = true;
    outbox.flush();
    expect(sent).toHaveLength(0);
    outbox.retry('id1');
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(OUTBOX_TIMEOUT_MS);
    expect(outbox.entries()[0].status).toBe('failed');
    // A late acknowledgement of a message already marked failed still removes it: it did arrive.
    sent[0].resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.entries()).toEqual([]);
  });
});
