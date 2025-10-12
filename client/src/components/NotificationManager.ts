/**
 * Toast notification component
 */
import type { Notification, NotificationType } from '@/types';
import { generateId } from '@/utils';

export class NotificationManager {
  private container: HTMLElement;
  private notifications: Map<string, HTMLElement> = new Map();
  private desktopAPI: any = null;

  constructor() {
    this.container = this.createContainer();
    this.checkElectronEnvironment();
  }

  /**
   * Check if running in Electron and desktop API is available
   */
  private checkElectronEnvironment(): void {
    if (typeof window !== 'undefined' && (window as any).desktopAPI) {
      this.desktopAPI = (window as any).desktopAPI;
      console.log('[NotificationManager] Electron desktop API detected');
    }
  }

  /**
   * Create the notification container
   */
  private createContainer(): HTMLElement {
    const existing = document.querySelector('.toast-container');
    if (existing) return existing as HTMLElement;

    const container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
    return container;
  }

  /**
   * Show a notification
   */
  show(
    message: string,
    type: NotificationType = 'info',
    duration = 4000
  ): string {
    if (this.notifications.size > 0) {
      this.clear(true);
    }

    const id = generateId();
    const notification: Notification = { id, message, type, duration };
    
    const element = this.createNotificationElement(notification);
    this.notifications.set(id, element);
    this.container.appendChild(element);

    // Show native notification if in Electron desktop app
    this.showNativeNotification(message, type);

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => this.remove(id), duration);
    }

    return id;
  }

  /**
   * Show native OS notification via Electron
   */
  private showNativeNotification(message: string, type: NotificationType): void {
    if (!this.desktopAPI?.showNotification) {
      console.log('[NotificationManager] Desktop API not available, skipping native notification');
      return;
    }

    const title = this.getNotificationTitle(type);
    console.log('[NotificationManager] Sending native notification:', { title, message, type });
    
    this.desktopAPI.showNotification({
      title,
      body: message,
      type,
      silent: false
    }).then((result: any) => {
      console.log('[NotificationManager] Native notification result:', result);
    }).catch((err: Error) => {
      console.error('[NotificationManager] Failed to show native notification:', err);
    });
  }

  /**
   * Get notification title based on type
   */
  private getNotificationTitle(type: NotificationType): string {
    switch (type) {
      case 'error':
        return 'Datasetto - Error';
      case 'warning':
        return 'Datasetto - Warning';
      case 'success':
        return 'Datasetto - Success';
      default:
        return 'Datasetto';
    }
  }

  /**
   * Show info notification
   */
  info(message: string, duration?: number): string {
    return this.show(message, 'info', duration);
  }

  /**
   * Show success notification
   */
  success(message: string, duration?: number): string {
    return this.show(message, 'success', duration);
  }

  /**
   * Show warning notification
   */
  warning(message: string, duration?: number): string {
    return this.show(message, 'warning', duration);
  }

  /**
   * Show error notification
   */
  error(message: string, duration?: number): string {
    return this.show(message, 'error', duration);
  }

  /**
   * Remove a notification
   */
  remove(id: string, immediate = false): void {
    const element = this.notifications.get(id);
    if (!element) return;

    if (immediate) {
      element.remove();
      this.notifications.delete(id);
      return;
    }

    const handleAnimationEnd = () => {
      element.removeEventListener('animationend', handleAnimationEnd);
      element.remove();
      this.notifications.delete(id);
    };

    element.addEventListener('animationend', handleAnimationEnd);
    element.classList.add('removing');

    window.setTimeout(() => {
      handleAnimationEnd();
    }, 600);
  }

  /**
   * Create notification DOM element
   */
  private createNotificationElement(notification: Notification): HTMLElement {
    const toast = document.createElement('div');
    toast.className = `toast ${notification.type}`;
    toast.setAttribute('role', 'alert');

    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = notification.message;

    const closeButton = document.createElement('button');
    closeButton.className = 'close';
    closeButton.innerHTML = '×';
    closeButton.setAttribute('aria-label', 'Close notification');
    closeButton.onclick = () => this.remove(notification.id);

    toast.appendChild(message);
    toast.appendChild(closeButton);

    return toast;
  }

  /**
   * Clear all notifications
   */
  clear(immediate = false): void {
    for (const id of Array.from(this.notifications.keys())) {
      this.remove(id, immediate);
    }
  }
}
