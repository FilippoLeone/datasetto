/**
 * Keyboard navigation utilities for accessible UI components
 */

export interface KeyboardNavigationOptions {
  /** CSS selector for navigable items within the container */
  itemSelector: string;
  /** Whether navigation should wrap around at boundaries */
  wrap?: boolean;
  /** Callback when an item is activated (Enter/Space) */
  onActivate?: (item: HTMLElement, index: number) => void;
  /** Callback when focus changes */
  onFocusChange?: (item: HTMLElement, index: number) => void;
  /** Enable type-ahead search */
  typeAhead?: boolean;
  /** Orientation: vertical (up/down arrows) or horizontal (left/right) */
  orientation?: 'vertical' | 'horizontal' | 'both';
}

const DEFAULT_OPTIONS: Required<KeyboardNavigationOptions> = {
  itemSelector: '[role="option"], [role="menuitem"], [role="listitem"], .keyboard-nav-item',
  wrap: true,
  onActivate: () => {},
  onFocusChange: () => {},
  typeAhead: false,
  orientation: 'vertical',
};

/**
 * Enable keyboard navigation on a container element
 * Returns a cleanup function to remove event listeners
 */
export function enableKeyboardNavigation(
  container: HTMLElement,
  options: KeyboardNavigationOptions
): () => void {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let typeAheadBuffer = '';
  let typeAheadTimeout: number | null = null;

  const getItems = (): HTMLElement[] => {
    return Array.from(container.querySelectorAll<HTMLElement>(config.itemSelector));
  };

  const getCurrentIndex = (): number => {
    const items = getItems();
    const focused = document.activeElement as HTMLElement;
    return items.indexOf(focused);
  };

  const focusItem = (index: number): void => {
    const items = getItems();
    if (items.length === 0) return;

    let targetIndex = index;
    if (config.wrap) {
      targetIndex = ((index % items.length) + items.length) % items.length;
    } else {
      targetIndex = Math.max(0, Math.min(index, items.length - 1));
    }

    const item = items[targetIndex];
    if (item) {
      item.focus();
      config.onFocusChange(item, targetIndex);
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const items = getItems();
    if (items.length === 0) return;

    const currentIndex = getCurrentIndex();
    const isVertical = config.orientation === 'vertical' || config.orientation === 'both';
    const isHorizontal = config.orientation === 'horizontal' || config.orientation === 'both';

    switch (event.key) {
      case 'ArrowDown':
        if (isVertical) {
          event.preventDefault();
          focusItem(currentIndex + 1);
        }
        break;

      case 'ArrowUp':
        if (isVertical) {
          event.preventDefault();
          focusItem(currentIndex - 1);
        }
        break;

      case 'ArrowRight':
        if (isHorizontal) {
          event.preventDefault();
          focusItem(currentIndex + 1);
        }
        break;

      case 'ArrowLeft':
        if (isHorizontal) {
          event.preventDefault();
          focusItem(currentIndex - 1);
        }
        break;

      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;

      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;

      case 'Enter':
      case ' ':
        if (currentIndex >= 0) {
          event.preventDefault();
          config.onActivate(items[currentIndex], currentIndex);
        }
        break;

      default:
        // Type-ahead search
        if (config.typeAhead && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          handleTypeAhead(event.key, items);
        }
        break;
    }
  };

  const handleTypeAhead = (char: string, items: HTMLElement[]): void => {
    typeAheadBuffer += char.toLowerCase();

    if (typeAheadTimeout !== null) {
      clearTimeout(typeAheadTimeout);
    }

    typeAheadTimeout = window.setTimeout(() => {
      typeAheadBuffer = '';
    }, 500);

    // Find first item that starts with the buffer
    const matchIndex = items.findIndex(item => {
      const text = item.textContent?.trim().toLowerCase() ?? '';
      return text.startsWith(typeAheadBuffer);
    });

    if (matchIndex >= 0) {
      focusItem(matchIndex);
    }
  };

  // Make items focusable
  const items = getItems();
  items.forEach((item, index) => {
    if (!item.hasAttribute('tabindex')) {
      item.setAttribute('tabindex', index === 0 ? '0' : '-1');
    }
  });

  // Set ARIA attributes on container if not present
  if (!container.hasAttribute('role')) {
    container.setAttribute('role', 'listbox');
  }

  container.addEventListener('keydown', handleKeyDown);

  // Update tabindex on focus changes (roving tabindex pattern)
  const handleFocusIn = (event: FocusEvent): void => {
    const target = event.target as HTMLElement;
    const items = getItems();
    
    if (items.includes(target)) {
      items.forEach(item => {
        item.setAttribute('tabindex', item === target ? '0' : '-1');
      });
    }
  };

  container.addEventListener('focusin', handleFocusIn);

  // Cleanup function
  return () => {
    container.removeEventListener('keydown', handleKeyDown);
    container.removeEventListener('focusin', handleFocusIn);
    if (typeAheadTimeout !== null) {
      clearTimeout(typeAheadTimeout);
    }
  };
}

/**
 * Focus trap for modal dialogs
 * Keeps focus within the container when tabbing
 */
export function createFocusTrap(container: HTMLElement): () => void {
  const focusableSelector = 
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  const getFocusableElements = (): HTMLElement[] => {
    return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey) {
      // Shift+Tab: going backwards
      if (active === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      // Tab: going forwards
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  container.addEventListener('keydown', handleKeyDown);

  // Focus first element when trap is created
  const focusable = getFocusableElements();
  if (focusable.length > 0) {
    focusable[0].focus();
  }

  return () => {
    container.removeEventListener('keydown', handleKeyDown);
  };
}

/**
 * Announce a message to screen readers
 */
export function announceToScreenReader(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const announcer = document.createElement('div');
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', priority);
  announcer.setAttribute('aria-atomic', 'true');
  announcer.className = 'sr-only';
  announcer.style.cssText = `
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  `;

  document.body.appendChild(announcer);

  // Small delay to ensure screen reader picks it up
  setTimeout(() => {
    announcer.textContent = message;
  }, 100);

  // Clean up after announcement
  setTimeout(() => {
    announcer.remove();
  }, 1000);
}
