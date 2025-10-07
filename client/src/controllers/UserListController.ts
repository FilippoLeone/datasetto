import type { User, Channel } from '../types';
import type { UserListControllerDeps } from './types';

/**
 * UserListController
 * 
 * Manages the user presence list (member list) including:
 * - Rendering the member list with avatars, names, and status
 * - Sorting users by role and name
 * - Updating member count
 * - Handling user presence updates
 * - Displaying role badges and status indicators
 */
export class UserListController {
  private deps: UserListControllerDeps;

  constructor(deps: UserListControllerDeps) {
    this.deps = deps;
  }

  /**
   * Initialize the controller
   */
  public initialize(): void {
    if (import.meta.env.DEV) {
      console.log('🎭 UserListController initialized');
    }
  }

  /**
   * Handle users update from server
   */
  public handleUsersUpdate(users: User[]): void {
    this.deps.state.setUsers(users);
    this.updatePresenceUI(users);
    this.deps.adminControllerHandlePresenceUpdate?.();
  }

  /**
   * Update the presence/member list UI
   */
  public updatePresenceUI(users: User[]): void {
    // Update member count
    const memberCount = this.deps.elements['member-count'];
    if (memberCount) {
      memberCount.textContent = users.length.toString();
    }

    const presenceList = this.deps.elements.presenceList;
    if (!presenceList) return;

    presenceList.innerHTML = '';
    
    // Sort users: superusers first, then by role, then alphabetically
    const sortedUsers = this.sortUsers(users);

    sortedUsers.forEach(user => {
      const row = this.createMemberRow(user);
      presenceList.appendChild(row);
    });
  }

  /**
   * Sort users by priority: superusers first, then by role, then alphabetically
   */
  private sortUsers(users: User[]): User[] {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    
    return [...users].sort((a, b) => {
      // Superusers first
      if (a.isSuperuser && !b.isSuperuser) return -1;
      if (!a.isSuperuser && b.isSuperuser) return 1;
      
      // Then by role
      const roleOrder = ['admin', 'moderator', 'streamer', 'user'];
      const aRole = a.roles?.[0] || 'user';
      const bRole = b.roles?.[0] || 'user';
      const aIndex = roleOrder.indexOf(aRole);
      const bIndex = roleOrder.indexOf(bRole);
      
      if (aIndex !== bIndex) return aIndex - bIndex;
      
      // Finally alphabetically by display name
      return collator.compare(this.getUserDisplayName(a), this.getUserDisplayName(b));
    });
  }

  /**
   * Create a member row element
   */
  private createMemberRow(user: User): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'member-item';
    row.dataset.id = user.id;

    // Avatar
    const avatar = this.createAvatar(user);
    
    // User info (name + status)
    const info = this.createUserInfo(user);

    row.appendChild(avatar);
    row.appendChild(info);
    
    return row;
  }

  /**
   * Create avatar element
   */
  private createAvatar(user: User): HTMLDivElement {
    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    avatar.textContent = this.getUserInitial(user);
    
    // Add special styling for superusers
    if (user.isSuperuser) {
      avatar.classList.add('superuser');
    }

    return avatar;
  }

  /**
   * Create user info section (name with badges + status)
   */
  private createUserInfo(user: User): HTMLDivElement {
    const info = document.createElement('div');
    info.className = 'member-info';

    // Name with badge
    const nameRow = this.createNameRow(user);
    info.appendChild(nameRow);

    // Status
    const status = this.createStatus(user);
    info.appendChild(status);

    return info;
  }

  /**
   * Create name row with role badges
   */
  private createNameRow(user: User): HTMLDivElement {
    const nameRow = document.createElement('div');
    nameRow.className = 'member-name-row';
    
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = this.getUserDisplayName(user);
    nameRow.appendChild(name);

    // Role badge
    const badge = this.createRoleBadge(user);
    if (badge) {
      nameRow.appendChild(badge);
    }

    return nameRow;
  }

  /**
   * Create role badge element
   */
  private createRoleBadge(user: User): HTMLSpanElement | null {
    if (user.isSuperuser) {
      const badge = document.createElement('span');
      badge.className = 'member-badge superuser-badge';
      badge.textContent = '👑';
      badge.title = 'Superuser';
      return badge;
    }
    
    if (user.roles && user.roles.length > 0) {
      const role = user.roles[0];
      if (role !== 'user') {
        const badge = document.createElement('span');
        badge.className = `member-badge ${role}-badge`;
        badge.textContent = role === 'admin' ? '⚡' : role === 'moderator' ? '🛡️' : '🎥';
        badge.title = role.charAt(0).toUpperCase() + role.slice(1);
        return badge;
      }
    }

    return null;
  }

  /**
   * Create status element
   */
  private createStatus(user: User): HTMLDivElement {
    const status = document.createElement('div');
    status.className = 'member-status';
    status.textContent = this.getPresenceStatusText(user);
    return status;
  }

  /**
   * Get user display name (display name > name > username)
   */
  private getUserDisplayName(user: User | null | undefined): string {
    if (!user) return 'Unknown User';
    const { displayName, username, name } = user;

    const candidates = [displayName, name, username];
    for (const candidate of candidates) {
      if (candidate) {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return this.scrubIdentifierForDisplay(trimmed);
        }
      }
    }

    return 'Unknown User';
  }

  /**
   * Get user initial for avatar
   */
  private getUserInitial(user: User | null | undefined): string {
    const label = this.getUserDisplayName(user);
    const initial = label.trim().charAt(0).toUpperCase();
    return initial || 'U';
  }

  /**
   * Get presence status text based on user's current state
   */
  private getPresenceStatusText(user: User): string {
    if (!user) return 'Online';

    const channels = this.deps.state.get('channels') || [];

    if (user.voiceChannel) {
      const voiceChannel = channels.find((channel: Channel) => channel.id === user.voiceChannel);
      return voiceChannel ? `In voice • ${voiceChannel.name}` : 'In voice chat';
    }

    if (user.currentChannel) {
      const currentChannel = channels.find((channel: Channel) => channel.id === user.currentChannel);
      return currentChannel ? `In #${currentChannel.name}` : 'Online';
    }

    return 'Online';
  }

  /**
   * Scrub identifier for display (remove email domain if present)
   */
  private scrubIdentifierForDisplay(identifier: string): string {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return '';
    }

    // Remove email domain if present (user@domain.com -> user)
    if (trimmed.includes('@')) {
      const [local] = trimmed.split('@');
      return local || trimmed;
    }

    return trimmed;
  }

  /**
   * Resolve user label with fallback (used by other controllers)
   */
  public resolveUserLabel(label?: string | null, fallback?: string): string {
    if (label) {
      const trimmed = label.trim();
      if (trimmed.length > 0) {
        return this.scrubIdentifierForDisplay(trimmed);
      }
    }

    if (fallback) {
      const trimmed = fallback.trim();
      if (trimmed.length > 0) {
        return this.scrubIdentifierForDisplay(trimmed);
      }
    }

    return 'Unknown User';
  }
}
