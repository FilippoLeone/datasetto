import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AlertCircle, ArrowDown, Clock, Copy, CornerUpLeft, Hash, MessageCircle, Pencil, SmilePlus, Trash2 } from 'lucide-preact';
import { Avatar, Button, RoleBadge, Sheet, SheetItem, Spinner } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { formatDayLabel, formatFullDate, formatMessageTime, sameDay } from '@/lib/format';
import { LongPressTracker } from '@/lib/gestures';
import { quoteText } from '@/lib/markdown';
import { MOTION, prefersReducedMotion, usePresence, type PresenceState } from '@/lib/motion';
import { serverConfig } from '@/services/ServerConfigService';
import { api } from '@/services/socket/api';
import {
  editing,
  highlightedMessageId,
  historyExhausted,
  historyLoading,
  loadedChannels,
  messages,
  pendingMessages,
  replyRefOf,
  scrollTarget,
  setReplyTarget,
  startEditing,
} from '@/state/chat';
import { avatarOf } from '@/state/avatars';
import { account, can } from '@/state/session';
import { AttachmentGrid } from './AttachmentGrid';
import { isMobile, toast } from '@/state/ui';
import { EmojiPicker } from './EmojiPicker';
import { flashMessage, jumpToMessage, loadOlderMessages } from './history';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MessageBody } from './MessageBody';
import { editChatMessage, outbox } from './outboxService';
import type { PendingMessage } from './outbox';
import type { Channel, ChatMessage, ReactionSummary, ReplyRef } from '@/types/protocol';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** The row of one-tap reactions at the top of the message sheet. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '👀'];

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
    // A reply starts its own block so the quote sits under the author's name.
    rows.push({ message, showHeader: newDay || !sameAuthor || !close || Boolean(message.replyTo), dayLabel: newDay ? formatDayLabel(message.ts) : null });
    previous = message;
  }
  return rows;
};

/** "Alice, Bob and Carol reacted with 👍" for the chip tooltip and the sheet. */
const reactionTitle = (reaction: ReactionSummary): string => {
  const names = reaction.names;
  const list = names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
  return list + ' reacted with ' + reaction.emoji;
};

/** Add or take back my reaction with this emoji. */
const toggleReaction = (channelId: string, message: ChatMessage, emoji: string): void => {
  const me = account.value?.id;
  const existing = message.reactions?.find((entry) => entry.emoji === emoji);
  if (existing && me && existing.accountIds.includes(me)) api.removeReaction(channelId, message.id, emoji);
  else api.addReaction(channelId, message.id, emoji);
};

/** Start a reply: the composer shows the quote and sends the next message as a reply. */
const replyTo = (channelId: string, message: ChatMessage): void => {
  setReplyTarget(channelId, replyRefOf(message));
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
              toggleReaction(channelId, message, reaction.emoji);
            }}
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-px text-xs leading-5 transition-colors pointer-coarse:h-8 pointer-coarse:px-2.5 pointer-coarse:text-sm',
              mine ? 'border-brand bg-brand-soft text-text-bright' : 'border-border bg-base/60 text-text-muted hover:border-border-strong hover:text-text',
            )}
          >
            <span className="text-sm leading-none pointer-coarse:text-base">{reaction.emoji}</span>
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
        className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-text-faint hover:border-border-strong hover:text-text pointer-coarse:h-8 pointer-coarse:w-8"
      >
        <SmilePlus size={13} />
      </button>
    </div>
  );
};

/** The quoted original above a reply; a click scrolls to it (loading older history on the way). */
const ReplyQuote = ({ reply, channelId }: { reply: ReplyRef; channelId: string }) => {
  const gone = reply.from === null;
  const label = gone
    ? 'Original message unavailable'
    : reply.deleted
      ? 'Message deleted'
      : quoteText(reply.text) || (reply.pictures === 1 ? 'Picture' : reply.pictures > 1 ? reply.pictures + ' pictures' : '');
  return (
    <button
      type="button"
      className="reply-quote mb-0.5 flex max-w-full items-center gap-1.5 rounded-sm text-xs text-text-muted hover:text-text disabled:cursor-default disabled:hover:text-text-muted"
      aria-label={gone ? 'Replying to a message that is no longer available' : 'Jump to the message from ' + reply.from}
      title={gone ? undefined : 'Jump to the original message'}
      disabled={gone}
      onClick={(event) => {
        event.stopPropagation();
        if (!gone) void jumpToMessage(channelId, reply.id);
      }}
    >
      <CornerUpLeft size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
      {!gone && <Avatar seed={reply.accountId ?? reply.from ?? ''} name={reply.from ?? ''} src={avatarOf(reply.accountId, reply.avatarUrl)} size={16} />}
      {!gone && <span className="shrink-0 font-semibold text-text-bright">{reply.from}</span>}
      <span className={cn('min-w-0 truncate', (gone || reply.deleted) && 'italic')}>{label}</span>
    </button>
  );
};

interface EditBoxProps {
  initial: string;
  /** Resolve true when the new text was accepted (the box closes). */
  onSave: (text: string) => Promise<boolean> | boolean;
  onCancel: () => void;
}

/** In-place editor for one of our own messages: Enter saves, Escape cancels (buttons on touch screens). */
const EditBox = ({ initial, onSave, onCancel }: EditBoxProps) => {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const maxLength = serverConfig.get()?.limits.maxMessageLength ?? 2000;

  const resize = () => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 240) + 'px';
  };

  // Focus as soon as the box is in the DOM (not through an animation frame: a background tab has none),
  // and once more a tick later in case something else took the focus during the same render.
  useLayoutEffect(() => {
    const focus = () => {
      const node = ref.current;
      if (!node || document.activeElement === node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    };
    resize();
    focus();
    const timer = window.setTimeout(focus, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const save = async () => {
    const value = text.trim().slice(0, maxLength);
    if (!value || value === initial) {
      onCancel();
      return;
    }
    setSaving(true);
    const accepted = await onSave(value);
    setSaving(false);
    if (accepted) onCancel();
  };

  return (
    <div className="mt-1 rounded-md bg-input px-3 py-2" data-editing>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        maxLength={maxLength}
        aria-label="Edit message"
        className="scrollbar-thin max-h-[240px] w-full resize-none bg-transparent text-sm text-text-bright outline-none"
        onInput={(event) => {
          setText((event.target as HTMLTextAreaElement).value);
          resize();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && !event.shiftKey && !isMobile.value) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-text-muted">
        <span className="mr-auto pointer-coarse:hidden">escape to cancel, enter to save</span>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
};

interface MessageSheetProps {
  message: ChatMessage;
  channelId: string;
  editable: boolean;
  deletable: boolean;
  state: PresenceState;
  onClose: () => void;
  onEdit: () => void;
  onMoreReactions: () => void;
}

/** Long-press menu of a message on touch screens: quick reactions, reply, copy, edit, delete, who reacted. */
const MessageSheet = ({ message, channelId, editable, deletable, state, onClose, onEdit, onMoreReactions }: MessageSheetProps) => {
  const me = account.value?.id;
  const mine = (emoji: string) => Boolean(me && message.reactions?.some((entry) => entry.emoji === emoji && entry.accountIds.includes(me)));
  const copy = async () => {
    onClose();
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success('Message copied');
    } catch {
      toast.error('Could not copy the message');
    }
  };
  return (
    <Sheet title={message.from + ' · ' + formatMessageTime(message.ts)} state={state} onClose={onClose}>
      <p className="line-clamp-3 px-5 pb-2 text-sm break-words text-text-muted">{message.text}</p>
      <div className="flex items-center justify-between px-4 py-1" role="group" aria-label="Quick reactions">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={(mine(emoji) ? 'Remove your ' : 'React with ') + emoji}
            aria-pressed={mine(emoji)}
            className={cn('flex h-12 w-12 items-center justify-center rounded-full text-2xl active:bg-active', mine(emoji) && 'bg-brand-soft ring-1 ring-brand')}
            onClick={() => {
              toggleReaction(channelId, message, emoji);
              onClose();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
      <div role="menu" className="py-1">
        <SheetItem
          icon={<CornerUpLeft size={18} />}
          label="Reply"
          onSelect={() => {
            replyTo(channelId, message);
            onClose();
          }}
        />
        <SheetItem icon={<SmilePlus size={18} />} label="More reactions…" onSelect={onMoreReactions} />
        {message.text && <SheetItem icon={<Copy size={18} />} label="Copy text" onSelect={() => void copy()} />}
        {editable && (
          <SheetItem
            icon={<Pencil size={18} />}
            label="Edit message"
            onSelect={() => {
              onClose();
              onEdit();
            }}
          />
        )}
        {deletable && (
          <SheetItem
            danger
            icon={<Trash2 size={18} />}
            label="Delete message"
            onSelect={() => {
              api.deleteMessage(channelId, message.id);
              onClose();
            }}
          />
        )}
      </div>
      {(message.reactions?.length ?? 0) > 0 && (
        <div className="px-5 pt-1 pb-2 text-xs text-text-muted">
          {message.reactions!.map((reaction) => (
            <p key={reaction.emoji} className="truncate">
              {reactionTitle(reaction)}
            </p>
          ))}
        </div>
      )}
    </Sheet>
  );
};

/** A hover/focus action on a message row. */
const RowAction = ({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: preact.ComponentChildren }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={cn('p-1.5 text-text-muted pointer-coarse:p-3', danger ? 'hover:text-live' : 'hover:text-text-bright')}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {children}
  </button>
);

/** Avatar for the first message of a block, the time (shown on hover) for the following ones. */
const Gutter = ({ message, showHeader }: { message: ChatMessage; showHeader: boolean }) => (
  <div className="w-10 shrink-0">
    {showHeader ? (
      <Avatar seed={message.accountId ?? message.from} name={message.from} src={avatarOf(message.accountId, message.authorAvatarUrl)} size={40} />
    ) : (
      <span className="message-time block pt-1 text-right text-[10px] text-text-faint opacity-0 group-hover:opacity-100 tabular-nums">
        {formatMessageTime(message.ts).slice(-5)}
      </span>
    )}
  </div>
);

const MessageHeader = ({ message }: { message: ChatMessage }) => (
  <div className="flex items-baseline gap-2">
    <span className="font-semibold text-text-bright">{message.from}</span>
    <RoleBadge roles={message.roles} />
    <time className="text-xs text-text-faint" dateTime={new Date(message.ts).toISOString()} title={formatFullDate(message.ts)}>
      {formatMessageTime(message.ts)}
    </time>
  </div>
);

const MessageRow = ({ row, channelId }: { row: Row; channelId: string }) => {
  const { message, showHeader } = row;
  const me = account.value;
  const own = Boolean(me && message.accountId === me.id);
  // Briefly lit after jumping here from a search result or a reply quote; the flash is feedback, so it survives reduced motion.
  const highlighted = highlightedMessageId.value === message.id;
  const deleted = message.deleted === true;
  const deletable = !deleted && (own || can('canDeleteAnyMessage'));
  const editable = !deleted && own;
  const mentionsMe = Boolean(me && message.mentions?.some((mention) => mention.accountId === me.id));
  const isEditing = editing.value?.channelId === channelId && editing.value.messageId === message.id;
  // Touch screens have no hover: a tap on the message toggles its actions, a long press opens the sheet.
  const [active, setActive] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheet = usePresence(sheetOpen && !deleted, MOTION.base);
  const press = useMemo(
    () =>
      new LongPressTracker(() => {
        setSheetOpen(true);
        try {
          navigator.vibrate?.(10);
        } catch {
          /* not allowed */
        }
      }),
    [],
  );
  const pick = (emoji: string) => {
    setPickerOpen(false);
    toggleReaction(channelId, message, emoji);
  };
  const edit = () => startEditing({ channelId, messageId: message.id });

  if (deleted) {
    return (
      <div className={cn('message-row relative flex gap-3 px-4 py-0.5 pointer-coarse:py-1', showHeader && 'mt-3', highlighted && 'is-highlighted motion-essential')} data-deleted>
        <Gutter message={message} showHeader={showHeader} />
        <div className="min-w-0 flex-1">
          {showHeader && <MessageHeader message={message} />}
          <p className="text-sm text-text-faint italic">Message deleted</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'message-row group relative flex gap-3 px-4 py-0.5 hover:bg-black/10 pointer-coarse:py-1',
        showHeader && 'mt-3',
        (active || pickerOpen || sheetOpen) && 'is-active',
        highlighted && 'is-highlighted motion-essential',
        mentionsMe && 'is-mention',
      )}
      data-mentions-me={mentionsMe ? 'true' : undefined}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch' && !isEditing) press.down(event.clientX, event.clientY, event.pointerId);
      }}
      onPointerMove={(event) => press.move(event.clientX, event.clientY, event.pointerId)}
      onPointerUp={(event) => press.up(event.pointerId)}
      onPointerCancel={() => press.cancel()}
      onContextMenu={(event) => {
        // Android fires contextmenu for a long press; the sheet is the menu here.
        if (press.fired || press.pending) event.preventDefault();
      }}
      onClick={(event) => {
        if (press.fired) {
          press.fired = false;
          event.preventDefault();
          return;
        }
        if (!isTouchPrimary() || isEditing) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('a, button, textarea')) return;
        setActive((value) => !value);
      }}
    >
      <Gutter message={message} showHeader={showHeader} />
      <div className="min-w-0 flex-1">
        {showHeader && <MessageHeader message={message} />}
        {message.replyTo && <ReplyQuote reply={message.replyTo} channelId={channelId} />}
        {isEditing ? (
          <EditBox initial={message.text} onSave={(text) => editChatMessage(channelId, message.id, text)} onCancel={() => startEditing(null)} />
        ) : (
          <MessageBody
            text={message.text}
            mentions={message.mentions}
            selfId={me?.id}
            trailer={
              message.edited ? (
                <span className="message-edited" title={message.editedAt ? 'Edited ' + formatFullDate(message.editedAt) : 'Edited'}>
                  (edited)
                </span>
              ) : undefined
            }
          />
        )}
        <AttachmentGrid attachments={message.attachments} />
        <LinkPreviewCard preview={message.preview} canRemove={deletable} onRemove={() => api.removePreview(channelId, message.id)} />
        <Reactions message={message} channelId={channelId} onAdd={() => setPickerOpen(true)} />
      </div>
      {!isEditing && (
        <div className="message-actions absolute top-0 right-4 flex -translate-y-1/2 rounded-sm bg-elevated shadow-pop" role="toolbar" aria-label="Message actions">
          <RowAction label="Reply" onClick={() => replyTo(channelId, message)}>
            <CornerUpLeft size={16} />
          </RowAction>
          <RowAction label="Add reaction" onClick={() => setPickerOpen((value) => !value)}>
            <SmilePlus size={16} />
          </RowAction>
          {editable && (
            <RowAction label="Edit message" onClick={edit}>
              <Pencil size={16} />
            </RowAction>
          )}
          {deletable && (
            <RowAction label="Delete message" danger onClick={() => api.deleteMessage(channelId, message.id)}>
              <Trash2 size={16} />
            </RowAction>
          )}
        </div>
      )}
      {pickerOpen && <EmojiPicker onPick={pick} onClose={() => setPickerOpen(false)} className="absolute top-full right-4 z-30 mt-1" title="React to this message" />}
      {sheet.mounted && (
        <MessageSheet
          message={message}
          channelId={channelId}
          editable={editable}
          deletable={deletable}
          state={sheet.state}
          onClose={() => setSheetOpen(false)}
          onEdit={edit}
          onMoreReactions={() => {
            setSheetOpen(false);
            setPickerOpen(true);
          }}
        />
      )}
    </div>
  );
};

/**
 * One of our own messages the server has not confirmed yet: "sending" (also while the
 * socket is down: it goes out on reconnect) or, after 60 s or a refusal, "not sent" with
 * a retry. Rendered after the confirmed history, in send order. It can still be edited
 * (the queued text changes) or deleted (the entry is dropped).
 */
const PendingRow = ({ entry }: { entry: PendingMessage }) => {
  const me = account.value;
  const failed = entry.status === 'failed';
  const isEditing = editing.value?.channelId === entry.channelId && editing.value.clientId === entry.clientId;
  const original = entry.replyToId ? messages.value[entry.channelId]?.find((message) => message.id === entry.replyToId) : undefined;
  const reply: ReplyRef | null = entry.replyToId ? (original ? replyRefOf(original) : { id: entry.replyToId, from: null, accountId: null, text: '', deleted: true, pictures: 0 }) : null;
  return (
    <div className={cn('message-row group relative mt-3 flex gap-3 px-4 py-0.5 hover:bg-black/10', !failed && 'opacity-60')} data-pending={entry.status} aria-live="polite">
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
        {reply && <ReplyQuote reply={reply} channelId={entry.channelId} />}
        {isEditing ? (
          <EditBox initial={entry.text} onSave={(text) => outbox.edit(entry.clientId, text)} onCancel={() => startEditing(null)} />
        ) : (
          <MessageBody text={entry.text || (entry.attachmentIds.length === 1 ? '1 picture' : entry.attachmentIds.length + ' pictures')} selfId={me?.id} />
        )}
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
      {!isEditing && (
        <div className="message-actions absolute top-0 right-4 flex -translate-y-1/2 rounded-sm bg-elevated shadow-pop" role="toolbar" aria-label="Message actions">
          <RowAction label="Edit message" onClick={() => startEditing({ channelId: entry.channelId, clientId: entry.clientId })}>
            <Pencil size={16} />
          </RowAction>
          <RowAction label="Delete message" danger onClick={() => outbox.discard(entry.clientId)}>
            <Trash2 size={16} />
          </RowAction>
        </div>
      )}
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

  // The list got shorter (the on-screen keyboard came up, the phone turned): stay at the newest message.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Older messages were added above: keep what the user was looking at in place.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const saved = anchor.current;
    if (!node || !saved) return;
    anchor.current = null;
    const delta = node.scrollHeight - saved.height;
    if (delta > 0) node.scrollTop = saved.top + delta;
  }, [list.length]);

  // A search result or a reply quote asked for one of these messages: bring it into view and light it up.
  useEffect(() => {
    if (!target || target.channelId !== channel.id) return;
    const node = scrollRef.current?.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(target.messageId) + '"]');
    if (!node) return;
    scrollTarget.value = null;
    stickToBottom.current = false;
    node.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    flashMessage(target.messageId);
  }, [target, channel.id, list.length]);

  // An edit of a pending message ends when the server confirms it (the pending row is gone).
  const pendingIds = pending.map((entry) => entry.clientId).join(' ');
  useEffect(() => {
    const current = editing.value;
    if (current?.clientId && current.channelId === channel.id && !pendingIds.split(' ').includes(current.clientId)) startEditing(null);
  }, [pendingIds, channel.id]);

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
          className="absolute right-4 bottom-3 flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white shadow-pop animate-slide-up pointer-coarse:py-2"
        >
          <ArrowDown size={14} /> New messages
        </button>
      )}
    </div>
  );
};
