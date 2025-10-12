import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Notification } from '../../../core/models';

@Component({
  selector: 'app-toast',
  imports: [CommonModule],
  templateUrl: './toast.html',
  styleUrl: './toast.css'
})
export class Toast {
  @Input() notification!: Notification;
  @Output() dismiss = new EventEmitter<string>();

  get typeIcon(): string {
    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ',
      warning: '⚠'
    };
    return icons[this.notification.type];
  }

  get typeBgColor(): string {
    const colors = {
      success: 'bg-success/10',
      error: 'bg-danger/10',
      info: 'bg-brand-primary/10',
      warning: 'bg-warning/10'
    };
    return colors[this.notification.type];
  }

  get typeTextColor(): string {
    const colors = {
      success: 'text-success',
      error: 'text-danger',
      info: 'text-brand-primary',
      warning: 'text-warning'
    };
    return colors[this.notification.type];
  }

  onDismiss(): void {
    this.dismiss.emit(this.notification.id);
  }
}
