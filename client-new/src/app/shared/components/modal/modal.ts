import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-modal',
  imports: [CommonModule],
  templateUrl: './modal.html',
  styleUrl: './modal.css'
})
export class Modal implements OnInit, OnDestroy {
  @Input() isOpen = false;
  @Input() title = '';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() closeOnBackdrop = true;
  @Output() close = new EventEmitter<void>();

  ngOnInit(): void {
    if (this.isOpen) {
      this.lockBody();
    }
  }

  ngOnDestroy(): void {
    this.unlockBody();
  }

  onBackdropClick(): void {
    if (this.closeOnBackdrop) {
      this.closeModal();
    }
  }

  closeModal(): void {
    this.unlockBody();
    this.close.emit();
  }

  private lockBody(): void {
    document.body.style.overflow = 'hidden';
  }

  private unlockBody(): void {
    document.body.style.overflow = '';
  }

  onModalClick(event: Event): void {
    // Prevent click from bubbling to backdrop
    event.stopPropagation();
  }
}
