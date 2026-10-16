import { beforeEach, describe, expect, it } from 'vitest';
import { appendMessage, messages, removeMessage, setHistory } from './chat';
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
