import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { setPendingMessages } from '@/state/chat';
import { account, isAuthenticated } from '@/state/session';
import { createOutbox } from './outbox';

/**
 * The app's one outgoing chat queue (features/chat/outbox.ts) bound to the socket
 * and the chat store. The socket bindings flush it after every sign-in and hand it
 * the server's echoes; the composer and the message list use it directly.
 */
export const outbox = createOutbox({
  send: (message) => api.sendMessage(message.channelId, message.text, message.clientId),
  // A temporary password blocks everything but the password change on the server.
  canSend: () => socketClient.connected && isAuthenticated.value && !account.value?.mustChangePassword,
  onChange: setPendingMessages,
});

export const sendChatMessage = (channelId: string, text: string): void => {
  outbox.enqueue(channelId, text);
};
