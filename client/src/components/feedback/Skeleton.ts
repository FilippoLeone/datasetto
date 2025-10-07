/**
 * Skeleton Component
 * Loading placeholder skeletons
 */

export interface SkeletonOptions {
  width?: string;
  height?: string;
  circle?: boolean;
  className?: string;
}

/**
 * Create a skeleton loading element
 */
export function createSkeleton(options: SkeletonOptions = {}): HTMLElement {
  const { width = '100%', height = '20px', circle = false, className = '' } = options;

  const skeleton = document.createElement('div');
  skeleton.className = `${circle ? 'rounded-full' : 'rounded'} animate-pulse ${className}`.trim();
  skeleton.style.width = width;
  skeleton.style.height = height;
  skeleton.style.background = 'linear-gradient(90deg, #0e0e10 0%, #26262c 50%, #0e0e10 100%)';
  skeleton.style.backgroundSize = '200% 100%';
  skeleton.style.animation = 'skeleton-loading 1.5s ease-in-out infinite';
  skeleton.setAttribute('aria-busy', 'true');
  skeleton.setAttribute('aria-label', 'Loading');

  return skeleton;
}

/**
 * Create a skeleton text line
 */
export function createSkeletonText(width: string = '100%'): HTMLElement {
  return createSkeleton({ width, height: '16px' });
}

/**
 * Create a skeleton avatar
 */
export function createSkeletonAvatar(size: number = 40): HTMLElement {
  return createSkeleton({ 
    width: `${size}px`, 
    height: `${size}px`, 
    circle: true 
  });
}

/**
 * Create a skeleton card/block
 */
export function createSkeletonCard(height: string = '200px'): HTMLElement {
  return createSkeleton({ height, className: 'w-full' });
}

/**
 * Create a skeleton user profile
 */
export function createSkeletonProfile(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'flex items-center gap-3';

  const avatar = createSkeletonAvatar(48);
  const info = document.createElement('div');
  info.className = 'flex-1 space-y-2';

  const name = createSkeletonText('60%');
  const status = createSkeletonText('40%');
  status.style.height = '12px';

  info.appendChild(name);
  info.appendChild(status);
  container.appendChild(avatar);
  container.appendChild(info);

  return container;
}

/**
 * Create multiple skeleton lines (for text content)
 */
export function createSkeletonLines(count: number = 3, widths?: string[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'space-y-2';

  for (let i = 0; i < count; i++) {
    const width = widths?.[i] || (i === count - 1 ? '70%' : '100%');
    const line = createSkeletonText(width);
    container.appendChild(line);
  }

  return container;
}
