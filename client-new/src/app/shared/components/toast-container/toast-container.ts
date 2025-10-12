import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { Observable } from 'rxjs';
import { Notification } from '../../../core/models';
import { selectNotifications } from '../../../store/ui/ui.selectors';
import * as UIActions from '../../../store/ui/ui.actions';
import { Toast } from '../toast/toast';

@Component({
  selector: 'app-toast-container',
  imports: [CommonModule, Toast],
  templateUrl: './toast-container.html',
  styleUrl: './toast-container.css'
})
export class ToastContainer implements OnInit {
  notifications$: Observable<Notification[]>;

  constructor(private store: Store) {
    this.notifications$ = this.store.select(selectNotifications);
  }

  ngOnInit(): void {}

  onDismiss(notificationId: string): void {
    this.store.dispatch(UIActions.hideNotification({ notificationId }));
  }
}
