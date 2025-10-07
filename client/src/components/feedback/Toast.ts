/**
 * Toast Notification Component
 * Temporary notification messages
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  duration?: number; // milliseconds, 0 = no auto-dismiss
  dismissible?: boolean;
  onDismiss?: () => void;
}

const TYPE_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠'
};

const TYPE_BG_COLORS: Record<ToastType, string> = {
  success: 'bg-success/10',
  error: 'bg-danger/10',
  info: 'bg-brand-primary/10',
  warning: 'bg-warning/10'
};

const TYPE_TEXT_COLORS: Record<ToastType, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-brand-primary',
  warning: 'text-warning'
};

/**
 * Create a toast notification element
 */
export function createToast(
  message: string,
  type: ToastType = 'info',
  options: ToastOptions = {}
): HTMLElement {
  const { duration = 5000, dismissible = true, onDismiss } = options;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const content = document.createElement('div');
  content.className = 'flex items-center gap-3 w-full';

  // Icon
  const icon = document.createElement('div');
  icon.className = `w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold flex-shrink-0 ${TYPE_BG_COLORS[type]} ${TYPE_TEXT_COLORS[type]}`;
  icon.textContent = TYPE_ICONS[type];

  // Message
  const text = document.createElement('div');
  text.className = 'flex-1 text-text-normal text-base font-medium';
  text.textContent = message;

  content.appendChild(icon);
  content.appendChild(text);

  // Close button
  if (dismissible) {
    const closeButton = document.createElement('button');
    closeButton.className = 'close flex-shrink-0 w-6 h-6 rounded flex items-center justify-center hover:bg-white/10 transition-fast';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Dismiss');
    closeButton.addEventListener('click', () => {
      dismissToast(toast);
      if (onDismiss) onDismiss();
    });
    content.appendChild(closeButton);
  }

  toast.appendChild(content);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => {
      dismissToast(toast);
      if (onDismiss) onDismiss();
    }, duration);
  }

  return toast;
}

/**
 * Dismiss a toast with animation
 */
export function dismissToast(toast: HTMLElement): void {
  toast.classList.add('anim-fadeOut');
  setTimeout(() => {
    toast.remove();
  }, 300);
}

/**
 * Toast Manager - handles displaying toasts in a container
 */
export class ToastManager {
  private container: HTMLElement | null = null;

  private ensureContainer(): HTMLElement {
    if (!this.container || !document.body.contains(this.container)) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
    return this.container;
  }

  show(message: string, type: ToastType = 'info', options?: ToastOptions): void {
    const container = this.ensureContainer();
    const toast = createToast(message, type, options);
    container.appendChild(toast);
  }

  success(message: string, options?: ToastOptions): void {
    this.show(message, 'success', options);
  }

  error(message: string, options?: ToastOptions): void {
    this.show(message, 'error', options);
  }

  info(message: string, options?: ToastOptions): void {
    this.show(message, 'info', options);
  }

  warning(message: string, options?: ToastOptions): void {
    this.show(message, 'warning', options);
  }

  clear(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// Export singleton instance
export const toast = new ToastManager();
