import { io, type Socket } from 'socket.io-client';

type Handler = (...args: never[]) => void;

/**
 * Thin wrapper around socket.io-client. Reconnects forever with backoff;
 * listeners registered before `connect()` are attached once the socket exists.
 */
class SocketClient {
  private socket: Socket | null = null;
  private pending: Array<{ event: string; handler: Handler }> = [];

  connect(url: string): void {
    if (this.socket) return;
    this.socket = io(url, {
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.5,
      timeout: 20000,
      autoConnect: true,
    });
    for (const { event, handler } of this.pending) this.socket.on(event, handler as never);
    this.pending = [];
    // socket.io does not reconnect by itself after a server-side disconnect (kick, ban,
    // account disabled, restart). Reconnect anyway so the user lands on the sign-in form.
    this.socket.on('disconnect', (reason) => {
      if (reason !== 'io server disconnect') return;
      window.setTimeout(() => {
        if (this.socket && !this.socket.connected) this.socket.connect();
      }, 1500);
    });
  }

  get id(): string | null {
    return this.socket?.id ?? null;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  emit(event: string, payload?: unknown): void {
    if (!this.socket) return;
    if (payload === undefined) this.socket.emit(event);
    else this.socket.emit(event, payload);
  }

  /** Emit with an acknowledgement callback; rejects on timeout. */
  request<T>(event: string, payload?: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected'));
        return;
      }
      this.socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: T) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  on<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    const wrapped = handler as Handler;
    if (this.socket) this.socket.on(event, wrapped as never);
    else this.pending.push({ event, handler: wrapped });
    return () => {
      this.socket?.off(event, wrapped as never);
      this.pending = this.pending.filter((entry) => entry.handler !== wrapped);
    };
  }

  /** Manager-level events: 'reconnect_attempt', 'reconnect'. */
  onManager(event: string, handler: (...args: unknown[]) => void): () => void {
    this.socket?.io.on(event as never, handler as never);
    return () => this.socket?.io.off(event as never, handler as never);
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}

export const socketClient = new SocketClient();
