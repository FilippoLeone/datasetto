/**
 * Button Component
 * Reusable button with variants and sizes
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  onClick?: (event: MouseEvent) => void;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  fullWidth?: boolean;
}

/**
 * Create a styled button element with Tailwind CSS
 */
export function createButton(
  text: string,
  options: ButtonOptions = {}
): HTMLButtonElement {
  const {
    variant = 'primary',
    size = 'medium',
    icon,
    onClick,
    className = '',
    disabled = false,
    type = 'button',
    fullWidth = false
  } = options;

  const button = document.createElement('button');
  button.type = type;
  
  // Base classes
  const baseClasses = 'inline-flex items-center justify-center gap-2 font-semibold rounded-md transition-fast disabled:opacity-50 disabled:cursor-not-allowed';
  
  // Variant classes
  const variantClasses: Record<ButtonVariant, string> = {
    primary: 'bg-brand-primary text-white hover:bg-brand-hover active:bg-brand-active shadow-sm hover:shadow',
    secondary: 'bg-bg-tertiary text-text-normal border border-white/10 hover:bg-bg-floating hover:border-white/20',
    danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/80 shadow-sm hover:shadow',
    success: 'bg-success text-white hover:bg-success/90 active:bg-success/80 shadow-sm hover:shadow',
    ghost: 'text-text-normal hover:bg-bg-tertiary hover:text-text-hover'
  };
  
  // Size classes
  const sizeClasses: Record<ButtonSize, string> = {
    small: 'px-3 py-1.5 text-sm',
    medium: 'px-4 py-2 text-base',
    large: 'px-6 py-3 text-lg'
  };

  const widthClass = fullWidth ? 'w-full' : '';

  button.className = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${widthClass} ${className}`.trim();
  button.disabled = disabled;

  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'flex-shrink-0';
    iconSpan.textContent = icon;
    button.appendChild(iconSpan);
  }

  if (text) {
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    button.appendChild(textSpan);
  }

  if (onClick) {
    button.addEventListener('click', onClick);
  }

  return button;
}

/**
 * Create an icon button (button with only an icon, no text)
 */
export function createIconButton(
  icon: string,
  options: Omit<ButtonOptions, 'icon'> & { 
    ariaLabel: string;
    title?: string;
  }
): HTMLButtonElement {
  const { ariaLabel, title, ...buttonOptions } = options;
  
  const button = createButton('', { ...buttonOptions, icon });
  button.setAttribute('aria-label', ariaLabel);
  if (title) {
    button.title = title;
  }
  
  // Make icon buttons square
  button.classList.add('aspect-square');
  
  return button;
}
