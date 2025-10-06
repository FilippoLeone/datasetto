/**
 * Animation Controller
 * Provides Discord-like animations for UI elements
 */

export type AnimationType = 
  | 'fadeIn'
  | 'fadeOut'
  | 'slideInLeft'
  | 'slideInRight'
  | 'slideInUp'
  | 'slideInDown'
  | 'scaleIn'
  | 'scaleOut'
  | 'bounce'
  | 'shake'
  | 'pulse';

export class AnimationController {
  /**
   * Animate an element with a specific animation
   */
  public animate(
    element: HTMLElement,
    animation: AnimationType,
    duration: number = 300,
    onComplete?: () => void
  ): void {
    // Remove any existing animation classes
    element.classList.remove(...this.getAllAnimationClasses());

    // Add the new animation class
    const animationClass = `anim-${animation}`;
    element.classList.add(animationClass);

    // Set custom duration if provided
    if (duration !== 300) {
      element.style.animationDuration = `${duration}ms`;
    }

    // Handle completion
    const handleAnimationEnd = () => {
      element.classList.remove(animationClass);
      element.style.animationDuration = '';
      element.removeEventListener('animationend', handleAnimationEnd);
      if (onComplete) onComplete();
    };

    element.addEventListener('animationend', handleAnimationEnd);
  }

  /**
   * Fade in an element
   */
  public fadeIn(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    element.style.opacity = '0';
    element.style.display = '';
    requestAnimationFrame(() => {
      this.animate(element, 'fadeIn', duration, () => {
        element.style.opacity = '';
        if (onComplete) onComplete();
      });
    });
  }

  /**
   * Fade out an element
   */
  public fadeOut(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    this.animate(element, 'fadeOut', duration, () => {
      element.style.display = 'none';
      if (onComplete) onComplete();
    });
  }

  /**
   * Slide element in from direction
   */
  public slideIn(
    element: HTMLElement,
    direction: 'left' | 'right' | 'up' | 'down',
    duration?: number,
    onComplete?: () => void
  ): void {
    const animationMap: Record<typeof direction, AnimationType> = {
      left: 'slideInLeft',
      right: 'slideInRight',
      up: 'slideInUp',
      down: 'slideInDown'
    };

    element.style.display = '';
    this.animate(element, animationMap[direction], duration, onComplete);
  }

  /**
   * Scale in (zoom in) an element
   */
  public scaleIn(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    element.style.display = '';
    this.animate(element, 'scaleIn', duration, onComplete);
  }

  /**
   * Scale out (zoom out) an element
   */
  public scaleOut(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    this.animate(element, 'scaleOut', duration, () => {
      element.style.display = 'none';
      if (onComplete) onComplete();
    });
  }

  /**
   * Bounce animation
   */
  public bounce(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    this.animate(element, 'bounce', duration, onComplete);
  }

  /**
   * Shake animation (for errors)
   */
  public shake(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    this.animate(element, 'shake', duration || 500, onComplete);
  }

  /**
   * Pulse animation
   */
  public pulse(element: HTMLElement, duration?: number, onComplete?: () => void): void {
    this.animate(element, 'pulse', duration, onComplete);
  }

  /**
   * Animate message appearance (Discord style)
   */
  public animateMessage(messageElement: HTMLElement): void {
    messageElement.style.opacity = '0';
    messageElement.style.transform = 'translateY(10px)';
    
    requestAnimationFrame(() => {
      messageElement.style.transition = 'opacity 200ms ease-out, transform 200ms ease-out';
      messageElement.style.opacity = '1';
      messageElement.style.transform = 'translateY(0)';
      
      setTimeout(() => {
        messageElement.style.transition = '';
      }, 200);
    });
  }

  /**
   * Animate channel switch
   */
  public animateChannelSwitch(contentElement: HTMLElement, onComplete?: () => void): void {
    // Fade out current content
    contentElement.style.transition = 'opacity 150ms ease-out';
    contentElement.style.opacity = '0';

    setTimeout(() => {
      // Execute callback (like switching content)
      if (onComplete) onComplete();

      // Fade in new content
      requestAnimationFrame(() => {
        contentElement.style.opacity = '1';
        setTimeout(() => {
          contentElement.style.transition = '';
        }, 150);
      });
    }, 150);
  }

  /**
   * Animate modal opening
   */
  public openModal(modalElement: HTMLElement, onComplete?: () => void): void {
    modalElement.style.display = 'flex';
    modalElement.style.opacity = '0';
    
    const modalCard = modalElement.querySelector('.modal-card') as HTMLElement;
    if (modalCard) {
      modalCard.style.transform = 'scale(0.9) translateY(20px)';
    }

    requestAnimationFrame(() => {
      modalElement.style.transition = 'opacity 200ms ease-out';
      modalElement.style.opacity = '1';

      if (modalCard) {
        modalCard.style.transition = 'transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1)';
        modalCard.style.transform = 'scale(1) translateY(0)';
      }

      setTimeout(() => {
        modalElement.style.transition = '';
        if (modalCard) modalCard.style.transition = '';
        if (onComplete) onComplete();
      }, 300);
    });
  }

  /**
   * Animate modal closing
   */
  public closeModal(modalElement: HTMLElement, onComplete?: () => void): void {
    const modalCard = modalElement.querySelector('.modal-card') as HTMLElement;
    
    modalElement.style.transition = 'opacity 150ms ease-out';
    modalElement.style.opacity = '0';

    if (modalCard) {
      modalCard.style.transition = 'transform 150ms ease-out';
      modalCard.style.transform = 'scale(0.9) translateY(20px)';
    }

    setTimeout(() => {
      modalElement.style.display = 'none';
      modalElement.style.transition = '';
      if (modalCard) {
        modalCard.style.transition = '';
        modalCard.style.transform = '';
      }
      if (onComplete) onComplete();
    }, 150);
  }

  /**
   * Animate notification toast
   */
  public showToast(toastElement: HTMLElement, duration: number = 3000): void {
    toastElement.style.display = 'block';
    toastElement.style.opacity = '0';
    toastElement.style.transform = 'translateX(100%)';
    
    requestAnimationFrame(() => {
      toastElement.style.transition = 'opacity 300ms ease-out, transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1)';
      toastElement.style.opacity = '1';
      toastElement.style.transform = 'translateX(0)';

      setTimeout(() => {
        toastElement.style.transition = 'opacity 300ms ease-out, transform 300ms ease-out';
        toastElement.style.opacity = '0';
        toastElement.style.transform = 'translateX(100%)';

        setTimeout(() => {
          toastElement.style.display = 'none';
          toastElement.style.transition = '';
        }, 300);
      }, duration);
    });
  }

  /**
   * Animate user list update
   */
  public animateListItem(element: HTMLElement, isNew: boolean = true): void {
    if (isNew) {
      element.style.opacity = '0';
      element.style.transform = 'translateX(-10px)';
      
      requestAnimationFrame(() => {
        element.style.transition = 'opacity 200ms ease-out, transform 200ms ease-out';
        element.style.opacity = '1';
        element.style.transform = 'translateX(0)';
        
        setTimeout(() => {
          element.style.transition = '';
        }, 200);
      });
    }
  }

  /**
   * Highlight element temporarily
   */
  public highlight(element: HTMLElement, color: string = 'rgba(169, 112, 255, 0.3)'): void {
    const originalBackground = element.style.backgroundColor;
    element.style.transition = 'background-color 200ms ease-out';
    element.style.backgroundColor = color;

    setTimeout(() => {
      element.style.backgroundColor = originalBackground;
      setTimeout(() => {
        element.style.transition = '';
      }, 200);
    }, 600);
  }

  /**
   * Get all animation class names
   */
  private getAllAnimationClasses(): string[] {
    return [
      'anim-fadeIn', 'anim-fadeOut',
      'anim-slideInLeft', 'anim-slideInRight', 'anim-slideInUp', 'anim-slideInDown',
      'anim-scaleIn', 'anim-scaleOut',
      'anim-bounce', 'anim-shake', 'anim-pulse'
    ];
  }
}
