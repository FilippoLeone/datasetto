import { Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { Notification } from '../models';
import * as UIActions from '../../store/ui/ui.actions';

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notificationCounter = 0;

  constructor(private store: Store) {}

  /**
   * Show a success notification
   */
  success(message: string, duration: number = 5000): void {
    this.show(message, 'success', duration);
  }

  /**
   * Show an error notification
   */
  error(message: string, duration: number = 5000): void {
    this.show(message, 'error', duration);
  }

  /**
   * Show an info notification
   */
  info(message: string, duration: number = 5000): void {
    this.show(message, 'info', duration);
  }

  /**
   * Show a warning notification
   */
  warning(message: string, duration: number = 5000): void {
    this.show(message, 'warning', duration);
  }

  /**
   * Show a notification
   */
  private show(message: string, type: Notification['type'], duration: number): void {
    const notification: Notification = {
      id: `notification-${Date.now()}-${this.notificationCounter++}`,
      type,
      message,
      duration,
    };

    this.store.dispatch(UIActions.showNotification({ notification }));

    // Auto-hide after duration
    if (duration > 0) {
      setTimeout(() => {
        this.store.dispatch(UIActions.hideNotification({ notificationId: notification.id }));
      }, duration);
    }
  }

  /**
   * Hide a notification
   */
  hide(notificationId: string): void {
    this.store.dispatch(UIActions.hideNotification({ notificationId }));
  }
}
