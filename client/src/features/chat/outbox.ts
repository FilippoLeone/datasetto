/**
 * Outgoing chat queue. Every message the user sends goes through here: it shows
 * in the list at once as "sending", is sent with an acknowledgement when the
 * socket is signed in, and is swapped for the real message when the server's
 * echo (carrying our client id) arrives. Typed while offline, messages wait in
 * order and go out on the next reconnect. A message not acknowledged within
 * `timeoutMs` (60 s) is marked failed with a retry, never silently dropped.
 *
 * A pending message can still be edited or deleted: while it waits, the entry
 * itself changes or goes. While it is in flight, the server may already have the
 * old text: once the server confirms it, the queue follows up with an edit (or a
 * delete) of the real message through `editSent` / `deleteSent`.
 */
export type PendingStatus = 'queued' | 'sending' | 'failed';

export interface PendingMessage {
  clientId: string;
  channelId: string;
  text: string;
  /** Ids of pictures already uploaded (POST /api/uploads); sent along with the text. */
  attachmentIds: string[];
  /** The message this one replies to, if any. */
  replyToId: string | null;
  createdAt: number;
  status: PendingStatus;
  /** Why it failed, when it did. */
  error: string | null;
  attempts: number;
}

export interface SendResult {
  success: boolean;
  /** The server's id for the message, when it was accepted. */
  messageId?: string;
  error?: string;
  code?: string;
}

export interface OutboxOptions {
  /** Deliver one message and resolve with the server's acknowledgement; reject when it cannot be sent now. */
  send: (message: PendingMessage) => Promise<SendResult>;
  /** Connected and signed in: a flush can send. */
  canSend: () => boolean;
  onChange?: (entries: PendingMessage[]) => void;
  /** The text of a message was changed while it was in flight: edit the stored message. */
  editSent?: (channelId: string, messageId: string, text: string) => void;
  /** A message was discarded while in flight and the server accepted it anyway: delete the stored message. */
  deleteSent?: (channelId: string, messageId: string) => void;
  /** How long a message may stay unacknowledged before it is marked failed. */
  timeoutMs?: number;
  /** Pause before sending again after a transport failure while still connected. */
  retryDelayMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  newId?: () => string;
}

export interface Outbox {
  /** Queue a message; it is sent right away when possible. */
  enqueue(channelId: string, text: string, attachmentIds?: string[], replyToId?: string | null): PendingMessage;
  /** Send what is queued, in order, one at a time. Safe to call any time. */
  flush(): void;
  /** The server echoed the message (with its id): drop the pending copy. */
  confirm(clientId: string, messageId?: string | null): boolean;
  /** Change the text of a pending message. Returns false when it is not pending (any more). */
  edit(clientId: string, text: string): boolean;
  /** Send a failed message again. */
  retry(clientId: string): void;
  /** Drop a pending message; one the server accepts after all is deleted there. */
  discard(clientId: string): void;
  entries(): PendingMessage[];
  pending(channelId: string): PendingMessage[];
}

export const OUTBOX_TIMEOUT_MS = 60_000;
export const OUTBOX_RETRY_DELAY_MS = 2_000;
export const FAILED_AFTER_TIMEOUT = 'Not sent. The server did not confirm it in time.';

let counter = 0;
const defaultId = () => 'c-' + Date.now().toString(36) + '-' + (counter += 1).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

export const createOutbox = ({
  send,
  canSend,
  onChange,
  editSent,
  deleteSent,
  timeoutMs = OUTBOX_TIMEOUT_MS,
  retryDelayMs = OUTBOX_RETRY_DELAY_MS,
  now = Date.now,
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (handle) => globalThis.clearTimeout(handle as number),
  newId = defaultId,
}: OutboxOptions): Outbox => {
  const entries: PendingMessage[] = [];
  const deadlines = new Map<string, unknown>();
  /** The text each in-flight message was sent with (an edit meanwhile differs from it). */
  const sentText = new Map<string, string>();
  /** Messages discarded while in flight, by client id, with their channel: deleted once the server names them. */
  const discardedInFlight = new Map<string, string>();
  let inFlight: PendingMessage | null = null;

  const notify = () => onChange?.(entries.map((entry) => ({ ...entry })));

  const remove = (clientId: string): boolean => {
    const index = entries.findIndex((entry) => entry.clientId === clientId);
    if (index === -1) return false;
    entries.splice(index, 1);
    const deadline = deadlines.get(clientId);
    if (deadline !== undefined) cancel(deadline);
    deadlines.delete(clientId);
    return true;
  };

  const fail = (entry: PendingMessage, error: string) => {
    entry.status = 'failed';
    entry.error = error;
    const deadline = deadlines.get(entry.clientId);
    if (deadline !== undefined) cancel(deadline);
    deadlines.delete(entry.clientId);
  };

  const armDeadline = (entry: PendingMessage) => {
    const existing = deadlines.get(entry.clientId);
    if (existing !== undefined) cancel(existing);
    deadlines.set(
      entry.clientId,
      schedule(() => {
        deadlines.delete(entry.clientId);
        if (entries.includes(entry) && entry.status !== 'failed') {
          fail(entry, FAILED_AFTER_TIMEOUT);
          notify();
        }
      }, timeoutMs),
    );
  };

  /**
   * The server accepted a message (echo or acknowledgement) and we know its id: a
   * discard or an edit made while it was in flight is applied to the stored message.
   */
  const settle = (clientId: string, messageId: string | null | undefined) => {
    if (!messageId) return;
    const discardedChannel = discardedInFlight.get(clientId);
    if (discardedChannel !== undefined) {
      discardedInFlight.delete(clientId);
      deleteSent?.(discardedChannel, messageId);
      return;
    }
    const entry = entries.find((item) => item.clientId === clientId);
    const sent = sentText.get(clientId);
    if (entry && sent !== undefined && entry.text !== sent) editSent?.(entry.channelId, messageId, entry.text);
    sentText.delete(clientId);
  };

  let retryTimer: unknown = null;

  const flush = (): void => {
    if (retryTimer !== null) {
      cancel(retryTimer);
      retryTimer = null;
    }
    if (inFlight || !canSend()) return;
    const next = entries.find((entry) => entry.status === 'queued');
    if (!next) return;
    inFlight = next;
    next.status = 'sending';
    next.attempts += 1;
    sentText.set(next.clientId, next.text);
    notify();
    let requeued = false;
    send({ ...next, attachmentIds: [...next.attachmentIds] })
      .then((result) => {
        if (result.success) settle(next.clientId, result.messageId);
        if (!entries.includes(next)) return;
        if (result.success) {
          // The echo normally removed it already; an ack without an echo still counts as delivered.
          remove(next.clientId);
        } else {
          fail(next, result.error || 'Not sent');
        }
      })
      .catch(() => {
        if (!entries.includes(next) || next.status === 'failed') return;
        // Could not be sent now (the socket dropped mid-flight, no answer): back in line. The next
        // connection flushes; if we are still connected, try again shortly rather than at once.
        next.status = 'queued';
        requeued = true;
      })
      .finally(() => {
        inFlight = null;
        sentText.delete(next.clientId);
        notify();
        if (requeued) retryTimer = schedule(flush, retryDelayMs);
        else flush();
      });
  };

  return {
    enqueue(channelId, text, attachmentIds = [], replyToId = null) {
      const entry: PendingMessage = {
        clientId: newId(),
        channelId,
        text,
        attachmentIds: [...attachmentIds],
        replyToId,
        createdAt: now(),
        status: 'queued',
        error: null,
        attempts: 0,
      };
      entries.push(entry);
      armDeadline(entry);
      notify();
      flush();
      return { ...entry };
    },
    flush,
    confirm(clientId, messageId = null) {
      settle(clientId, messageId);
      const removed = remove(clientId);
      if (removed) notify();
      return removed;
    },
    edit(clientId, text) {
      const entry = entries.find((item) => item.clientId === clientId);
      if (!entry) return false;
      entry.text = text;
      notify();
      return true;
    },
    retry(clientId) {
      const entry = entries.find((item) => item.clientId === clientId);
      if (!entry || entry.status !== 'failed') return;
      entry.status = 'queued';
      entry.error = null;
      entry.createdAt = now();
      armDeadline(entry);
      notify();
      flush();
    },
    discard(clientId) {
      const entry = entries.find((item) => item.clientId === clientId);
      if (!entry) return;
      // In flight: the server may still accept it; when it does, the stored copy is deleted.
      if (entry.status === 'sending') discardedInFlight.set(clientId, entry.channelId);
      if (remove(clientId)) notify();
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    pending: (channelId) => entries.filter((entry) => entry.channelId === channelId).map((entry) => ({ ...entry })),
  };
};
