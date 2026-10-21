import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { setPendingMessages } from '@/state/chat';
import { account, isAuthenticated } from '@/state/session';
import { toast } from '@/state/ui';
import { createOutbox } from './outbox';

/**
 * The app's one outgoing chat queue (features/chat/outbox.ts) bound to the socket
 * and the chat store. The socket bindings flush it after every sign-in and hand it
 * the server's echoes; the composer and the message list use it directly.
 */
export const outbox = createOutbox({
  send: (message) => api.sendMessage(message.channelId, message.text, message.clientId, message.attachmentIds, message.replyToId),
  // A temporary password blocks everything but the password change on the server.
  canSend: () => socketClient.connected && isAuthenticated.value && !account.value?.mustChangePassword,
  onChange: setPendingMessages,
  // Changed or dropped while the server was already storing it: catch the stored copy up.
  editSent: (channelId, messageId, text) => void editChatMessage(channelId, messageId, text),
  deleteSent: (channelId, messageId) => api.deleteMessage(channelId, messageId),
});

export const sendChatMessage = (channelId: string, text: string, attachmentIds: string[] = [], replyToId: string | null = null): void => {
  outbox.enqueue(channelId, text, attachmentIds, replyToId);
};

/** Replace the text of one of our own messages. Resolves true when the server accepted it. */
export const editChatMessage = async (channelId: string, messageId: string, text: string): Promise<boolean> => {
  try {
    const ack = await api.editMessage(channelId, messageId, text);
    if (!ack.success) {
      toast.error(ack.error || 'The message could not be edited');
      return false;
    }
    return true;
  } catch {
    toast.error('The message could not be edited. Check your connection and try again.');
    return false;
  }
};
