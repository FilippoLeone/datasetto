/**
 * Avatar Component
 * User avatar with initials, gradients, and status indicators
 */

export type AvatarStatus = 'online' | 'offline' | 'idle' | 'dnd';

export interface AvatarOptions {
  size?: number;
  className?: string;
  gradient?: boolean;
  status?: AvatarStatus;
  onClick?: () => void;
  imageUrl?: string;
}

/**
 * Generate a consistent color based on name
 */
function getAvatarColor(name: string): string {
  const colors = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
    'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
    'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  ];
  
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Create an avatar element with initials
 */
export function createAvatar(
  name: string,
  options: AvatarOptions = {}
): HTMLElement {
  const { 
    size = 40, 
    className = '', 
    gradient = true, 
    status,
    onClick,
    imageUrl
  } = options;

  const avatar = document.createElement('div');
  const baseClasses = 'rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 uppercase relative overflow-hidden';
  const bgClass = gradient ? '' : 'bg-brand-primary';
  const cursorClass = onClick ? 'cursor-pointer hover:opacity-90 transition-fast' : '';
  
  avatar.className = `${baseClasses} ${bgClass} ${cursorClass} ${className}`.trim();
  avatar.style.width = `${size}px`;
  avatar.style.height = `${size}px`;
  avatar.style.fontSize = `${size * 0.4}px`;
  
  if (gradient && !imageUrl) {
    avatar.style.background = getAvatarColor(name);
  }

  // Set initials or image
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = name;
    img.className = 'w-full h-full object-cover';
    avatar.appendChild(img);
  } else {
    const initials = name
      .split(' ')
      .map(word => word[0])
      .join('')
      .substring(0, 2);
    avatar.textContent = initials;
  }

  // Add status indicator if provided
  if (status) {
    const statusDot = document.createElement('div');
    const statusColors: Record<AvatarStatus, string> = {
      online: 'bg-success',
      offline: 'bg-interactive-muted',
      idle: 'bg-warning',
      dnd: 'bg-danger'
    };
    
    const borderWidth = Math.max(2, size * 0.08);
    const dotSize = size * 0.35;
    
    statusDot.className = `absolute rounded-full border-bg-sidebar ${statusColors[status]}`;
    statusDot.style.width = `${dotSize}px`;
    statusDot.style.height = `${dotSize}px`;
    statusDot.style.borderWidth = `${borderWidth}px`;
    statusDot.style.bottom = '-1px';
    statusDot.style.right = '-1px';
    
    avatar.appendChild(statusDot);
  }

  if (onClick) {
    avatar.addEventListener('click', onClick);
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('tabindex', '0');
  }

  return avatar;
}

/**
 * Create an avatar group (overlapping avatars)
 */
export function createAvatarGroup(
  names: string[],
  options: Omit<AvatarOptions, 'status'> & { max?: number } = {}
): HTMLElement {
  const { max = 3, size = 32, ...avatarOptions } = options;
  
  const container = document.createElement('div');
  container.className = 'flex -space-x-2';
  
  const displayNames = names.slice(0, max);
  const remaining = Math.max(0, names.length - max);
  
  displayNames.forEach((name, index) => {
    const avatar = createAvatar(name, { ...avatarOptions, size });
    avatar.classList.add('ring-2', 'ring-bg-primary');
    avatar.style.zIndex = `${displayNames.length - index}`;
    container.appendChild(avatar);
  });
  
  if (remaining > 0) {
    const moreAvatar = document.createElement('div');
    moreAvatar.className = 'rounded-full flex items-center justify-center font-bold text-text-muted bg-bg-tertiary ring-2 ring-bg-primary flex-shrink-0';
    moreAvatar.style.width = `${size}px`;
    moreAvatar.style.height = `${size}px`;
    moreAvatar.style.fontSize = `${size * 0.35}px`;
    moreAvatar.textContent = `+${remaining}`;
    container.appendChild(moreAvatar);
  }
  
  return container;
}
