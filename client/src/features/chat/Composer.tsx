import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, ImagePlus, Send, Smile, X } from 'lucide-preact';
import { IconButton } from '@/components';
import { addFiles, attachmentIds, canSend, filesFromTransfer, removeDraft, transferHasFiles, updateDraft, type AttachmentDraft } from '@/lib/attachments';
import { cn } from '@/lib/cn';
import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { serverConfig } from '@/services/ServerConfigService';
import { uploadImage, type UploadHandle } from '@/services/uploads';
import { channelLabel } from '@/state/channels';
import { connectionStatus } from '@/state/session';
import { isMobile, toast } from '@/state/ui';
import type { Channel } from '@/types/protocol';
import { EmojiPicker } from './EmojiPicker';

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

export const Composer = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploads = useRef(new Map<string, UploadHandle>());
  const dragDepth = useRef(0);
  const maxLength = serverConfig.get()?.limits.maxMessageLength ?? 2000;
  const limits = serverConfig.uploadLimits();
  const disabled = connectionStatus.value !== 'connected';
  const target = (channel.type === 'dm' ? '@' : '#') + channelLabel(channel);
  const sendable = canSend(text, drafts) && !disabled;

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
    discardAll();
    if (!isMobile.value) textareaRef.current?.focus();
    return discardAll;
  }, [channel.id]);

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
    if (files.length === 0 || disabled) return;
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
    api.sendMessage(value, attachmentIds(drafts));
    sounds.play('messageSent', 0.2);
    setText('');
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
          <IconButton label="Add pictures" size="sm" className="mb-1" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={20} />
          </IconButton>
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            maxLength={maxLength}
            disabled={disabled}
            placeholder={disabled ? 'Reconnecting…' : 'Message ' + target}
            aria-label={'Message ' + target}
            className="scrollbar-thin max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-sm text-text-bright placeholder:text-text-faint outline-none"
            onInput={(event) => {
              setText((event.target as HTMLTextAreaElement).value);
              resize();
            }}
            onPaste={(event) => {
              const files = filesFromTransfer(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              attach(files);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !isMobile.value) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="relative flex items-center pb-1">
            <IconButton label="Emoji" size="sm" onClick={() => setEmojiOpen((value) => !value)}>
              <Smile size={20} />
            </IconButton>
            {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
            <IconButton label="Send" size="sm" tone={sendable ? 'brand' : 'default'} disabled={!sendable} onClick={send}>
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
