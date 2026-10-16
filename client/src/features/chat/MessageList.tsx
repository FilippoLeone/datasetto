import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowDown, Hash, Trash2 } from 'lucide-preact';
import { Avatar, RoleBadge } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { formatDayLabel, formatFullDate, formatMessageTime, sameDay } from '@/lib/format';
import { api } from '@/services/socket/api';
import { loadedChannels, messages } from '@/state/chat';
import { account, can } from '@/state/session';
import { MessageBody } from './MessageBody';
import type { Channel, ChatMessage } from '@/types/protocol';

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

const MessageRow = ({ row, channelId }: { row: Row; channelId: string }) => {
  const { message, showHeader } = row;
  const me = account.value;
  const own = Boolean(me && message.accountId === me.id);
  const deletable = own || can('canDeleteAnyMessage');
  // Touch screens have no hover: a tap on the message toggles its actions.
  const [active, setActive] = useState(false);
  return (
    <div
      className={cn('message-row group relative flex gap-3 px-4 py-0.5 hover:bg-black/10 pointer-coarse:py-1', showHeader && 'mt-3', active && 'is-active')}
      onClick={() => {
        if (deletable && isTouchPrimary()) setActive((value) => !value);
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
      </div>
      {deletable && (
        <div className="message-actions absolute top-0 right-4 -translate-y-1/2 rounded-sm bg-elevated shadow-pop">
          <button
            type="button"
            aria-label="Delete message"
            title="Delete message"
            className="p-1.5 text-text-muted hover:text-live pointer-coarse:p-2.5"
            onClick={() => api.deleteMessage(channelId, message.id)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

export const MessageList = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const list = messages.value[channel.id] ?? [];
  const loaded = loadedChannels.value[channel.id] ?? false;
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

  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
    else setShowJump(true);
  }, [list.length]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distance < 48;
    if (stickToBottom.current) setShowJump(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto pb-4">
        {!compact && (
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
        {rows.map((row) => (
          <div key={row.message.id} className={cn(fresh.has(row.message.id) && 'animate-message-in')}>
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
