/**
 * Divider Component
 * Horizontal or vertical dividers with optional text
 */

export type DividerOrientation = 'horizontal' | 'vertical';

export interface DividerOptions {
  orientation?: DividerOrientation;
  text?: string;
  className?: string;
}

/**
 * Create a divider element
 */
export function createDivider(options: DividerOptions = {}): HTMLElement {
  const { orientation = 'horizontal', text, className = '' } = options;

  const divider = document.createElement('div');

  if (orientation === 'vertical') {
    divider.className = `w-px h-full bg-white/10 ${className}`.trim();
  } else {
    // Horizontal
    if (text) {
      divider.className = `flex items-center my-4 text-text-muted text-xs font-semibold uppercase tracking-wide ${className}`.trim();
      divider.innerHTML = `
        <div class="flex-1 h-px bg-white/10"></div>
        <span class="px-3">${text}</span>
        <div class="flex-1 h-px bg-white/10"></div>
      `;
    } else {
      divider.className = `w-full h-px bg-white/10 my-4 ${className}`.trim();
    }
  }

  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', orientation);

  return divider;
}

/**
 * Create a section divider with title
 */
export function createSectionDivider(title: string, className?: string): HTMLElement {
  return createDivider({ text: title, className });
}
