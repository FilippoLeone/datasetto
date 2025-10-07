import { hasPermission } from '@/utils';
import type { Account, Channel, RoleName, RolePermissions } from '@/types';
import type { AdminControllerDeps } from './types';

export class AdminController {
  private deps: AdminControllerDeps;
  private menuVisible = false;
  private activeTab: 'users' | 'channels' = 'users';
  private loadingAccounts = false;
  private hasManagementAccess = false;
  private rolePermissions: RolePermissions | null = null;

  constructor(deps: AdminControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerDomListeners();
    this.registerSocketListeners();
    this.syncAccessUI();
  }

  updateAccessState(state: { hasManagementAccess: boolean; rolePermissions: RolePermissions | null }): void {
    const previouslyHadAccess = this.hasManagementAccess;
    this.hasManagementAccess = state.hasManagementAccess;
    this.rolePermissions = state.rolePermissions;
    this.syncAccessUI();

    if (!this.hasManagementAccess && previouslyHadAccess) {
      this.loadingAccounts = false;
      this.toggleMenu(false);
      this.closeModal();
    } else if (this.hasManagementAccess && !previouslyHadAccess) {
      if (this.activeTab === 'users') {
        this.ensureAccountsLoaded();
      } else {
        this.renderSuperuserChannels();
      }
    }
  }

  handleChannelsUpdate(channels: Channel[]): void {
    if (!this.hasManagementAccess) {
      return;
    }

    if (this.activeTab === 'channels') {
      this.renderSuperuserChannels(channels);
    }
  }

  handlePresenceUpdate(): void {
    if (this.hasManagementAccess && this.activeTab === 'users') {
      this.renderSuperuserUsers();
    }
  }

  handleEscape(): boolean {
    let handled = false;

    if (this.menuVisible) {
      this.toggleMenu(false);
      handled = true;
    }

    const modal = this.deps.elements['superuserModal'];
    if (modal && !modal.classList.contains('hidden')) {
      this.closeModal();
      handled = true;
    }

    return handled;
  }

  private registerDomListeners(): void {
    const { addListener, elements } = this.deps;

    addListener(elements['superuser-menu-btn'], 'click', (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleMenu();
    });

    addListener(elements['superuser-manage-users'], 'click', (event: Event) => {
      event.preventDefault();
      this.toggleMenu(false);
      this.openModal('users');
    });

    addListener(elements['superuser-manage-channels'], 'click', (event: Event) => {
      event.preventDefault();
      this.toggleMenu(false);
      this.openModal('channels');
    });

    addListener(elements['superuserModalClose'], 'click', () => this.closeModal());
    addListener(elements['superuserTabUsers'], 'click', () => this.switchTab('users'));
    addListener(elements['superuserTabChannels'], 'click', () => this.switchTab('channels'));

    addListener(elements['superuserModal'], 'click', (event: Event) => {
      if (event.target === elements['superuserModal']) {
        this.closeModal();
      }
    });

    addListener(elements['superuserUsersList'], 'click', (event: Event) => this.handleUserListClick(event as MouseEvent));
    addListener(elements['superuserChannelsList'], 'click', (event: Event) => this.handleChannelListClick(event as MouseEvent));

    addListener(document, 'click', (event: Event) => this.handleDocumentClick(event as MouseEvent));
  }

  private registerSocketListeners(): void {
    const { socket, registerCleanup } = this.deps;

    registerCleanup(
      socket.on('admin:accounts:list', (data: { accounts: Account[] }) => this.handleAccountsList(data.accounts))
    );
    registerCleanup(
      socket.on('admin:accounts:rolesUpdated', (data: { account: Account }) =>
        this.handleAccountUpdate(data.account, 'roles')
      )
    );
    registerCleanup(
      socket.on('admin:accounts:disabled', (data: { account: Account }) =>
        this.handleAccountUpdate(data.account, 'disabled')
      )
    );
    registerCleanup(
      socket.on('admin:accounts:enabled', (data: { account: Account }) =>
        this.handleAccountUpdate(data.account, 'enabled')
      )
    );
    registerCleanup(
      socket.on('admin:error', (error: { message?: string; code?: string }) => this.handleAdminError(error))
    );
  }

  private toggleMenu(force?: boolean): void {
    if (!this.hasManagementAccess && force !== false) {
      return;
    }

    const desired = force !== undefined ? force : !this.menuVisible;
    const open = desired && this.hasManagementAccess;
    this.menuVisible = open;

    const menu = this.deps.elements['superuser-menu'];
    const button = this.deps.elements['superuser-menu-btn'] as HTMLButtonElement | undefined;

    if (menu) {
      menu.classList.toggle('is-visible', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    if (button) {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  private handleDocumentClick(event: MouseEvent): void {
    if (!this.menuVisible) {
      return;
    }

    const menu = this.deps.elements['superuser-menu'];
    const button = this.deps.elements['superuser-menu-btn'];
    const target = event.target as Node;

    if (menu && !menu.contains(target) && button && !button.contains(target)) {
      this.toggleMenu(false);
    }
  }

  private openModal(tab: 'users' | 'channels'): void {
    if (!this.hasManagementAccess) {
      return;
    }

    const modal = this.deps.elements['superuserModal'];
    if (!modal) {
      return;
    }

  this.deps.animator.openModal(modal);
    this.deps.soundFX.play('click', 0.4);
    this.switchTab(tab);
  }

  private closeModal(): void {
    const modal = this.deps.elements['superuserModal'];
    if (!modal || modal.classList.contains('hidden')) {
      return;
    }

    this.deps.animator.closeModal(modal, () => {
      this.activeTab = 'users';
    });
  }

  private switchTab(tab: 'users' | 'channels'): void {
    if (!this.hasManagementAccess) {
      return;
    }

    this.activeTab = tab;

    const usersTab = this.deps.elements['superuserTabUsers'] as HTMLButtonElement | undefined;
    const channelsTab = this.deps.elements['superuserTabChannels'] as HTMLButtonElement | undefined;

    if (usersTab) {
      usersTab.setAttribute('aria-selected', tab === 'users' ? 'true' : 'false');
      usersTab.classList.toggle('active', tab === 'users');
    }

    if (channelsTab) {
      channelsTab.setAttribute('aria-selected', tab === 'channels' ? 'true' : 'false');
      channelsTab.classList.toggle('active', tab === 'channels');
    }

    const usersPanel = this.deps.elements['superuserUsersPanel'] as HTMLElement | undefined;
    if (usersPanel) {
      usersPanel.hidden = tab !== 'users';
      usersPanel.classList.toggle('active', tab === 'users');
    }

    const channelsPanel = this.deps.elements['superuserChannelsPanel'] as HTMLElement | undefined;
    if (channelsPanel) {
      channelsPanel.hidden = tab !== 'channels';
      channelsPanel.classList.toggle('active', tab === 'channels');
    }

    if (tab === 'users') {
      this.ensureAccountsLoaded();
      this.renderSuperuserUsers();
    } else {
      this.renderSuperuserChannels();
    }
  }

  private ensureAccountsLoaded(): void {
    if (!this.hasManagementAccess) {
      return;
    }

    const accounts = this.deps.state.get('accounts') ?? [];
    if (accounts.length > 0 || this.loadingAccounts) {
      return;
    }

    this.loadingAccounts = true;
    this.deps.socket.requestAccountList();

    const list = this.deps.elements['superuserUsersList'];
    if (list) {
      list.innerHTML = '<div class="superuser-empty">Loading accounts…</div>';
    }
  }

  private renderSuperuserUsers(): void {
    const container = this.deps.elements['superuserUsersList'] as HTMLElement | undefined;
    if (!container) {
      return;
    }

    if (!this.hasManagementAccess) {
      container.innerHTML = '';
      return;
    }

    const accounts = [...(this.deps.state.get('accounts') ?? [])];

    if (accounts.length === 0) {
      container.innerHTML = this.loadingAccounts
        ? '<div class="superuser-empty">Loading accounts…</div>'
        : '<div class="superuser-empty">No accounts available yet.</div>';
      return;
    }

    container.innerHTML = '';

    const currentAccountId = this.deps.state.get('account')?.id ?? null;

    accounts.sort((a, b) => {
      const disabledDiff = (a.status === 'disabled' ? 1 : 0) - (b.status === 'disabled' ? 1 : 0);
      if (disabledDiff !== 0) {
        return disabledDiff;
      }

      const superDiff = (a.roles?.includes('superuser') ? 0 : 1) - (b.roles?.includes('superuser') ? 0 : 1);
      if (superDiff !== 0) {
        return superDiff;
      }

      return a.username.localeCompare(b.username);
    });

    accounts.forEach((account) => {
      const card = document.createElement('div');
      card.className = 'superuser-account-card';
      card.dataset.accountId = account.id;

      const info = document.createElement('div');
      info.className = 'superuser-account-info';

      const displayName = account.displayName || account.username;
      const nameEl = document.createElement('div');
      nameEl.className = 'superuser-account-name';
      nameEl.textContent = displayName;

      if (account.id === currentAccountId) {
        const you = document.createElement('span');
        you.textContent = ' (You)';
        you.style.color = 'var(--text-muted)';
        you.style.fontSize = '12px';
        nameEl.appendChild(you);
      }

      info.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'superuser-account-meta';
      const usernameSpan = document.createElement('span');
      usernameSpan.textContent = `@${account.username}`;
      meta.appendChild(usernameSpan);

      if (account.createdAt) {
        const joinedSpan = document.createElement('span');
        joinedSpan.textContent = `Joined ${this.formatDate(account.createdAt)}`;
        meta.appendChild(joinedSpan);
      }

      info.appendChild(meta);

      const rolesContainer = document.createElement('div');
      rolesContainer.className = 'superuser-account-meta';
      (account.roles || []).forEach((role: RoleName) => {
        const badge = document.createElement('span');
        badge.className = 'superuser-role-tag';
        if (role === 'superuser') {
          badge.classList.add('superuser');
        }
        badge.textContent = this.formatRoleLabel(role);
        rolesContainer.appendChild(badge);
      });

      if (rolesContainer.childElementCount > 0) {
        info.appendChild(rolesContainer);
      }

      const status = document.createElement('div');
      status.className = 'superuser-account-status';
      if (account.status === 'disabled') {
        status.classList.add('disabled');
        status.textContent = 'Status: Disabled';
      } else {
        status.textContent = 'Status: Active';
      }
      info.appendChild(status);

      const actions = document.createElement('div');
      actions.className = 'superuser-account-actions';

      if (account.status === 'disabled') {
        const enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'superuser-action-btn';
        enableBtn.textContent = 'Enable';
        enableBtn.dataset.action = 'enable-account';
        enableBtn.dataset.accountId = account.id;
        actions.appendChild(enableBtn);
      } else {
        const disableBtn = document.createElement('button');
        disableBtn.type = 'button';
        disableBtn.className = 'superuser-action-btn danger';
        disableBtn.textContent = 'Disable';
        disableBtn.dataset.action = 'disable-account';
        disableBtn.dataset.accountId = account.id;

        if (account.id === currentAccountId || account.roles?.includes('superuser')) {
          disableBtn.disabled = true;
          disableBtn.title = account.id === currentAccountId
            ? 'You cannot disable your own account.'
            : 'Superuser accounts cannot be disabled from this menu.';
        }

        actions.appendChild(disableBtn);
      }

      card.appendChild(info);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  private renderSuperuserChannels(channelsOverride?: Channel[]): void {
    const container = this.deps.elements['superuserChannelsList'] as HTMLElement | undefined;
    if (!container) {
      return;
    }

    if (!this.hasManagementAccess) {
      container.innerHTML = '';
      return;
    }

    const channels = [...(channelsOverride ?? this.deps.state.get('channels') ?? [])];

    container.innerHTML = '';

    if (channels.length === 0) {
      container.innerHTML = '<div class="superuser-empty">No channels available yet.</div>';
      return;
    }

    const canDelete = hasPermission(this.rolePermissions, 'canDeleteChannels');
    const currentChannelName = this.deps.state.get('currentChannel');
    const activeVoiceChannelId = this.deps.state.get('activeVoiceChannelId');

    channels.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type.localeCompare(b.type);
      }
      return a.name.localeCompare(b.name);
    });

    channels.forEach((channel) => {
      const card = document.createElement('div');
      card.className = 'superuser-channel-card';
      card.dataset.channelId = channel.id;

      const info = document.createElement('div');
      info.className = 'superuser-channel-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'superuser-channel-name';
      nameEl.textContent = channel.name;
      info.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'superuser-channel-meta';

      const typeSpan = document.createElement('span');
      typeSpan.textContent = `Type: ${this.formatChannelType(channel.type)}`;
      meta.appendChild(typeSpan);

      const countSpan = document.createElement('span');
      countSpan.textContent = `Members: ${channel.count ?? 0}`;
      meta.appendChild(countSpan);

      if (channel.type === 'stream' && channel.isLive) {
        const liveSpan = document.createElement('span');
        liveSpan.textContent = 'Live now';
        meta.appendChild(liveSpan);
      }

      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'superuser-channel-actions';

      if (canDelete) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'superuser-action-btn danger';
        deleteBtn.textContent = 'Delete Channel';
        deleteBtn.dataset.action = 'delete-channel';
        deleteBtn.dataset.channelName = channel.name;
        deleteBtn.dataset.channelId = channel.id;

        if (channel.name === currentChannelName || channel.id === activeVoiceChannelId) {
          deleteBtn.disabled = true;
          deleteBtn.title = 'Leave this channel before deleting it.';
        }

        actions.appendChild(deleteBtn);
      } else {
        const hint = document.createElement('div');
        hint.className = 'superuser-account-status';
        hint.textContent = 'Insufficient permissions to delete channels.';
        actions.appendChild(hint);
      }

      card.appendChild(info);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  private handleUserListClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) {
      return;
    }

    const accountId = button.dataset.accountId;
    if (!accountId) {
      return;
    }

    if (button.dataset.action === 'disable-account') {
      this.requestDisableAccount(accountId, button);
    } else if (button.dataset.action === 'enable-account') {
      this.requestEnableAccount(accountId, button);
    }
  }

  private handleChannelListClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) {
      return;
    }

    if (button.dataset.action === 'delete-channel') {
      const channelName = button.dataset.channelName;
      if (!channelName) {
        return;
      }

      if (!hasPermission(this.rolePermissions, 'canDeleteChannels')) {
        this.deps.notifications.warning('You do not have permission to delete channels.');
        return;
      }

      if (!window.confirm(`Delete channel #${channelName}? This cannot be undone.`)) {
        return;
      }

      button.disabled = true;
      this.deps.socket.deleteChannel(channelName);
      this.deps.notifications.warning(`Deleting #${channelName}...`);
    }
  }

  private handleAccountsList(accounts: Account[]): void {
    this.loadingAccounts = false;
    this.deps.state.setAccountsList(accounts);

    if (this.hasManagementAccess && this.activeTab === 'users') {
      this.renderSuperuserUsers();
    }
  }

  private handleAccountUpdate(account: Account, reason: 'roles' | 'disabled' | 'enabled'): void {
    const existing = [...(this.deps.state.get('accounts') ?? [])];
    const index = existing.findIndex((entry) => entry.id === account.id);

    if (index >= 0) {
      existing[index] = { ...account };
    } else {
      existing.push({ ...account });
    }

    this.deps.state.setAccountsList(existing);

    if (this.hasManagementAccess && this.activeTab === 'users') {
      this.renderSuperuserUsers();
    }

    const label = account.displayName || account.username;
    switch (reason) {
      case 'disabled':
        this.deps.notifications.warning(`${label} disabled.`);
        break;
      case 'enabled':
        this.deps.notifications.success(`${label} enabled.`);
        break;
      default:
        this.deps.notifications.success(`${label} updated.`);
    }
  }

  private handleAdminError(error: { message?: string }): void {
    this.loadingAccounts = false;
    const message = error?.message || 'Admin action failed.';
    this.deps.notifications.error(message);

    if (this.hasManagementAccess && this.activeTab === 'users') {
      this.renderSuperuserUsers();
    }
  }

  private requestDisableAccount(accountId: string, control?: HTMLButtonElement): void {
    const accounts = this.deps.state.get('accounts') ?? [];
  const account = accounts.find((entry: Account) => entry.id === accountId);
    if (!account) {
      this.deps.notifications.error('Account not found.');
      return;
    }

    const selfId = this.deps.state.get('account')?.id;
    if (account.id === selfId) {
      this.deps.notifications.warning('You cannot disable your own account.');
      return;
    }

    if (account.roles?.includes('superuser')) {
      this.deps.notifications.warning('Superuser accounts must be managed from the server.');
      return;
    }

    const label = account.displayName || account.username;
    if (!window.confirm(`Disable ${label}? They will be unable to sign in.`)) {
      return;
    }

    if (control) {
      control.disabled = true;
    }

    this.deps.socket.disableAccount({ accountId });
    this.deps.notifications.warning(`Disabling ${label}...`);
  }

  private requestEnableAccount(accountId: string, control?: HTMLButtonElement): void {
    const accounts = this.deps.state.get('accounts') ?? [];
  const account = accounts.find((entry: Account) => entry.id === accountId);
    if (!account) {
      this.deps.notifications.error('Account not found.');
      return;
    }

    if (control) {
      control.disabled = true;
    }

    const label = account.displayName || account.username;
    this.deps.socket.enableAccount({ accountId });
    this.deps.notifications.info(`Re-enabling ${label}...`);
  }

  private formatRoleLabel(role: RoleName): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  private formatChannelType(type: Channel['type']): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private formatDate(timestamp: number): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(timestamp));
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Failed to format date:', error);
      }
      return 'Unknown';
    }
  }

  private syncAccessUI(): void {
    const menuBtn = this.deps.elements['superuser-menu-btn'] as HTMLButtonElement | undefined;
    if (menuBtn) {
      menuBtn.classList.toggle('hidden', !this.hasManagementAccess);
      menuBtn.setAttribute('aria-hidden', this.hasManagementAccess ? 'false' : 'true');
      menuBtn.setAttribute('aria-expanded', 'false');
    }

    if (!this.hasManagementAccess) {
      const menu = this.deps.elements['superuser-menu'];
      if (menu) {
        menu.classList.remove('is-visible');
        menu.setAttribute('aria-hidden', 'true');
      }
      this.menuVisible = false;
    }
  }
}
