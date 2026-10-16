import { useEffect, useRef, useState } from 'preact/hooks';
import { Send, Smile } from 'lucide-preact';
import { IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { sounds } from '@/services/sounds';
import { serverConfig } from '@/services/ServerConfigService';
import { channelLabel } from '@/state/channels';
import { connectionStatus } from '@/state/session';
import { isMobile } from '@/state/ui';
import type { Channel } from '@/types/protocol';
import { EmojiPicker } from './EmojiPicker';
import { sendChatMessage } from './outboxService';

export const Composer = ({ channel, compact }: { channel: Channel; compact?: boolean }) => {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxLength = serverConfig.get()?.limits.maxMessageLength ?? 2000;
  // Typing never waits for the connection: a message written while reconnecting is queued
  // (shown as "sending" in the list) and goes out as soon as the socket is back.
  const connected = connectionStatus.value === 'connected';
  const target = (channel.type === 'dm' ? '@' : '#') + channelLabel(channel);

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
    if (!value) return;
    sendChatMessage(channel.id, value.slice(0, maxLength));
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
          placeholder={connected ? 'Message ' + target : 'Message ' + target + ' (sent when back online)'}
          aria-label={'Message ' + target}
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
          <IconButton label={connected ? 'Send' : 'Send when back online'} size="sm" tone={text.trim() ? 'brand' : 'default'} disabled={!text.trim()} onClick={send}>
            <Send size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
};
