/**
 * Spinner Component
 * Loading spinner with different sizes
 */

export type SpinnerSize = 'small' | 'medium' | 'large';
export type SpinnerVariant = 'primary' | 'white' | 'current';

export interface SpinnerOptions {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  className?: string;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  small: 'w-4 h-4 border-2',
  medium: 'w-8 h-8 border-3',
  large: 'w-12 h-12 border-4'
};

const VARIANT_CLASSES: Record<SpinnerVariant, string> = {
  primary: 'border-white/10 border-t-brand-primary',
  white: 'border-white/20 border-t-white',
  current: 'border-current/20 border-t-current'
};

/**
 * Create a loading spinner
 */
export function createSpinner(options: SpinnerOptions = {}): HTMLElement {
  const { size = 'medium', variant = 'primary', className = '' } = options;

  const spinner = document.createElement('div');
  spinner.className = `rounded-full animate-spin ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`.trim();
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-label', 'Loading');

  return spinner;
}

/**
 * Create a spinner with text
 */
export function createSpinnerWithText(
  text: string = 'Loading...',
  options: SpinnerOptions = {}
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'flex flex-col items-center justify-center gap-3';

  const spinner = createSpinner(options);
  const textElement = document.createElement('p');
  textElement.className = 'text-text-muted text-sm font-medium';
  textElement.textContent = text;

  container.appendChild(spinner);
  container.appendChild(textElement);

  return container;
}

/**
 * Create an inline spinner (for use in buttons, etc.)
 */
export function createInlineSpinner(size: SpinnerSize = 'small'): HTMLElement {
  const spinner = createSpinner({ size, variant: 'current' });
  spinner.classList.add('inline-block');
  return spinner;
}
