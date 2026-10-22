import { io, type Socket } from 'socket.io-client';
import { createReconnectScheduler, type ReconnectScheduler, type ReconnectState } from './backoff';

type Handler = (...args: never[]) => void;

/**
 * Thin wrapper around socket.io-client. Reconnection is ours, not socket.io's:
 * exponential backoff with jitter capped at 30 s (services/socket/backoff.ts),
 * the server's "restarting, back in N s" notice as the first wait, an immediate
 * retry when the browser comes back online or the page is shown again, and a
 * "retry now" for the banner. Listeners registered before `connect()` are
 * attached once the socket exists.
 *
 * Emits while disconnected are dropped rather than buffered: everything that
 * matters is re-sent by the reconnect flow (session, channel, voice room,
 * queued chat), and stale signalling to sockets that no longer exist would only
 * produce errors.
 */
class SocketClient {
  private socket: Socket | null = null;
  private pending: Array<{ event: string; handler: Handler }> = [];
  private scheduler: ReconnectScheduler | null = null;
  private reconnectListeners = new Set<(state: ReconnectState) => void>();
  /** The last 16 ack round trips in ms (the Arcade's "chat first" guard, docs/arcade/platform.md §6.4). */
  private acks: number[] = [];
  private requestAt = 0;
  private ackListeners = new Set<(rttMs: number) => void>();

  connect(url: string): void {
    if (this.socket) return;
    const socket = io(url, {
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: false,
      timeout: 20000,
      autoConnect: true,
    });
    this.socket = socket;
    for (const { event, handler } of this.pending) socket.on(event, handler as never);
    this.pending = [];

    const scheduler = createReconnectScheduler({
      connect: () => {
        if (this.socket && !this.socket.connected) this.socket.connect();
      },
      onChange: (state) => this.reconnectListeners.forEach((listener) => listener(state)),
    });
    this.scheduler = scheduler;

    socket.on('connect', () => scheduler.connected());
    socket.on('disconnect', (reason) => {
      // Closed by us (sign-out): no reconnect.
      if (reason === 'io client disconnect') return;
      scheduler.schedule();
    });
    socket.on('connect_error', () => scheduler.schedule());
    socket.on('server:restarting', (notice: { expectedWaitMs?: number }) => {
      if (typeof notice?.expectedWaitMs === 'number') scheduler.expectBackIn(notice.expectedWaitMs);
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.retryNow());
      window.addEventListener('offline', () => scheduler.offline());
      // Timers crawl in background tabs: when the page is shown again, do not wait for the next tick.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.connected && scheduler.state.attempt > 0) this.retryNow();
      });
      if (navigator.onLine === false) scheduler.offline();
    }
  }

  get id(): string | null {
    return this.socket?.id ?? null;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Attempts since the drop, when the next one fires, and why we wait. */
  get reconnectState(): ReconnectState {
    return this.scheduler?.state ?? { attempt: 0, nextAt: null, waitingFor: null };
  }

  /** Try to reconnect right now (the banner's button, the `online` event). */
  retryNow(): void {
    if (!this.socket || this.socket.connected) return;
    this.scheduler?.retryNow();
  }

  onReconnectState(listener: (state: ReconnectState) => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  emit(event: string, payload?: unknown): void {
    if (!this.socket?.connected) return;
    if (payload === undefined) this.socket.emit(event);
    else this.socket.emit(event, payload);
  }

  /** Emit with an acknowledgement callback; rejects on timeout or while disconnected. */
  request<T>(event: string, payload?: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const sentAt = performance.now();
      this.requestAt = sentAt;
      this.socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: T) => {
        // The only error here is the timeout: count it as a round trip of timeoutMs.
        this.recordAck(error ? timeoutMs : performance.now() - sentAt);
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  private recordAck(ms: number): void {
    this.acks.push(ms);
    if (this.acks.length > 16) this.acks.shift();
    this.ackListeners.forEach((listener) => listener(ms));
  }

  /** Median ack round trip of the last 16 requests in ms; 0 before the first. */
  ackRtt(): number {
    const sorted = [...this.acks].sort((a, b) => a - b);
    return sorted.length ? (sorted[sorted.length >> 1] as number) : 0;
  }

  /** performance.now() of the last request(); 0 before the first. */
  lastRequestAt(): number {
    return this.requestAt;
  }

  /** Every ack's round trip in ms (a timed-out request reports its timeout). */
  onAck(listener: (rttMs: number) => void): () => void {
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
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

  /** Manager-level events of socket.io (rarely needed: reconnection is handled here). */
  onManager(event: string, handler: (...args: unknown[]) => void): () => void {
    this.socket?.io.on(event as never, handler as never);
    return () => this.socket?.io.off(event as never, handler as never);
  }

  disconnect(): void {
    this.scheduler?.stop();
    this.socket?.disconnect();
  }
}

export const socketClient = new SocketClient();
