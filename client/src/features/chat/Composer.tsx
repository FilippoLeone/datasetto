import { useEffect, useRef, useState } from 'preact/hooks';
import { Send, Smile } from 'lucide-preact';
import { IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { EMOJIS } from '@/lib/text';
import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { serverConfig } from '@/services/ServerConfigService';
import { connectionStatus } from '@/state/session';
import { isMobile } from '@/state/ui';
import type { Channel } from '@/types/protocol';

const EmojiPicker = ({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label="Emoji" className="absolute right-0 bottom-full mb-2 grid w-72 grid-cols-8 gap-1 rounded-md bg-elevated p-2 shadow-pop animate-pop">
      {EMOJIS.map((emoji) => (
        <button key={emoji} type="button" className="rounded-sm p-1 text-xl hover:bg-hover" onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
};

export const Composer = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxLength = serverConfig.get()?.limits.maxMessageLength ?? 2000;
  const disabled = connectionStatus.value !== 'connected';

  useEffect(() => {
    setText('');
    if (!isMobile.value) textareaRef.current?.focus();
  }, [channel.id]);

  const resize = () => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 200) + 'px';
  };

  const send = () => {
    const value = text.trim();
    if (!value || disabled) return;
    api.sendMessage(value.slice(0, maxLength));
    sounds.play('messageSent', 0.2);
    setText('');
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
      <div className="relative flex items-end gap-1 rounded-lg bg-input px-3 py-1.5">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={disabled ? 'Reconnecting…' : 'Message #' + channel.name}
          aria-label={'Message #' + channel.name}
          className="scrollbar-thin max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-sm text-text-bright placeholder:text-text-faint outline-none"
          onInput={(event) => {
            setText((event.target as HTMLTextAreaElement).value);
            resize();
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
          <IconButton label="Send" size="sm" tone={text.trim() ? 'brand' : 'default'} disabled={!text.trim() || disabled} onClick={send}>
            <Send size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
};
