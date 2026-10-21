import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendMessage,
  applyMessageEdit,
  editing,
  historyExhausted,
  historyVersion,
  markMessageDeleted,
  messages,
  prependMessages,
  removeMessage,
  replyRefOf,
  replyTargets,
  setHistory,
  setHistoryExhausted,
  setReplyTarget,
  startEditing,
  updateMessage,
} from './chat';
import { channelsByType, markMention, markRead, markUnread, mentions, selectedChannelId, setChannels, totalMentions, totalUnread, unread } from './channels';
import type { ChatMessage } from '@/types/protocol';

const message = (id: string, channelId = 'c1'): ChatMessage => ({ id, channelId, from: 'a', text: id, ts: Date.now() });

describe('chat store', () => {
  beforeEach(() => {
    messages.value = {};
  });

  it('appends without duplicates and removes', () => {
    appendMessage(message('m1'));
    appendMessage(message('m1'));
    appendMessage(message('m2'));
    expect(messages.value.c1.map((m) => m.id)).toEqual(['m1', 'm2']);
    removeMessage('c1', 'm1');
    expect(messages.value.c1.map((m) => m.id)).toEqual(['m2']);
  });

  it('merges a preview card into a loaded message and ignores unknown ones', () => {
    appendMessage(message('m1'));
    const card = { url: 'https://example.com', title: 'T', description: null, image: null, siteName: null };
    updateMessage('c1', 'm1', { preview: card });
    expect(messages.value.c1[0].preview).toEqual(card);
    expect(messages.value.c1[0].text).toBe('m1');
    updateMessage('c1', 'm1', { preview: null });
    expect(messages.value.c1[0].preview).toBeNull();
    const before = messages.value;
    updateMessage('c1', 'missing', { preview: card });
    updateMessage('c2', 'm1', { preview: card });
    expect(messages.value).toBe(before);
  });

  it('replaces history per channel', () => {
    appendMessage(message('old'));
    setHistory('c1', [message('h1'), message('h2')]);
    expect(messages.value.c1.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('turns a deleted message into a tombstone in place and tells its replies', () => {
    const original = { ...message('m1'), reactions: [{ emoji: '👍', count: 1, accountIds: ['a'], names: ['A'] }], mentions: [{ accountId: 'b', name: 'B' }] };
    appendMessage(original);
    appendMessage({ ...message('m2'), replyTo: replyRefOf(original) });
    startEditing({ channelId: 'c1', messageId: 'm1' });
    setReplyTarget('c1', replyRefOf(original));
    markMessageDeleted('c1', 'm1');
    expect(messages.value.c1.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messages.value.c1[0]).toMatchObject({ deleted: true, text: '', reactions: [], mentions: [], replyTo: null });
    expect(messages.value.c1[1].replyTo).toMatchObject({ id: 'm1', deleted: true, text: '' });
    // Nothing can be edited or replied to once it is gone.
    expect(editing.value).toBeNull();
    expect(replyTargets.value.c1).toBeUndefined();
    markMessageDeleted('c1', 'missing');
    markMessageDeleted('c2', 'm1');
  });

  it('applies an edit to the message and to the quotes of it', () => {
    const original = message('m1');
    appendMessage(original);
    appendMessage({ ...message('m2'), replyTo: replyRefOf(original) });
    setReplyTarget('c1', replyRefOf(original));
    applyMessageEdit('c1', 'm1', { text: 'now  better', edited: true, editedAt: 5, mentions: [{ accountId: 'b', name: 'B' }] });
    expect(messages.value.c1[0]).toMatchObject({ text: 'now  better', edited: true, editedAt: 5, mentions: [{ accountId: 'b', name: 'B' }] });
    expect(messages.value.c1[1].replyTo?.text).toBe('now better');
    expect(replyTargets.value.c1.text).toBe('now better');
    setReplyTarget('c1', null);
    const before = messages.value;
    applyMessageEdit('c1', 'missing', { text: 'x' });
    expect(messages.value).toBe(before);
  });

  it('puts older pages in front without duplicates and forgets "exhausted" when history is replaced', () => {
    setHistory('c1', [message('h3'), message('h4')]);
    const version = historyVersion.value.c1;
    prependMessages('c1', [message('h1'), message('h2'), message('h3')]);
    expect(messages.value.c1.map((m) => m.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
    prependMessages('c1', [message('h1')]);
    expect(messages.value.c1).toHaveLength(4);
    setHistoryExhausted('c1', true);
    expect(historyExhausted.value.c1).toBe(true);
    setHistory('c1', [message('h4')]);
    expect(historyVersion.value.c1).toBe(version + 1);
    expect(historyExhausted.value.c1).toBeUndefined();
  });
});

describe('channels store', () => {
  it('groups by type and drops a stale selection', () => {
    selectedChannelId.value = 'gone';
    setChannels([
      { id: 't', name: 'general', type: 'text', count: 0 },
      { id: 'v', name: 'lobby', type: 'voice', count: 0 },
    ]);
    expect(channelsByType.value.text.map((c) => c.id)).toEqual(['t']);
    expect(channelsByType.value.voice.map((c) => c.id)).toEqual(['v']);
    expect(selectedChannelId.value).toBeNull();
  });

  it('tracks unread counts', () => {
    unread.value = {};
    markUnread('t');
    markUnread('t');
    expect(unread.value.t).toBe(2);
    markRead('t');
    expect(unread.value.t).toBeUndefined();
  });

  it('counts mentions per channel and clears them with the unread count', () => {
    unread.value = {};
    mentions.value = {};
    markUnread('t');
    markMention('t');
    markUnread('u');
    expect(mentions.value).toEqual({ t: 1 });
    expect(totalMentions.value).toBe(1);
    expect(totalUnread.value).toBe(2);
    markRead('t');
    expect(mentions.value).toEqual({});
    expect(unread.value).toEqual({ u: 1 });
  });
});
