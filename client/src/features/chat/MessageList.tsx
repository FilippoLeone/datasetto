import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AlertCircle, ArrowDown, Clock, Hash, MessageCircle, SmilePlus, Trash2 } from 'lucide-preact';
import { Avatar, RoleBadge, Spinner } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { formatDayLabel, formatFullDate, formatMessageTime, sameDay } from '@/lib/format';
import { prefersReducedMotion } from '@/lib/motion';
import { serverConfig } from '@/services/ServerConfigService';
import { api } from '@/services/socket/api';
import { highlightedMessageId, historyExhausted, historyLoading, loadedChannels, messages, pendingMessages, scrollTarget } from '@/state/chat';
import { account, can } from '@/state/session';
import { EmojiPicker } from './EmojiPicker';
import { flashMessage, loadOlderMessages } from './history';
import { MessageBody } from './MessageBody';
import { outbox } from './outboxService';
import type { PendingMessage } from './outbox';
import type { Channel, ChatMessage, ReactionSummary } from '@/types/protocol';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Row {
  message: ChatMessage;
  showHeader: boolean;
  dayLabel: string | null;
}

const buildRows = (list: ChatMessage[]): Row[] => {
  const rows: Row[] = [];
  let previous: ChatMessage | null = null;
  for (const message of list) {
    const newDay = !previous || !sameDay(previous.ts, message.ts);
    const sameAuthor = previous && previous.accountId === message.accountId && previous.from === message.from;
    const close = previous && message.ts - previous.ts < GROUP_WINDOW_MS;
    rows.push({ message, showHeader: newDay || !sameAuthor || !close, dayLabel: newDay ? formatDayLabel(message.ts) : null });
    previous = message;
  }
  return rows;
};

/** "Alice, Bob and Carol reacted with 👍" for the chip tooltip. */
const reactionTitle = (reaction: ReactionSummary): string => {
  const names = reaction.names;
  const list = names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
  return list + ' reacted with ' + reaction.emoji;
};

const Reactions = ({ message, channelId, onAdd }: { message: ChatMessage; channelId: string; onAdd: () => void }) => {
  const list = message.reactions ?? [];
  if (list.length === 0) return null;
  const me = account.value?.id;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-reactions>
      {list.map((reaction) => {
        const mine = Boolean(me && reaction.accountIds.includes(me));
        return (
          <button
            key={reaction.emoji}
            type="button"
            title={reactionTitle(reaction)}
            aria-pressed={mine}
            aria-label={reaction.emoji + ' ' + reaction.count + (mine ? ', you reacted' : '')}
            onClick={(event) => {
              event.stopPropagation();
              if (mine) api.removeReaction(channelId, message.id, reaction.emoji);
              else api.addReaction(channelId, message.id, reaction.emoji);
            }}
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-px text-xs leading-5 transition-colors',
              mine ? 'border-brand bg-brand-soft text-text-bright' : 'border-border bg-base/60 text-text-muted hover:border-border-strong hover:text-text',
            )}
          >
            <span className="text-sm leading-none">{reaction.emoji}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label="Add reaction"
        title="Add reaction"
        onClick={(event) => {
          event.stopPropagation();
          onAdd();
        }}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-text-faint hover:border-border-strong hover:text-text"
      >
        <SmilePlus size={13} />
      </button>
    </div>
  );
};

const MessageRow = ({ row, channelId }: { row: Row; channelId: string }) => {
  const { message, showHeader } = row;
  const me = account.value;
  const own = Boolean(me && message.accountId === me.id);
  // Briefly lit after jumping here from a search result; the flash is feedback, so it survives reduced motion.
  const highlighted = highlightedMessageId.value === message.id;
  const deletable = own || can('canDeleteAnyMessage');
  // Touch screens have no hover: a tap on the message toggles its actions.
  const [active, setActive] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pick = (emoji: string) => {
    setPickerOpen(false);
    const existing = message.reactions?.find((entry) => entry.emoji === emoji);
    if (existing && me && existing.accountIds.includes(me.id)) api.removeReaction(channelId, message.id, emoji);
    else api.addReaction(channelId, message.id, emoji);
  };
  return (
    <div
      className={cn(
        'message-row group relative flex gap-3 px-4 py-0.5 hover:bg-black/10 pointer-coarse:py-1',
        showHeader && 'mt-3',
        (active || pickerOpen) && 'is-active',
        highlighted && 'is-highlighted motion-essential',
      )}
      onClick={() => {
        if (isTouchPrimary()) setActive((value) => !value);
      }}
    >
      <div className="w-10 shrink-0">
        {showHeader ? (
          <Avatar seed={message.accountId ?? message.from} name={message.from} size={40} />
        ) : (
          <span className="block pt-1 text-right text-[10px] text-text-faint opacity-0 group-hover:opacity-100 tabular-nums">
            {formatMessageTime(message.ts).slice(-5)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showHeader && (
          <div className="flex items-baseline gap-2">
            <span className={cn('font-semibold', own ? 'text-text-bright' : 'text-text-bright')}>{message.from}</span>
            <RoleBadge roles={message.roles} />
            <time className="text-xs text-text-faint" dateTime={new Date(message.ts).toISOString()} title={formatFullDate(message.ts)}>
              {formatMessageTime(message.ts)}
            </time>
          </div>
        )}
        <MessageBody text={message.text} />
        <Reactions message={message} channelId={channelId} onAdd={() => setPickerOpen(true)} />
      </div>
      <div className="message-actions absolute top-0 right-4 flex -translate-y-1/2 rounded-sm bg-elevated shadow-pop">
        <button
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          className="p-1.5 text-text-muted hover:text-text-bright pointer-coarse:p-2.5"
          onClick={(event) => {
            event.stopPropagation();
            setPickerOpen((value) => !value);
          }}
        >
          <SmilePlus size={16} />
        </button>
        {deletable && (
          <button
            type="button"
            aria-label="Delete message"
            title="Delete message"
            className="p-1.5 text-text-muted hover:text-live pointer-coarse:p-2.5"
            onClick={(event) => {
              event.stopPropagation();
              api.deleteMessage(channelId, message.id);
            }}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {pickerOpen && <EmojiPicker onPick={pick} onClose={() => setPickerOpen(false)} className="absolute top-full right-4 z-30 mt-1" />}
    </div>
  );
};

/**
 * One of our own messages the server has not confirmed yet: "sending" (also while the
 * socket is down: it goes out on reconnect) or, after 60 s or a refusal, "not sent" with
 * a retry. Rendered after the confirmed history, in send order.
 */
const PendingRow = ({ entry }: { entry: PendingMessage }) => {
  const me = account.value;
  const failed = entry.status === 'failed';
  return (
    <div className={cn('message-row relative mt-3 flex gap-3 px-4 py-0.5', !failed && 'opacity-60')} data-pending={entry.status} aria-live="polite">
      <div className="w-10 shrink-0">
        <Avatar seed={me?.id ?? 'me'} name={me?.displayName ?? 'You'} src={me?.avatarUrl} size={40} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-text-bright">{me?.displayName ?? 'You'}</span>
          <span className={cn('flex items-center gap-1 text-xs', failed ? 'text-live' : 'text-text-faint')}>
            {failed ? <AlertCircle size={12} /> : <Clock size={12} />}
            {failed ? (entry.error ?? 'Not sent') : 'Sending…'}
          </span>
        </div>
        <MessageBody text={entry.text} />
        {failed && (
          <div className="mt-1 flex gap-3 text-xs">
            <button type="button" className="font-semibold text-link hover:underline" onClick={() => outbox.retry(entry.clientId)}>
              Retry
            </button>
            <button type="button" className="text-text-muted hover:text-text-bright hover:underline" onClick={() => outbox.discard(entry.clientId)}>
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const MessageList = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const list = messages.value[channel.id] ?? [];
  const pending = pendingMessages.value[channel.id] ?? [];
  const loaded = loadedChannels.value[channel.id] ?? false;
  const loadingOlder = historyLoading.value[channel.id] ?? false;
  // The channel's first message is on screen: nothing older exists, or the first page was not even full.
  const pageSize = serverConfig.get()?.limits.chatHistoryLimit ?? 100;
  const atStart = (historyExhausted.value[channel.id] ?? false) || (loaded && list.length < pageSize);
  const target = scrollTarget.value;
  const rows = buildRows(list);
  // Messages that arrive after the history is on screen fade in; the history itself does not.
  const seen = useRef<{ channelId: string; loaded: boolean; ids: Set<string>; fresh: Set<string> } | null>(null);
  if (!seen.current || seen.current.channelId !== channel.id) {
    seen.current = { channelId: channel.id, loaded, ids: new Set(list.map((message) => message.id)), fresh: new Set() };
  } else {
    for (const message of list) {
      if (seen.current.ids.has(message.id)) continue;
      seen.current.ids.add(message.id);
      if (seen.current.loaded) seen.current.fresh.add(message.id);
    }
    seen.current.loaded = loaded;
  }
  const fresh = seen.current.fresh;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Scroll position to restore after older messages are put in front of the list.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // A message we just sent counts as the newest thing on screen until the server echoes it.
  const lastId = pending[pending.length - 1]?.clientId ?? list[list.length - 1]?.id ?? null;

  const scrollToBottom = (smooth = false) => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [channel.id]);

  // Only a new newest message moves the view; older pages arriving at the top do not.
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
    else setShowJump(true);
  }, [lastId]);

  // Older messages were added above: keep what the user was looking at in place.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const saved = anchor.current;
    if (!node || !saved) return;
    anchor.current = null;
    const delta = node.scrollHeight - saved.height;
    if (delta > 0) node.scrollTop = saved.top + delta;
  }, [list.length]);

  // A search result asked for one of these messages: bring it into view and light it up.
  useEffect(() => {
    if (!target || target.channelId !== channel.id) return;
    const node = scrollRef.current?.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(target.messageId) + '"]');
    if (!node) return;
    scrollTarget.value = null;
    stickToBottom.current = false;
    node.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    flashMessage(target.messageId);
  }, [target, channel.id, list.length]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distance < 48;
    if (stickToBottom.current) setShowJump(false);
    // Near the top: fetch the page before the oldest message we have.
    if (node.scrollTop < 160 && loaded && list.length > 0 && !atStart && !loadingOlder) {
      anchor.current = { height: node.scrollHeight, top: node.scrollTop };
      void loadOlderMessages(channel.id);
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto pb-4">
        {!compact && atStart && channel.type === 'dm' && (
          <div className="px-4 pt-8 pb-2">
            <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-active">
              <MessageCircle size={32} className="text-text-bright" />
            </div>
            <h3 className="text-2xl font-bold text-text-bright">{channel.dm?.peerName ?? 'Direct message'}</h3>
            <p className="text-sm text-text-muted">This is the start of your conversation with {channel.dm?.peerName ?? 'them'}. Only the two of you can read it.</p>
          </div>
        )}
        {!compact && atStart && channel.type !== 'dm' && (
          <div className="px-4 pt-8 pb-2">
            <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-active">
              <Hash size={32} className="text-text-bright" />
            </div>
            <h3 className="text-2xl font-bold text-text-bright">Welcome to #{channel.name}</h3>
            <p className="text-sm text-text-muted">This is the start of #{channel.name}.</p>
          </div>
        )}
        {!loaded && (
          <div className="flex flex-col gap-4 px-4 py-3" aria-busy="true" aria-label="Loading messages">
            {['70%', '45%', '60%'].map((width, index) => (
              <div key={index} className="flex gap-3">
                <span className="skeleton h-10 w-10 shrink-0" style={{ borderRadius: '9999px' }} />
                <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                  <span className="skeleton h-3 w-32" />
                  <span className="skeleton h-3" style={{ width }} />
                </span>
              </div>
            ))}
          </div>
        )}
        {loadingOlder && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-text-faint" aria-live="polite">
            <Spinner size={14} /> Loading older messages…
          </div>
        )}
        {rows.map((row) => (
          <div key={row.message.id} data-message-id={row.message.id} className={cn(fresh.has(row.message.id) && 'animate-message-in')}>
            {row.dayLabel && (
              <div className="my-3 flex items-center gap-3 px-4 text-[11px] font-semibold text-text-faint">
                <span className="h-px flex-1 bg-border-strong" />
                {row.dayLabel}
                <span className="h-px flex-1 bg-border-strong" />
              </div>
            )}
            <MessageRow row={row} channelId={channel.id} />
          </div>
        ))}
        {pending.map((entry) => (
          <PendingRow key={entry.clientId} entry={entry} />
        ))}
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            stickToBottom.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
          className="absolute right-4 bottom-3 flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white shadow-pop animate-slide-up"
        >
          <ArrowDown size={14} /> New messages
        </button>
      )}
    </div>
  );
};
