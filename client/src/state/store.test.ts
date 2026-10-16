import { beforeEach, describe, expect, it } from 'vitest';
import { appendMessage, historyExhausted, historyVersion, messages, prependMessages, removeMessage, setHistory, setHistoryExhausted } from './chat';
import { channelsByType, markRead, markUnread, selectedChannelId, setChannels, unread } from './channels';
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

  it('replaces history per channel', () => {
    appendMessage(message('old'));
    setHistory('c1', [message('h1'), message('h2')]);
    expect(messages.value.c1.map((m) => m.id)).toEqual(['h1', 'h2']);
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
});
