/**
 * Tooltip Component
 * Hoverable tooltips for UI elements
 */

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipOptions {
  position?: TooltipPosition;
  delay?: number; // milliseconds before showing
  className?: string;
}

const POSITION_CLASSES: Record<TooltipPosition, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 -translate-y-2 mb-1',
  bottom: 'top-full left-1/2 -translate-x-1/2 translate-y-2 mt-1',
  left: 'right-full top-1/2 -translate-y-1/2 -translate-x-2 mr-1',
  right: 'left-full top-1/2 -translate-y-1/2 translate-x-2 ml-1'
};

/**
 * Create a tooltip element
 */
export function createTooltip(
  text: string,
  options: TooltipOptions = {}
): HTMLElement {
  const { position = 'top', className = '' } = options;

  const tooltip = document.createElement('div');
  tooltip.className = `absolute ${POSITION_CLASSES[position]} px-3 py-2 bg-bg-floating text-text-normal text-xs font-semibold rounded-md whitespace-nowrap pointer-events-none z-tooltip shadow-md border border-white/10 opacity-0 transition-all duration-150 ${className}`.trim();
  tooltip.textContent = text;
  tooltip.setAttribute('role', 'tooltip');

  return tooltip;
}

/**
 * Add a tooltip to an element
 */
export function addTooltip(
  element: HTMLElement,
  text: string,
  options: TooltipOptions = {}
): () => void {
  const { delay = 300 } = options;
  
  const tooltip = createTooltip(text, options);
  let timeoutId: number | null = null;
  
  if (!element.classList.contains('relative')) {
    element.classList.add('relative');
  }

  const showTooltip = () => {
    timeoutId = window.setTimeout(() => {
      element.appendChild(tooltip);
      requestAnimationFrame(() => {
        tooltip.classList.remove('opacity-0');
        tooltip.classList.add('opacity-100');
        
        // Adjust position classes for animation
        const position = options.position || 'top';
        if (position === 'top') {
          tooltip.classList.remove('-translate-y-2');
          tooltip.classList.add('-translate-y-3');
        } else if (position === 'bottom') {
          tooltip.classList.remove('translate-y-2');
          tooltip.classList.add('translate-y-3');
        } else if (position === 'left') {
          tooltip.classList.remove('-translate-x-2');
          tooltip.classList.add('-translate-x-3');
        } else if (position === 'right') {
          tooltip.classList.remove('translate-x-2');
          tooltip.classList.add('translate-x-3');
        }
      });
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    
    tooltip.classList.remove('opacity-100');
    tooltip.classList.add('opacity-0');
    
    // Reset position classes
    const position = options.position || 'top';
    if (position === 'top') {
      tooltip.classList.remove('-translate-y-3');
      tooltip.classList.add('-translate-y-2');
    } else if (position === 'bottom') {
      tooltip.classList.remove('translate-y-3');
      tooltip.classList.add('translate-y-2');
    } else if (position === 'left') {
      tooltip.classList.remove('-translate-x-3');
      tooltip.classList.add('-translate-x-2');
    } else if (position === 'right') {
      tooltip.classList.remove('translate-x-3');
      tooltip.classList.add('translate-x-2');
    }
    
    setTimeout(() => {
      if (tooltip.parentElement) {
        tooltip.remove();
      }
    }, 150);
  };

  element.addEventListener('mouseenter', showTooltip);
  element.addEventListener('mouseleave', hideTooltip);
  element.addEventListener('focus', showTooltip);
  element.addEventListener('blur', hideTooltip);

  // Return cleanup function
  return () => {
    element.removeEventListener('mouseenter', showTooltip);
    element.removeEventListener('mouseleave', hideTooltip);
    element.removeEventListener('focus', showTooltip);
    element.removeEventListener('blur', hideTooltip);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (tooltip.parentElement) {
      tooltip.remove();
    }
  };
}
