import { generateIdenticonSvg } from '@/utils/avatarGenerator';
import { mergeRolePermissions, hasPermission } from '@/utils';
import type {
  Account,
  Channel,
  ChannelGroup,
  RoleName,
  RolePermissions,
  SessionInfo,
  User,
} from '@/types';
import type { AuthControllerDeps } from './types';

export type AuthMode = 'login' | 'register' | 'profile';

export interface AuthStateSnapshot {
  authMode: AuthMode;
  isAuthenticated: boolean;
  isSuperuser: boolean;
  hasManagementAccess: boolean;
  currentRoles: RoleName[];
  rolePermissions: RolePermissions | null;
  sessionResumePending: boolean;
}

export class AuthController {
  private deps: AuthControllerDeps;

  private authMode: AuthMode = 'register';
  private authSubmitting = false;
  private sessionResumePending = false;
  private isAuthenticated = false;
  private isSuperuser = false;
  private hasManagementAccess = false;
  private currentRoles: RoleName[] = [];
  private rolePermissions: RolePermissions | null = null;

  constructor(deps: AuthControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerDomListeners();
    this.registerSocketListeners();

    const storedSession = this.deps.state.get('session');
    if (storedSession?.token) {
      this.sessionResumePending = true;
    }

    const account = this.deps.state.get('account');
    if (account) {
      const permissions = mergeRolePermissions(account.roles ?? []);
      this.applyPermissions(permissions);
    } else {
      this.applyPermissions(null);
    }

    this.populateAuthForm(account);
    this.updateAuthTabs();
    this.updateAuthFormVisibility();
  }

  getSnapshot(): AuthStateSnapshot {
    return {
      authMode: this.authMode,
      isAuthenticated: this.isAuthenticated,
      isSuperuser: this.isSuperuser,
      hasManagementAccess: this.hasManagementAccess,
      currentRoles: [...this.currentRoles],
      rolePermissions: this.rolePermissions,
      sessionResumePending: this.sessionResumePending,
    };
  }

  markSessionResumePending(): void {
    this.sessionResumePending = true;
    this.emitStateChange();
  }

  clearSessionResumePending(): void {
    this.sessionResumePending = false;
    this.emitStateChange();
  }

  isUserAuthenticated(): boolean {
    return this.isAuthenticated;
  }

  getRolePermissions(): RolePermissions | null {
    return this.rolePermissions;
  }

  showAuthModal(mode: AuthMode): void {
    this.setAuthMode(mode);
    this.deps.mobileClosePanels?.();
    const modal = this.elements.regModal;
    if (!modal) return;

    this.deps.animator.openModal(modal);
    this.deps.soundFX.play('click', 0.4);
  }

  hideAuthModal(): void {
    const modal = this.elements.regModal;
    if (!modal) return;
    this.deps.animator.closeModal(modal);
  }

  private emitStateChange(): void {
    this.deps.onStateChange(this.getSnapshot());
  }

  handleAuthSubmit(): void {
    if (this.authSubmitting) {
      return;
    }

    const errorEl = this.elements.regError;

    if (errorEl) {
      errorEl.textContent = '';
    }

    const showError = (message: string): void => {
      if (errorEl) {
        errorEl.textContent = message;
      }
      this.deps.soundFX.play('error', 0.5);
    };

    if (this.authMode === 'login') {
      const loginEmailInput = this.elements.authLoginEmail as HTMLInputElement | undefined;
      const loginPasswordInput = this.elements.authLoginPassword as HTMLInputElement | undefined;
      const emailRaw = loginEmailInput?.value?.trim() ?? '';
      const password = loginPasswordInput?.value ?? '';
      const emailNormalized = emailRaw.toLowerCase();

      if (!emailNormalized) {
        showError('Email is required');
        return;
      }
      if (!this.isValidEmail(emailRaw)) {
        showError('Enter a valid email address');
        return;
      }
      if (!password) {
        showError('Password is required');
        return;
      }

      this.setAuthSubmitting(true);
      this.deps.socket.login({ username: emailNormalized, password });
      return;
    }

    if (this.authMode === 'register') {
      const registerEmailInput = this.elements.authRegisterEmail as HTMLInputElement | undefined;
      const registerPasswordInput = this.elements.authRegisterPassword as HTMLInputElement | undefined;
      const registerConfirmInput = this.elements.authRegisterConfirm as HTMLInputElement | undefined;
      const registerDisplayNameInput = this.elements.authRegisterDisplayName as HTMLInputElement | undefined;

      const emailRaw = registerEmailInput?.value?.trim() ?? '';
      const emailNormalized = emailRaw.toLowerCase();
      const password = registerPasswordInput?.value ?? '';
      const confirm = registerConfirmInput?.value ?? '';
      const fallbackDisplayName = this.scrubIdentifierForDisplay(emailRaw) || emailRaw;
      const displayName = registerDisplayNameInput?.value?.trim() || fallbackDisplayName;

      if (!this.isValidEmail(emailRaw)) {
        showError('Enter a valid email address');
        return;
      }
      if (emailRaw.length > 254) {
        showError('Email must be 254 characters or less');
        return;
      }
      if (password.trim().length < 8) {
        showError('Password must be at least 8 characters long');
        return;
      }
      if (password !== confirm) {
        showError('Passwords do not match');
        return;
      }

      this.setAuthSubmitting(true);
      this.deps.socket.register({
        username: emailNormalized,
        password,
        profile: {
          displayName: displayName || fallbackDisplayName,
        },
      });
      return;
    }

    const profileDisplayNameInput = this.elements.authProfileDisplayName as HTMLInputElement | undefined;
    const profileContactEmailInput = this.elements.authProfileContactEmail as HTMLInputElement | undefined;
    const profileBioInput = this.elements.authProfileBio as HTMLTextAreaElement | undefined;
    const profileCurrentPasswordInput = this.elements.authProfileCurrentPassword as HTMLInputElement | undefined;
    const profileNewPasswordInput = this.elements.authProfileNewPassword as HTMLInputElement | undefined;
    const profileNewPasswordConfirmInput = this.elements.authProfileNewPasswordConfirm as HTMLInputElement | undefined;

    const displayName = profileDisplayNameInput?.value?.trim() ?? '';
    const contactEmailRaw = profileContactEmailInput?.value?.trim() ?? '';
    const contactEmail = contactEmailRaw.length > 0 ? contactEmailRaw : null;
    const bio = profileBioInput?.value?.trim() ?? '';
    const currentPassword = profileCurrentPasswordInput?.value ?? '';
    const newPassword = profileNewPasswordInput?.value ?? '';
    const newPasswordConfirm = profileNewPasswordConfirmInput?.value ?? '';

    if (contactEmail && !this.isValidEmail(contactEmail)) {
      showError('Enter a valid backup email address');
      return;
    }
    if (contactEmail && contactEmail.length > 254) {
      showError('Backup email must be 254 characters or less');
      return;
    }

    const updates: Parameters<typeof this.deps.socket.updateAccount>[0] = {};
    updates.displayName = displayName || undefined;
    updates.email = contactEmail;
    updates.bio = bio || null;

    if (newPassword) {
      if (newPassword.length < 8) {
        showError('New password must be at least 8 characters long');
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        showError('New passwords do not match');
        return;
      }
      if (!currentPassword) {
        showError('Current password is required to change password');
        return;
      }

      updates.currentPassword = currentPassword;
      updates.newPassword = newPassword;
    }

    this.setAuthSubmitting(true);
    this.deps.socket.updateAccount(updates);
  }

  handleLogout(): void {
    if (!this.isAuthenticated) {
      this.setAuthMode('login');
      this.showAuthModal('login');
      return;
    }

    this.setLogoutSubmitting(true);
    this.deps.socket.logout();
  }

  private get elements(): Record<string, HTMLElement> {
    return this.deps.elements;
  }

  private registerDomListeners(): void {
    const { addListener } = this.deps;

    addListener(this.elements.registerBtn, 'click', () => this.handleAuthSubmit());
    addListener(this.elements.regCancel, 'click', () => this.hideAuthModal());
    addListener(this.elements.logoutBtn, 'click', () => this.handleLogout());

  const passwordInput = this.elements.authRegisterPassword as HTMLInputElement | undefined;
    if (passwordInput) {
      addListener(passwordInput, 'input', (event) => {
        const target = event.target as HTMLInputElement;
        this.updatePasswordStrength(target.value);
      });
      this.updatePasswordStrength(passwordInput.value ?? '');
    }

    const authTabLogin = document.getElementById('authTabLogin');
    if (authTabLogin) {
      addListener(authTabLogin, 'click', () => this.showAuthModal('login'));
    }

    const authTabRegister = document.getElementById('authTabRegister');
    if (authTabRegister) {
      addListener(authTabRegister, 'click', () => this.showAuthModal('register'));
    }

    const authTabProfile = document.getElementById('authTabProfile');
    if (authTabProfile) {
      addListener(authTabProfile, 'click', () => this.showAuthModal('profile'));
    }

    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar) {
      addListener(userAvatar, 'click', () => {
        this.showAuthModal(this.isAuthenticated ? 'profile' : 'register');
      });
    }

    const userInfo = document.querySelector('.user-info');
    if (userInfo) {
      addListener(userInfo, 'click', () => {
        this.showAuthModal(this.isAuthenticated ? 'profile' : 'register');
      });
    }
  }

  private registerSocketListeners(): void {
    const unsubscribeAuthSuccess = this.deps.socket.on('auth:success', (payload) => this.handleAuthSuccess(payload));
    const unsubscribeAuthError = this.deps.socket.on('auth:error', (payload) => this.handleAuthError(payload));
    const unsubscribeAuthLoggedOut = this.deps.socket.on('auth:loggedOut', () => this.handleAuthLoggedOut());
    const unsubscribeAccountUpdated = this.deps.socket.on('account:updated', (payload) => this.handleAccountUpdated(payload));
    const unsubscribeAccountData = this.deps.socket.on('account:data', (payload) => this.handleAccountData(payload));
    const unsubscribeAccountRoles = this.deps.socket.on('account:rolesUpdated', (payload) => this.handleAccountRolesUpdated(payload));
    const unsubscribeAccountError = this.deps.socket.on('account:error', (payload) => this.handleAccountError(payload));
    const unsubscribeSocketConnected = this.deps.socket.on('socket:connected', () => this.handleSocketConnected());
    const unsubscribeSocketDisconnected = this.deps.socket.on('socket:disconnected', ({ reason }) => this.handleSocketDisconnected(reason));
    const unsubscribePresence = this.deps.socket.on('user:update', (users) => this.updatePresenceUI(users));

    [
      unsubscribeAuthSuccess,
      unsubscribeAuthError,
      unsubscribeAuthLoggedOut,
      unsubscribeAccountUpdated,
      unsubscribeAccountData,
      unsubscribeAccountRoles,
      unsubscribeAccountError,
      unsubscribeSocketConnected,
      unsubscribeSocketDisconnected,
      unsubscribePresence,
    ].forEach((unsubscribe) => this.deps.registerCleanup(unsubscribe));
  }

  private handleSocketConnected(): void {
    const storedSession = this.deps.state.get('session');
    if (this.sessionResumePending && storedSession?.token) {
      this.deps.socket.resumeSession(storedSession.token);
      return;
    }

    if (!this.isAuthenticated && storedSession?.token) {
      this.sessionResumePending = true;
      this.deps.socket.resumeSession(storedSession.token);
    }
  }

  private handleSocketDisconnected(_reason: string): void {
    this.sessionResumePending = Boolean(this.deps.state.get('session')?.token);
  }

  private handleAuthSuccess(payload: {
    user: User;
    account: Account;
    session: SessionInfo;
    channels: Channel[];
    groups?: ChannelGroup[];
    isNewAccount?: boolean;
  }): void {
    const { account, session, channels, groups, isNewAccount } = payload;

    this.sessionResumePending = false;
    this.setAuthSubmitting(false);
    this.setLogoutSubmitting(false);

    this.deps.state.setAuth(account, session);

    if (Array.isArray(channels) && channels.length > 0) {
      this.deps.state.setChannels(channels);
      this.deps.onChannelBootstrap(channels, groups);
    }

    if (Array.isArray(groups) && groups.length > 0) {
      this.deps.state.setChannelGroups(groups);
    }

    const permissions = mergeRolePermissions(account.roles ?? []);
    this.applyPermissions(permissions);

    const friendlyName = account.displayName || account.username;
    this.deps.notifications.success(isNewAccount ? `Account created! Welcome, ${friendlyName}.` : `Signed in as ${friendlyName}`);
    this.deps.soundFX.play('success', 0.6);

    if (hasPermission(permissions, 'canManageUsers')) {
      this.deps.socket.requestAccountList();
    }

    this.setAuthMode('profile');
    this.hideAuthModal();
  }

  private handleAuthError(payload: { message: string; code?: string }): void {
    const { message, code } = payload;

    this.sessionResumePending = false;
    this.setAuthSubmitting(false);
    this.setLogoutSubmitting(false);

    if (code === 'SESSION_FAILED' || code === 'ACCOUNT_DISABLED') {
      this.deps.state.clearAccount();
      this.applyPermissions(null);
      this.deps.onSessionInvalidated();
    }

    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = message;
    }

    this.deps.notifications.error(message || 'Authentication failed.');

    if (!this.isAuthenticated) {
      this.setAuthMode(code === 'REGISTRATION_FAILED' ? 'register' : 'login');
      const modal = this.elements.regModal;
        if (!modal || modal.classList.contains('hidden')) {
        this.showAuthModal(this.authMode);
      }
    }
    this.emitStateChange();
  }

  private handleAuthLoggedOut(): void {
    this.sessionResumePending = false;
    this.setAuthSubmitting(false);
    this.setLogoutSubmitting(false);

    this.deps.state.clearAccount();
    this.applyPermissions(null);
    this.deps.notifications.info('You have been logged out.');
    this.deps.onSessionInvalidated();

    this.setAuthMode('login');
    this.showAuthModal('login');
    this.emitStateChange();
  }

  private handleAccountUpdated(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    this.deps.state.updateAccount(payload.account);
    this.applyPermissions(mergeRolePermissions(payload.account.roles ?? []));
    this.deps.notifications.success('Profile updated successfully.');
    this.setAuthSubmitting(false);
    this.emitStateChange();
  }

  private handleAccountData(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    this.deps.state.updateAccount(payload.account);
    this.applyPermissions(mergeRolePermissions(payload.account.roles ?? []));
    this.emitStateChange();
  }

  private handleAccountRolesUpdated(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    const currentAccount = this.deps.state.get('account');
    if (currentAccount && currentAccount.id === payload.account.id) {
      this.deps.state.updateAccount(payload.account);
      this.applyPermissions(mergeRolePermissions(payload.account.roles ?? []));
      this.deps.notifications.info('Your roles have been updated.');
      this.emitStateChange();
    }
  }

  private handleAccountError(payload: { message: string; code?: string }): void {
    this.setAuthSubmitting(false);

    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = payload.message;
    }

    this.deps.notifications.error(payload.message || 'Account update failed.');
    this.emitStateChange();
  }

  private applyPermissions(permissions: RolePermissions | null): void {
    this.rolePermissions = permissions;
    this.isAuthenticated = Boolean(permissions);

    const account = this.deps.state.get('account');
    this.currentRoles = permissions && account ? account.roles ?? [] : [];
    this.isSuperuser = this.currentRoles.includes('superuser');
    this.hasManagementAccess = this.isSuperuser
      || hasPermission(permissions, 'canManageUsers')
      || hasPermission(permissions, 'canManageChannelPermissions')
      || hasPermission(permissions, 'canAssignRoles')
      || hasPermission(permissions, 'canDisableAccounts');

    const toggleDisabled = (element: HTMLElement | null | undefined, disabled: boolean) => {
      if (!element) return;
      if ('disabled' in element) {
        try {
          (element as HTMLButtonElement).disabled = disabled;
        } catch {
          element.classList.toggle('is-disabled', disabled);
        }
      } else {
        element.classList.toggle('is-disabled', disabled);
      }
    };

    const chatInput = this.elements.chatInput as HTMLInputElement | undefined;
    if (chatInput) {
      chatInput.disabled = !this.isAuthenticated;
      if (this.isAuthenticated) {
        const currentChannelId = this.deps.state.get('currentChannel');
        const channel = this.deps.state.get('channels').find((ch) => ch.id === currentChannelId);
        chatInput.placeholder = channel ? `Message #${channel.name}` : 'Type a message';
      } else {
        chatInput.placeholder = 'Log in to send messages';
        chatInput.value = '';
      }
    }

    toggleDisabled(this.elements.mute as HTMLButtonElement, !this.isAuthenticated);
    toggleDisabled(this.elements.deafen as HTMLButtonElement, !this.isAuthenticated);
    const canCreateChannels = hasPermission(permissions, 'canCreateChannels');
    toggleDisabled(this.elements['create-text-channel'] as HTMLButtonElement, !canCreateChannels);
    toggleDisabled(this.elements['create-voice-channel'] as HTMLButtonElement, !canCreateChannels);
    toggleDisabled(this.elements['create-stream-channel'] as HTMLButtonElement, !canCreateChannels);

    const userStatus = this.elements['user-status-text'];
    if (userStatus) {
      const roleLabel = this.currentRoles.length > 0
        ? this.currentRoles.map((role) => role.charAt(0).toUpperCase() + role.slice(1)).join(', ')
        : 'Online';

      if (!this.isAuthenticated) {
        userStatus.textContent = 'Guest';
        userStatus.style.color = 'var(--text-muted)';
      } else if (this.isSuperuser) {
        userStatus.textContent = 'Superuser';
        userStatus.style.color = '#f48024';
      } else if (this.hasManagementAccess) {
        userStatus.textContent = roleLabel;
        userStatus.style.color = '#f48024';
      } else {
        userStatus.textContent = roleLabel;
        userStatus.style.color = '';
      }
    }

    this.updateAccountUI();
    this.updateAuthTabs();
    this.updateAuthFormVisibility();
    this.emitStateChange();
  }

  private updatePresenceUI(users: User[]): void {
    const memberCount = this.elements['member-count'];
    if (memberCount) {
      memberCount.textContent = users.length.toString();
    }

    if (!this.elements.presenceList) {
      return;
    }

    const list = this.elements.presenceList;
    list.innerHTML = '';

    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    const sortedUsers = [...users].sort((a, b) => {
      if (a.isSuperuser && !b.isSuperuser) return -1;
      if (!a.isSuperuser && b.isSuperuser) return 1;

      const roleOrder = ['admin', 'moderator', 'streamer', 'user'];
      const aRole = a.roles?.[0] || 'user';
      const bRole = b.roles?.[0] || 'user';
      const aIndex = roleOrder.indexOf(aRole);
      const bIndex = roleOrder.indexOf(bRole);

      if (aIndex !== bIndex) return aIndex - bIndex;
      return collator.compare(this.getUserDisplayName(a), this.getUserDisplayName(b));
    });

    sortedUsers.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'member-item';
      row.dataset.id = user.id;

      const avatar = document.createElement('div');
      avatar.className = 'member-avatar';
      avatar.textContent = this.getUserInitial(user);
      if (user.isSuperuser) {
        avatar.classList.add('superuser');
      }

      const info = document.createElement('div');
      info.className = 'member-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'member-name-row';

      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = this.getUserDisplayName(user);
      nameRow.appendChild(name);

      if (user.isSuperuser) {
        const badge = document.createElement('span');
        badge.className = 'member-badge superuser-badge';
        badge.textContent = '👑';
        badge.title = 'Superuser';
        nameRow.appendChild(badge);
      } else if (user.roles && user.roles.length > 0) {
        const role = user.roles[0];
        if (role !== 'user') {
          const badge = document.createElement('span');
          badge.className = `member-badge ${role}-badge`;
          badge.textContent = role === 'admin' ? '⚡' : role === 'moderator' ? '🛡️' : '🎥';
          badge.title = role.charAt(0).toUpperCase() + role.slice(1);
          nameRow.appendChild(badge);
        }
      }

      info.appendChild(nameRow);

      const status = document.createElement('div');
      status.className = 'member-status';
      status.textContent = this.getPresenceStatusText(user);
      info.appendChild(status);

      row.appendChild(avatar);
      row.appendChild(info);
      list.appendChild(row);
    });
  }

  private updateAccountUI(): void {
    const account = this.deps.state.get('account');
    const identifierFallback = this.scrubIdentifierForDisplay(account?.username ?? '');
    const displayLabel = account?.displayName && account.displayName.trim().length > 0
      ? account.displayName
      : identifierFallback || 'Guest';

    if (this.elements.accName) {
      this.elements.accName.textContent = displayLabel;
    }

    const avatarEl = this.elements['user-avatar'];
    if (avatarEl) {
      const svgMarkup = generateIdenticonSvg(displayLabel, {
        size: 48,
        label: `${displayLabel} avatar`,
      });
      avatarEl.innerHTML = svgMarkup;
      avatarEl.setAttribute('title', displayLabel);
      avatarEl.setAttribute('aria-label', `${displayLabel} avatar`);
      avatarEl.setAttribute('data-initial', displayLabel.charAt(0).toUpperCase());
      avatarEl.classList.toggle('is-superuser', this.isSuperuser);
    }
  }

  private setAuthMode(mode: AuthMode): void {
    if (this.isAuthenticated) {
      mode = 'profile';
    } else if (mode === 'profile') {
      mode = 'login';
    }

    this.authMode = mode;
    this.setAuthSubmitting(false);
    this.clearAuthErrors();
    this.populateAuthForm(this.deps.state.get('account'));
    this.updateAuthTabs();
    this.updateAuthFormVisibility();
    this.updateAuthActionButton();
    this.emitStateChange();
  }

  private setAuthSubmitting(inProgress: boolean): void {
    this.authSubmitting = inProgress;
    this.updateAuthActionButton();
  }

  private setLogoutSubmitting(inProgress: boolean): void {
    const logoutBtn = this.elements.logoutBtn as HTMLButtonElement | undefined;
    if (!logoutBtn) return;
    logoutBtn.disabled = inProgress;
    logoutBtn.textContent = inProgress ? 'Logging Out…' : 'Log Out';
  }

  private updateAuthTabs(): void {
    const tabLogin = document.getElementById('authTabLogin');
    const tabRegister = document.getElementById('authTabRegister');
    const tabProfile = document.getElementById('authTabProfile');
    const tabsContainer = document.querySelector('.auth-mode-tabs');

    const activate = (tab: HTMLElement | null, active: boolean) => {
      if (!tab) return;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
    };

    activate(tabLogin, this.authMode === 'login');
    activate(tabRegister, this.authMode === 'register');
    activate(tabProfile, this.authMode === 'profile');

    const hideAuthTabs = this.isAuthenticated;

    if (tabLogin) {
      tabLogin.classList.toggle('hidden', hideAuthTabs);
    }

    if (tabRegister) {
      tabRegister.classList.toggle('hidden', hideAuthTabs);
    }

    if (tabProfile) {
      tabProfile.classList.toggle('hidden', !this.isAuthenticated);
    }

    if (tabsContainer) {
      tabsContainer.classList.toggle('hidden', hideAuthTabs);
    }
  }

  private updateAuthActionButton(): void {
    const button = this.elements.registerBtn as HTMLButtonElement | undefined;
    if (!button) return;
    button.disabled = this.authSubmitting;
    button.textContent = this.getAuthButtonLabel(this.authSubmitting);
  }

  private getAuthButtonLabel(isLoading = false): string {
    if (isLoading) {
      if (this.authMode === 'login') return 'Logging In…';
      if (this.authMode === 'register') return 'Registering…';
      return 'Saving…';
    }

    if (this.authMode === 'login') return 'Log In';
    if (this.authMode === 'register') return 'Create Account';
    return 'Save Settings';
  }

  private updateAuthFormVisibility(): void {
    const loginSection = this.elements.authLoginSection as HTMLElement | undefined;
    const registerSection = this.elements.authRegisterSection as HTMLElement | undefined;
    const profileSection = this.elements.authProfileSection as HTMLElement | undefined;

    const toggleSection = (section: HTMLElement | undefined, visible: boolean) => {
      if (!section) return;
      section.classList.toggle('hidden', !visible);
      section.setAttribute('aria-hidden', visible ? 'false' : 'true');
    };

    const canShowAuthForms = !this.isAuthenticated;
    toggleSection(loginSection, canShowAuthForms && this.authMode === 'login');
    toggleSection(registerSection, canShowAuthForms && this.authMode === 'register');
    toggleSection(profileSection, this.isAuthenticated || this.authMode === 'profile');

    const profileAccountEmailInput = this.elements.authProfileAccountEmail as HTMLInputElement | undefined;
    if (profileAccountEmailInput) {
      profileAccountEmailInput.readOnly = true;
      profileAccountEmailInput.disabled = true;
    }

    const registerPasswordInput = this.elements.authRegisterPassword as HTMLInputElement | undefined;
    this.updatePasswordStrength(this.authMode === 'register' ? (registerPasswordInput?.value ?? '') : '');

    this.updateAuthModalCopy();
  }

  private updateAuthModalCopy(): void {
    const title = document.getElementById('settings-modal-title');
    const subtitle = document.getElementById('settings-modal-subtitle');
    const modeHint = document.getElementById('auth-mode-hint');
    const cancelBtn = this.elements.regCancel as HTMLButtonElement | undefined;
    const logoutBtn = this.elements.logoutBtn as HTMLButtonElement | undefined;

    if (title) {
      if (this.authMode === 'login') {
        title.textContent = 'Log In';
      } else if (this.authMode === 'register') {
        title.textContent = 'Create Account';
      } else {
        title.textContent = 'User Settings';
      }
    }

    if (subtitle) {
      if (!this.isAuthenticated && (this.authMode === 'login' || this.authMode === 'register')) {
        subtitle.classList.remove('hidden');
        subtitle.textContent = this.authMode === 'login'
          ? 'Enter your credentials to continue'
          : 'Password is required to create an account';
      } else if (this.authMode === 'profile' && this.isAuthenticated) {
        subtitle.classList.remove('hidden');
        subtitle.textContent = 'Review your account details and update password or profile info.';
      } else {
        subtitle.classList.add('hidden');
      }
    }

    if (modeHint) {
      const shouldHideHint = this.isAuthenticated || this.authMode === 'profile';
      modeHint.classList.toggle('hidden', shouldHideHint);

      if (!shouldHideHint) {
        if (this.authMode === 'login') {
          modeHint.textContent = 'Log back in to pick up where you left off.';
        } else if (this.authMode === 'register') {
          modeHint.textContent = 'Create a new account to join the conversation.';
        }
      }
    }

    if (cancelBtn) {
      const shouldHideCancel = !this.isAuthenticated && (this.authMode === 'login' || this.authMode === 'register');
      cancelBtn.classList.toggle('hidden', shouldHideCancel);
    }

    if (logoutBtn) {
      if (this.authMode === 'profile' && this.isAuthenticated) {
        logoutBtn.classList.remove('hidden');
        this.setLogoutSubmitting(false);
      } else {
        this.setLogoutSubmitting(false);
        logoutBtn.classList.add('hidden');
      }
    }
  }

  private updatePasswordStrength(password: string): void {
    const container = this.elements.passwordStrength as HTMLElement | undefined;
    const fill = this.elements.passwordStrengthFill as HTMLElement | undefined;
    const label = this.elements.passwordStrengthLabel as HTMLElement | undefined;

    if (!container || !fill || !label) {
      return;
    }

    if (this.authMode !== 'register') {
      container.classList.remove('visible');
      container.dataset.level = '';
      fill.style.width = '0%';
      label.textContent = 'Start typing to check strength';
      return;
    }

    if (!password) {
      container.classList.remove('visible');
      container.dataset.level = '';
      fill.style.width = '0%';
      label.textContent = 'Start typing to check strength';
      return;
    }

    const { level, percentage, descriptor } = this.evaluatePasswordStrength(password);
    container.dataset.level = level;
    container.classList.add('visible');
    fill.style.width = `${percentage}%`;
    label.textContent = descriptor;
  }

  private evaluatePasswordStrength(password: string): {
    level: 'weak' | 'fair' | 'good' | 'strong';
    percentage: number;
    descriptor: string;
  } {
    let score = 0;

    if (password.length >= 8) {
      score += 1;
    }

    if (password.length >= 12) {
      score += 1;
    }

    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
      score += 1;
    }

    if (/\d/.test(password)) {
      score += 1;
    }

    if (/[^A-Za-z0-9]/.test(password)) {
      score += 1;
    }

    score = Math.min(score, 4);

    switch (score) {
      case 0:
        return {
          level: 'weak',
          percentage: 20,
          descriptor: 'Too weak — add more characters',
        };
      case 1:
        return {
          level: 'weak',
          percentage: 35,
          descriptor: 'Weak — mix upper, lower, numbers, and symbols',
        };
      case 2:
        return {
          level: 'fair',
          percentage: 55,
          descriptor: 'Fair — add more variety for strength',
        };
      case 3:
        return {
          level: 'good',
          percentage: 80,
          descriptor: 'Good — almost there!',
        };
      default:
        return {
          level: 'strong',
          percentage: 100,
          descriptor: 'Strong password!',
        };
    }
  }

  private isValidEmail(value: string): boolean {
    if (!value) {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  }

  private scrubIdentifierForDisplay(identifier: string): string {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.includes('@')) {
      const [local] = trimmed.split('@');
      return local || trimmed;
    }

    return trimmed;
  }

  private populateAuthForm(account: Account | null): void {
    const loginEmailInput = this.elements.authLoginEmail as HTMLInputElement | undefined;
    const loginPasswordInput = this.elements.authLoginPassword as HTMLInputElement | undefined;
    const registerEmailInput = this.elements.authRegisterEmail as HTMLInputElement | undefined;
    const registerPasswordInput = this.elements.authRegisterPassword as HTMLInputElement | undefined;
    const registerConfirmInput = this.elements.authRegisterConfirm as HTMLInputElement | undefined;
    const registerDisplayNameInput = this.elements.authRegisterDisplayName as HTMLInputElement | undefined;
    const profileAccountEmailInput = this.elements.authProfileAccountEmail as HTMLInputElement | undefined;
    const profileDisplayNameInput = this.elements.authProfileDisplayName as HTMLInputElement | undefined;
    const profileContactEmailInput = this.elements.authProfileContactEmail as HTMLInputElement | undefined;
    const profileBioInput = this.elements.authProfileBio as HTMLTextAreaElement | undefined;
    const profileCurrentPasswordInput = this.elements.authProfileCurrentPassword as HTMLInputElement | undefined;
    const profileNewPasswordInput = this.elements.authProfileNewPassword as HTMLInputElement | undefined;
    const profileNewPasswordConfirmInput = this.elements.authProfileNewPasswordConfirm as HTMLInputElement | undefined;

    if (loginEmailInput) {
      loginEmailInput.value = this.authMode === 'login' ? (account?.username ?? '') : '';
    }
    if (loginPasswordInput) {
      loginPasswordInput.value = '';
    }

    if (registerEmailInput) {
      registerEmailInput.value = '';
    }
    if (registerPasswordInput) {
      registerPasswordInput.value = '';
    }
    if (registerConfirmInput) {
      registerConfirmInput.value = '';
    }
    if (registerDisplayNameInput) {
      registerDisplayNameInput.value = '';
    }

    if (profileAccountEmailInput) {
      profileAccountEmailInput.value = account?.username ?? '';
    }

    if (profileDisplayNameInput) {
      const preferred = account?.displayName && account.displayName.trim().length > 0
        ? account.displayName
        : this.scrubIdentifierForDisplay(account?.username ?? '');
      profileDisplayNameInput.value = this.authMode === 'profile' ? (preferred || '') : '';
    }

    if (profileContactEmailInput) {
      profileContactEmailInput.value = this.authMode === 'profile' && account?.email ? account.email : '';
    }

    if (profileBioInput) {
      profileBioInput.value = this.authMode === 'profile' && account?.bio ? account.bio : '';
    }

    [profileCurrentPasswordInput, profileNewPasswordInput, profileNewPasswordConfirmInput].forEach((input) => {
      if (input) {
        input.value = '';
      }
    });

    this.updatePasswordStrength('');
  }

  private clearAuthErrors(): void {
    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = '';
    }
  }

  private getUserDisplayName(user: User | null | undefined): string {
    if (!user) {
      return 'Unknown User';
    }

    if (user.displayName && user.displayName.trim().length > 0) {
      return user.displayName;
    }

    if (user.username) {
      const trimmed = user.username.trim();
      if (trimmed.length > 0) {
        return this.scrubIdentifierForDisplay(trimmed);
      }
    }

    return 'Unknown User';
  }

  private getUserInitial(user: User | null | undefined): string {
    const label = this.getUserDisplayName(user);
    return label.charAt(0).toUpperCase();
  }

  private getPresenceStatusText(user: User): string {
    if (user.isSuperuser) {
      return 'Superuser';
    }

    if (user.roles && user.roles.length > 0) {
      const primary = user.roles[0];
      if (primary !== 'user') {
        return primary.charAt(0).toUpperCase() + primary.slice(1);
      }
    }

    return 'Online';
  }
}
