/**
 * Connection status indicator component
 * Shows real-time connection state to the user
 */

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'failed';

interface ConnectionStatusOptions {
  onRetry?: () => void;
}

export class ConnectionStatusIndicator {
  private container: HTMLElement | null = null;
  private state: ConnectionState = 'connecting';
  private options: ConnectionStatusOptions;
  private retryCount = 0;
  private maxRetries = 5;
  private hideTimeout: number | null = null;
  private autoHideDelay = 3000;

  constructor(options: ConnectionStatusOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize and mount the indicator
   */
  mount(): void {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.className = 'connection-status-indicator';
    this.container.setAttribute('role', 'status');
    this.container.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.container);

    this.render();
  }

  /**
   * Update the connection state
   */
  setState(state: ConnectionState, retryCount?: number): void {
    this.state = state;
    if (typeof retryCount === 'number') {
      this.retryCount = retryCount;
    }

    this.render();

    // Auto-hide when connected after a delay
    if (state === 'connected') {
      this.scheduleHide();
    } else {
      this.cancelHide();
      this.show();
    }
  }

  /**
   * Show the indicator
   */
  show(): void {
    if (this.container) {
      this.container.classList.add('visible');
    }
  }

  /**
   * Hide the indicator
   */
  hide(): void {
    if (this.container) {
      this.container.classList.remove('visible');
    }
  }

  /**
   * Schedule auto-hide
   */
  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimeout = window.setTimeout(() => {
      this.hide();
    }, this.autoHideDelay);
  }

  /**
   * Cancel scheduled auto-hide
   */
  private cancelHide(): void {
    if (this.hideTimeout !== null) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  /**
   * Render the indicator based on current state
   */
  private render(): void {
    if (!this.container) return;

    const { icon, message, showRetry, className } = this.getStateConfig();

    this.container.className = `connection-status-indicator ${className}`;
    
    this.container.innerHTML = `
      <span class="connection-status-icon" aria-hidden="true">${icon}</span>
      <span class="connection-status-message">${message}</span>
      ${showRetry ? `<button class="connection-status-retry" type="button" aria-label="Retry connection">Retry</button>` : ''}
    `;

    if (showRetry) {
      const retryBtn = this.container.querySelector('.connection-status-retry');
      retryBtn?.addEventListener('click', () => {
        this.options.onRetry?.();
      });
    }
  }

  /**
   * Get configuration based on current state
   */
  private getStateConfig(): { icon: string; message: string; showRetry: boolean; className: string } {
    switch (this.state) {
      case 'connected':
        return {
          icon: '✓',
          message: 'Connected',
          showRetry: false,
          className: 'status-connected visible',
        };
      case 'connecting':
        return {
          icon: '◐',
          message: 'Connecting...',
          showRetry: false,
          className: 'status-connecting visible',
        };
      case 'reconnecting':
        return {
          icon: '↻',
          message: `Reconnecting${this.retryCount > 0 ? ` (${this.retryCount}/${this.maxRetries})` : '...'}`,
          showRetry: false,
          className: 'status-reconnecting visible',
        };
      case 'disconnected':
        return {
          icon: '⚠',
          message: 'Disconnected',
          showRetry: true,
          className: 'status-disconnected visible',
        };
      case 'failed':
        return {
          icon: '✕',
          message: 'Connection failed',
          showRetry: true,
          className: 'status-failed visible',
        };
      default:
        return {
          icon: '?',
          message: 'Unknown',
          showRetry: false,
          className: '',
        };
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.cancelHide();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
