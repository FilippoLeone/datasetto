import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, CornerUpLeft, ImagePlus, Send, Smile, X } from 'lucide-preact';
import { IconButton } from '@/components';
import { addFiles, attachmentIds, canSend, filesFromTransfer, removeDraft, transferHasFiles, updateDraft, type AttachmentDraft } from '@/lib/attachments';
import { cn } from '@/lib/cn';
import { quoteText } from '@/lib/markdown';
import { sounds } from '@/services/sounds';
import { serverConfig } from '@/services/ServerConfigService';
import { uploadImage, type UploadHandle } from '@/services/uploads';
import { channelLabel } from '@/state/channels';
import { messages, pendingMessages, replyTargets, setReplyTarget, startEditing } from '@/state/chat';
import { account, connectionStatus } from '@/state/session';
import { isMobile, toast } from '@/state/ui';
import type { Channel, MentionCandidate } from '@/types/protocol';
import { EmojiPicker } from './EmojiPicker';
import { MentionAutocomplete, optionId } from './MentionAutocomplete';
import { knownMentionCandidates, loadMentionCandidates } from './mentionCandidates';
import { insertMention, mentionQueryAt, rankMentionCandidates, type MentionQuery } from './mentions';
import { sendChatMessage } from './outboxService';

/** One picture in the strip above the text box: thumbnail, progress, error, remove. */
const DraftTile = ({ draft, onRemove, onRetry }: { draft: AttachmentDraft; onRemove: () => void; onRetry: () => void }) => (
  <div className="group/draft relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-md bg-base/60 animate-pop" title={draft.file.name}>
    <img src={draft.previewUrl} alt={draft.file.name} className={cn('h-full w-full object-cover', draft.status !== 'ready' && 'opacity-60')} draggable={false} />
    {draft.status === 'uploading' && (
      <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40" role="progressbar" aria-label={'Uploading ' + draft.file.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(draft.progress * 100)}>
        <div className="h-full bg-brand transition-[width] duration-150" style={{ width: Math.round(draft.progress * 100) + '%' }} />
      </div>
    )}
    {draft.status === 'error' && (
      <button type="button" className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-black/55 text-[10px] text-white" onClick={onRetry} title={draft.error ?? 'Upload failed'}>
        <AlertTriangle size={16} className="text-warning" />
        Retry
      </button>
    )}
    <button
      type="button"
      aria-label={'Remove ' + draft.file.name}
      className="absolute top-0.5 right-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover/draft:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
      onClick={onRemove}
    >
      <X size={12} />
    </button>
  </div>
);

interface MentionState {
  query: MentionQuery;
  candidates: MentionCandidate[];
  active: number;
}

const MENTION_LIST_ID = 'composer-mentions';

export const Composer = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploads = useRef(new Map<string, UploadHandle>());
  const dragDepth = useRef(0);
  const maxLength = serverConfig.get()?.limits.maxMessageLength ?? 2000;
  const limits = serverConfig.uploadLimits();
  // Typing never waits for the connection: a message written while reconnecting is queued
  // (shown as "sending" in the list) and goes out as soon as the socket is back.
  const connected = connectionStatus.value === 'connected';
  const target = (channel.type === 'dm' ? '@' : '#') + channelLabel(channel);
  const sendable = canSend(text, drafts);
  const reply = replyTargets.value[channel.id] ?? null;

  const discardAll = () => {
    for (const handle of uploads.current.values()) handle.abort();
    uploads.current.clear();
    setDrafts((current) => {
      for (const draft of current) URL.revokeObjectURL(draft.previewUrl);
      return [];
    });
  };

  useEffect(() => {
    setText('');
    setMention(null);
    discardAll();
    if (!isMobile.value) textareaRef.current?.focus();
    return discardAll;
  }, [channel.id]);

  // "Reply" on a message: the quote shows here and the box takes the focus (not on phones, where the keyboard would pop up).
  const replyId = reply?.id ?? null;
  useEffect(() => {
    if (replyId && !isMobile.value) textareaRef.current?.focus();
  }, [replyId]);

  const resize = () => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 200) + 'px';
  };

  const startUpload = (draft: AttachmentDraft) => {
    const handle = uploadImage(draft.file, (progress) => setDrafts((current) => updateDraft(current, draft.key, { progress })));
    uploads.current.set(draft.key, handle);
    handle.done
      .then((attachment) => setDrafts((current) => updateDraft(current, draft.key, { status: 'ready', progress: 1, attachment })))
      .catch((error: Error) => setDrafts((current) => updateDraft(current, draft.key, { status: 'error', error: error.message })))
      .finally(() => uploads.current.delete(draft.key));
  };

  const attach = (files: File[]) => {
    if (files.length === 0) return;
    const result = addFiles(drafts, files, { maxBytes: limits.maxBytes, maxFiles: limits.maxFilesPerMessage, acceptedTypes: limits.acceptedTypes });
    for (const reason of new Set(result.rejected.map((entry) => entry.reason))) toast.warning(reason);
    const fresh = result.drafts.filter((draft) => !drafts.some((existing) => existing.key === draft.key));
    setDrafts(result.drafts);
    for (const draft of fresh) startUpload(draft);
    if (!isMobile.value) textareaRef.current?.focus();
  };

  const remove = (draft: AttachmentDraft) => {
    uploads.current.get(draft.key)?.abort();
    uploads.current.delete(draft.key);
    URL.revokeObjectURL(draft.previewUrl);
    setDrafts((current) => removeDraft(current, draft.key));
  };

  const retry = (draft: AttachmentDraft) => {
    setDrafts((current) => updateDraft(current, draft.key, { status: 'uploading', progress: 0, error: null }));
    startUpload(draft);
  };

  // Dropping a picture anywhere in the app attaches it here; without this the browser would open the file.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (transferHasFiles(event.dataTransfer)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      attach(filesFromTransfer(event.dataTransfer));
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  });

  const send = () => {
    if (!sendable) return;
    const value = text.trim().slice(0, maxLength);
    sendChatMessage(channel.id, value, attachmentIds(drafts), reply?.id ?? null);
    sounds.play('messageSent', 0.2);
    setText('');
    setMention(null);
    if (reply) setReplyTarget(channel.id, null);
    for (const draft of drafts) URL.revokeObjectURL(draft.previewUrl);
    setDrafts([]);
    requestAnimationFrame(resize);
  };

  const insertEmoji = (emoji: string) => {
    const node = textareaRef.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + emoji.length, start + emoji.length);
      resize();
    });
  };

  /**
   * After every keystroke or caret move: is an @mention being typed? Then show
   * who matches. The server's member list arrives a moment later the first time;
   * what is known already (people online) shows at once.
   */
  const refreshMention = (value: string, caret: number) => {
    const query = mentionQueryAt(value, caret);
    if (!query) {
      if (mention) setMention(null);
      return;
    }
    const show = (candidates: MentionCandidate[]) => {
      const ranked = rankMentionCandidates(candidates, query.query);
      setMention(ranked.length > 0 ? { query, candidates: ranked, active: 0 } : null);
    };
    show(knownMentionCandidates(channel));
    void loadMentionCandidates(channel).then((candidates) => {
      // Still typing the same mention? The list may have grown.
      const node = textareaRef.current;
      if (!node) return;
      const current = mentionQueryAt(node.value, node.selectionStart ?? node.value.length);
      if (!current || current.start !== query.start) return;
      const ranked = rankMentionCandidates(candidates, current.query);
      setMention(ranked.length > 0 ? { query: current, candidates: ranked, active: 0 } : null);
    });
  };

  const pickMention = (candidate: MentionCandidate) => {
    if (!mention) return;
    const next = insertMention(text, mention.query, candidate);
    setText(next.text);
    setMention(null);
    const node = textareaRef.current;
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(next.caret, next.caret);
      resize();
    });
  };

  /** Arrow up in an empty box edits our newest message here (a pending one first, else the last one sent). */
  const editLastOwn = (): boolean => {
    const pending = pendingMessages.value[channel.id] ?? [];
    const last = pending[pending.length - 1];
    if (last) {
      startEditing({ channelId: channel.id, clientId: last.clientId });
      return true;
    }
    const me = account.value?.id;
    const own = (messages.value[channel.id] ?? []).filter((message) => message.accountId === me && !message.deleted);
    const latest = own[own.length - 1];
    if (!latest) return false;
    startEditing({ channelId: channel.id, messageId: latest.id });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (mention) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, active: (mention.active + step + mention.candidates.length) % mention.candidates.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pickMention(mention.candidates[mention.active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Escape' && reply) {
      event.preventDefault();
      event.stopPropagation();
      setReplyTarget(channel.id, null);
      return;
    }
    if (event.key === 'ArrowUp' && text === '' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (editLastOwn()) event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !isMobile.value) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className={cn('shrink-0 px-4 pb-4', compact && 'px-3 pb-3')}>
      <div
        className={cn('composer-dropzone relative rounded-lg bg-input transition-shadow', dragging && 'is-dragging')}
        onDragEnter={(event) => {
          if (!transferHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
      >
        {mention && <MentionAutocomplete id={MENTION_LIST_ID} candidates={mention.candidates} activeIndex={mention.active} onPick={pickMention} onActivate={(index) => setMention({ ...mention, active: index })} />}
        {reply && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-text-muted" data-reply-bar>
            <CornerUpLeft size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
            <span className="min-w-0 truncate">
              Replying to <span className="font-semibold text-text-bright">{reply.from ?? 'a deleted message'}</span>
              {reply.text && <span className="text-text-faint"> · {quoteText(reply.text)}</span>}
            </span>
            <IconButton label="Cancel reply" size="sm" className="ml-auto" onClick={() => setReplyTarget(channel.id, null)}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        {drafts.length > 0 && (
          <div className="scrollbar-thin flex gap-2 overflow-x-auto px-3 pt-3" aria-label="Pictures to send">
            {drafts.map((draft) => (
              <DraftTile key={draft.key} draft={draft} onRemove={() => remove(draft)} onRetry={() => retry(draft)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1 px-3 py-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={limits.acceptedTypes.join(',')}
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const input = event.currentTarget;
              attach(Array.from(input.files ?? []));
              input.value = '';
            }}
          />
          <IconButton label="Add pictures" size="sm" className="mb-1" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={20} />
          </IconButton>
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            maxLength={maxLength}
            placeholder={connected ? 'Message ' + target : 'Message ' + target + ' (sent when back online)'}
            aria-label={'Message ' + target}
            aria-autocomplete="list"
            aria-controls={mention ? MENTION_LIST_ID : undefined}
            aria-expanded={Boolean(mention)}
            aria-activedescendant={mention ? optionId(MENTION_LIST_ID, mention.active) : undefined}
            className="scrollbar-thin max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-sm text-text-bright placeholder:text-text-faint outline-none"
            onInput={(event) => {
              const node = event.target as HTMLTextAreaElement;
              setText(node.value);
              resize();
              refreshMention(node.value, node.selectionStart ?? node.value.length);
            }}
            onClick={(event) => {
              const node = event.currentTarget;
              refreshMention(node.value, node.selectionStart ?? node.value.length);
            }}
            onBlur={() => setMention(null)}
            onPaste={(event) => {
              const files = filesFromTransfer(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              attach(files);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="relative flex items-center pb-1">
            <IconButton label="Emoji" size="sm" onClick={() => setEmojiOpen((value) => !value)}>
              <Smile size={20} />
            </IconButton>
            {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
            <IconButton label={connected ? 'Send' : 'Send when back online'} size="sm" tone={sendable ? 'brand' : 'default'} disabled={!sendable} onClick={send}>
              <Send size={18} />
            </IconButton>
          </div>
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-brand-soft text-sm font-semibold text-text-bright animate-fade-in">
            Drop pictures to attach them
          </div>
        )}
      </div>
    </div>
  );
};
