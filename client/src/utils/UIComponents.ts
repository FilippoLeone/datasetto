/**
 * UI Component Factory
 * Creates consistent, reusable UI components
 */

/**
 * Create an avatar element
 */
export function createAvatar(
  name: string,
  options: {
    size?: number;
    className?: string;
    gradient?: boolean;
    status?: 'online' | 'offline' | 'idle' | 'dnd';
  } = {}
): HTMLElement {
  const { size = 40, className = '', gradient = true, status } = options;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${className}`;
  avatar.style.width = `${size}px`;
  avatar.style.height = `${size}px`;
  avatar.style.borderRadius = '50%';
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.fontWeight = '700';
  avatar.style.fontSize = `${size * 0.4}px`;
  avatar.style.color = 'white';
  avatar.style.flexShrink = '0';
  avatar.style.textTransform = 'uppercase';
  avatar.style.position = 'relative';
  
  if (gradient) {
    avatar.style.background = 'linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))';
  } else {
    avatar.style.background = 'var(--brand-primary)';
  }

  // Set initials
  const initials = name
    .split(' ')
    .map(word => word[0])
    .join('')
    .substring(0, 2);
  avatar.textContent = initials;

  // Add status indicator if provided
  if (status) {
    const statusDot = document.createElement('div');
    statusDot.className = `status-indicator status-${status}`;
    statusDot.style.position = 'absolute';
    statusDot.style.bottom = '-1px';
    statusDot.style.right = '-1px';
    statusDot.style.width = `${size * 0.35}px`;
    statusDot.style.height = `${size * 0.35}px`;
    statusDot.style.borderRadius = '50%';
    statusDot.style.border = `${Math.max(2, size * 0.08)}px solid var(--bg-sidebar)`;
    
    const statusColors: Record<typeof status, string> = {
      online: 'var(--success)',
      offline: 'var(--interactive-muted)',
      idle: 'var(--warning)',
      dnd: 'var(--danger)'
    };
    statusDot.style.backgroundColor = statusColors[status];
    
    avatar.appendChild(statusDot);
  }

  return avatar;
}

/**
 * Create a button element
 */
export function createButton(
  text: string,
  options: {
    variant?: 'primary' | 'secondary' | 'danger' | 'success';
    size?: 'small' | 'medium' | 'large';
    icon?: string;
    onClick?: () => void;
    className?: string;
    disabled?: boolean;
  } = {}
): HTMLButtonElement {
  const {
    variant = 'primary',
    size = 'medium',
    icon,
    onClick,
    className = '',
    disabled = false
  } = options;

  const button = document.createElement('button');
  button.className = `btn btn-${variant} btn-${size} ${className}`;
  button.disabled = disabled;

  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'btn-icon';
    iconSpan.textContent = icon;
    button.appendChild(iconSpan);
  }

  if (text) {
    const textSpan = document.createElement('span');
    textSpan.className = 'btn-text';
    textSpan.textContent = text;
    button.appendChild(textSpan);
  }

  if (onClick) {
    button.addEventListener('click', onClick);
  }

  return button;
}

/**
 * Create a toast notification
 */
export function createToast(
  message: string,
  type: 'success' | 'error' | 'info' | 'warning' = 'info'
): HTMLElement {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    min-width: 300px;
    padding: 16px 20px;
    background: var(--bg-floating);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    border: 2px solid;
    display: none;
    z-index: var(--z-tooltip);
    animation: slideInRight 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
  `;

  const typeColors = {
    success: 'var(--success)',
    error: 'var(--danger)',
    info: 'var(--brand-primary)',
    warning: 'var(--warning)'
  };

  const typeIcons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠'
  };

  toast.style.borderColor = typeColors[type];

  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.alignItems = 'center';
  content.style.gap = '12px';

  const icon = document.createElement('div');
  icon.style.cssText = `
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    flex-shrink: 0;
  `;
  icon.style.backgroundColor = `${typeColors[type]}22`;
  icon.style.color = typeColors[type];
  icon.textContent = typeIcons[type];

  const text = document.createElement('div');
  text.style.cssText = `
    flex: 1;
    color: var(--text-normal);
    font-size: 14px;
    font-weight: 500;
  `;
  text.textContent = message;

  content.appendChild(icon);
  content.appendChild(text);
  toast.appendChild(content);

  return toast;
}

/**
 * Create a tooltip
 */
export function createTooltip(text: string): HTMLElement {
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.textContent = text;
  tooltip.style.cssText = `
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(-8px);
    padding: 8px 12px;
    background: var(--bg-floating);
    color: var(--text-normal);
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-md);
    white-space: nowrap;
    pointer-events: none;
    z-index: var(--z-tooltip);
    box-shadow: var(--shadow-md);
    border: 1px solid rgba(255, 255, 255, 0.1);
    opacity: 0;
    transition: opacity 150ms ease-out, transform 150ms ease-out;
  `;

  return tooltip;
}

/**
 * Add tooltip to an element
 */
export function addTooltip(element: HTMLElement, text: string): void {
  const tooltip = createTooltip(text);
  element.style.position = 'relative';

  element.addEventListener('mouseenter', () => {
    element.appendChild(tooltip);
    requestAnimationFrame(() => {
      tooltip.style.opacity = '1';
      tooltip.style.transform = 'translateX(-50%) translateY(-12px)';
    });
  });

  element.addEventListener('mouseleave', () => {
    tooltip.style.opacity = '0';
    tooltip.style.transform = 'translateX(-50%) translateY(-8px)';
    setTimeout(() => {
      if (tooltip.parentElement) {
        tooltip.remove();
      }
    }, 150);
  });
}

/**
 * Create a badge
 */
export function createBadge(
  text: string | number,
  variant: 'danger' | 'success' | 'warning' | 'info' = 'danger'
): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `badge badge-${variant}`;
  badge.textContent = String(text);
  badge.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 700;
    color: white;
  `;

  const variantColors = {
    danger: 'var(--danger)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    info: 'var(--brand-primary)'
  };

  badge.style.backgroundColor = variantColors[variant];
  badge.style.boxShadow = `0 0 0 3px var(--bg-sidebar), var(--shadow-sm)`;

  return badge;
}

/**
 * Create a loading spinner
 */
export function createSpinner(size: 'small' | 'medium' | 'large' = 'medium'): HTMLElement {
  const spinner = document.createElement('div');
  spinner.className = `spinner spinner-${size}`;
  
  const sizes = { small: 24, medium: 48, large: 64 };
  const spinnerSize = sizes[size];

  spinner.style.cssText = `
    width: ${spinnerSize}px;
    height: ${spinnerSize}px;
    border: ${Math.max(3, spinnerSize / 16)}px solid rgba(255, 255, 255, 0.1);
    border-top-color: var(--brand-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  `;

  return spinner;
}

/**
 * Create a divider
 */
export function createDivider(text?: string): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'divider';
  divider.style.cssText = `
    display: flex;
    align-items: center;
    margin: 16px 0;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;

  if (text) {
    divider.innerHTML = `
      <div style="flex: 1; height: 1px; background: rgba(255, 255, 255, 0.1);"></div>
      <span style="padding: 0 12px;">${text}</span>
      <div style="flex: 1; height: 1px; background: rgba(255, 255, 255, 0.1);"></div>
    `;
  } else {
    divider.innerHTML = '<div style="width: 100%; height: 1px; background: rgba(255, 255, 255, 0.1);"></div>';
  }

  return divider;
}

/**
 * Create a skeleton loader
 */
export function createSkeleton(width: string = '100%', height: string = '20px'): HTMLElement {
  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton';
  skeleton.style.cssText = `
    width: ${width};
    height: ${height};
    background: linear-gradient(
      90deg,
      var(--bg-elevated) 0%,
      var(--bg-floating) 50%,
      var(--bg-elevated) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-loading 1.5s ease-in-out infinite;
    border-radius: var(--radius);
  `;

  return skeleton;
}
