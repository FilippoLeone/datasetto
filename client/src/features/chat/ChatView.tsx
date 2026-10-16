import { MessageList } from './MessageList';
import { Composer } from './Composer';
import type { Channel } from '@/types/protocol';

/** Text channel: scrolling history plus the composer. Also used as the chat dock on stream pages. */
export const ChatView = ({ channel, compact = false }: { channel: Channel; compact?: boolean }) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <MessageList channel={channel} compact={compact} />
    <Composer channel={channel} compact={compact} />
  </div>
);
