/**
 * UI Component Factory
 * Re-exports centralized components from @/components
 * @deprecated - Import directly from @/components instead
 */

// Re-export from centralized components
export { createAvatar, createAvatarGroup } from '@/components/ui/Avatar';
export type { AvatarOptions, AvatarStatus } from '@/components/ui/Avatar';

export { createButton, createIconButton } from '@/components/ui/Button';
export type { ButtonOptions, ButtonVariant, ButtonSize } from '@/components/ui/Button';

export { createToast, dismissToast, toast, ToastManager } from '@/components/feedback/Toast';
export type { ToastOptions, ToastType } from '@/components/feedback/Toast';

export { createTooltip, addTooltip } from '@/components/feedback/Tooltip';
export type { TooltipOptions, TooltipPosition } from '@/components/feedback/Tooltip';

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

export { 
  createSpinner, 
  createSpinnerWithText, 
  createInlineSpinner 
} from '@/components/feedback/Spinner';
export type { SpinnerOptions, SpinnerSize, SpinnerVariant } from '@/components/feedback/Spinner';

export { 
  createDivider, 
  createSectionDivider 
} from '@/components/layout/Divider';
export type { DividerOptions, DividerOrientation } from '@/components/layout/Divider';

export { 
  createSkeleton, 
  createSkeletonText, 
  createSkeletonAvatar, 
  createSkeletonCard,
  createSkeletonProfile,
  createSkeletonLines
} from '@/components/feedback/Skeleton';
export type { SkeletonOptions } from '@/components/feedback/Skeleton';
