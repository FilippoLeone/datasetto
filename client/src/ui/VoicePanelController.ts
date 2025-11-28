export type ModerationAction = 'kick' | 'timeout' | 'ban';

export interface ModerationCallbacks {
  onKick?: (userId: string, userName: string) => void;
  onTimeout?: (userId: string, userName: string, duration: number) => void;
  onBan?: (userId: string, userName: string, reason?: string) => void;
}

export interface VoicePanelEntry {
  id: string;
  name: string;
  muted?: boolean;
  deafened?: boolean;
  speaking?: boolean;
  isCurrentUser?: boolean;
  localMuted?: boolean;
  localVolume?: number;
  showLocalControls?: boolean;
  onLocalMuteToggle?: (muted: boolean) => void;
  onLocalVolumeChange?: (volume: number) => void;
  cameraEnabled?: boolean;
  screenEnabled?: boolean;
  // Moderation props
  canModerate?: boolean;
  moderationCallbacks?: ModerationCallbacks;
}

interface VoicePanelRefs {
  panel?: HTMLElement | null;
  list?: HTMLElement | null;
  count?: HTMLElement | null;
  timer?: HTMLElement | null;
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  'linear-gradient(135deg, #ff6e7f 0%, #bfe9ff 100%)',
];

export const getAvatarColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }

  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
};

export class VoicePanelController {
  private panel: HTMLElement | null;

  private list: HTMLElement | null;

  private count: HTMLElement | null;

  private timer: HTMLElement | null;

  constructor({ panel, list, count, timer }: VoicePanelRefs) {
    this.panel = panel ?? null;
    this.list = list ?? null;
    this.count = count ?? null;
    this.timer = timer ?? null;

    if (this.timer) {
      this.updateSessionTimer(null);
    }
  }

  attach({ panel, list, count, timer }: VoicePanelRefs): void {
    if (panel !== undefined) this.panel = panel ?? null;
    if (list !== undefined) this.list = list ?? null;
    if (count !== undefined) this.count = count ?? null;
    if (timer !== undefined) this.timer = timer ?? null;
  }

  show(): void {
    if (this.panel) {
      this.panel.classList.remove('hidden');
    }
  }

  hide(): void {
    if (this.panel) {
      this.panel.classList.add('hidden');
    }
  }

  render(entries: VoicePanelEntry[], totalCount?: number): void {
    const list = this.list;
    if (!list) {
      return;
    }

    list.innerHTML = '';

    entries.forEach((entry) => {
      list.appendChild(this.createVoiceUserElement(entry));
    });

    if (this.count) {
      const countValue = totalCount ?? entries.length;
      this.count.textContent = String(countValue);
    }
  }

  updateSpeakingIndicator(id: string, speaking: boolean): void {
    if (!this.list) {
      return;
    }

    const item = this.list.querySelector(`[data-user-id="${id}"]`);
    if (item) {
        item.classList.toggle('speaking', speaking);
        item.classList.toggle('speaking-indicator', speaking);
      const avatarContainer = item.querySelector('.voice-user-avatar-container');
      if (avatarContainer) {
          avatarContainer.classList.toggle('speaking', speaking);
          avatarContainer.classList.toggle('speaking-indicator', speaking);
      }
    }
  }

  updateSessionTimer(display: string | null, title?: string): void {
    if (!this.timer) {
      return;
    }

    // Also toggle the parent timer group visibility
    const timerGroup = this.timer.parentElement;

    if (display) {
      this.timer.textContent = display;
      this.timer.classList.add('active');
      timerGroup?.classList.remove('hidden');
      if (title) {
        this.timer.title = title;
      } else {
        this.timer.removeAttribute('title');
      }
    } else {
      this.timer.textContent = '--:--';
      this.timer.classList.remove('active');
      timerGroup?.classList.add('hidden');
      this.timer.removeAttribute('title');
    }
  }

  private createVoiceUserElement(entry: VoicePanelEntry): HTMLElement {
    const item = document.createElement('div');
    item.className = 'voice-user-item flex flex-col gap-2 px-4 py-2 transition-fast cursor-pointer relative';
    if (entry.speaking) {
      item.classList.add('speaking-indicator');
      item.classList.add('speaking');
    }
    item.setAttribute('data-user-id', entry.id);

    const header = document.createElement('div');
    header.className = 'voice-user-header flex items-center gap-3';

    const avatarContainer = document.createElement('div');
    avatarContainer.className = 'relative flex-shrink-0';
    if (entry.speaking) {
      avatarContainer.classList.add('speaking-indicator');
      avatarContainer.classList.add('speaking');
    }

    const avatar = document.createElement('div');
    avatar.className = 'w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-sm';
    avatar.textContent = entry.name.charAt(0).toUpperCase();
    avatar.style.background = getAvatarColor(entry.name);

    const statusIndicator = document.createElement('div');
    statusIndicator.className = 'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-sidebar bg-success';

    avatarContainer.appendChild(avatar);
    avatarContainer.appendChild(statusIndicator);

    const userInfo = document.createElement('div');
    userInfo.className = 'flex-1 min-w-0';

    const userName = document.createElement('div');
    userName.className = 'text-sm font-medium text-text-normal truncate';
    userName.textContent = entry.isCurrentUser ? `${entry.name} (You)` : entry.name;

    userInfo.appendChild(userName);

    const rightSide = document.createElement('div');
    rightSide.className = 'flex items-center gap-1 flex-shrink-0';

    const iconsContainer = document.createElement('div');
    iconsContainer.className = 'flex items-center gap-1';

    if (entry.muted) {
      const mutedIcon = document.createElement('span');
      mutedIcon.className = 'text-xs opacity-70';
      mutedIcon.textContent = '🎤🚫';
      mutedIcon.title = 'Muted';
      iconsContainer.appendChild(mutedIcon);
    }

    if (entry.deafened) {
      const deafenedIcon = document.createElement('span');
      deafenedIcon.className = 'text-xs opacity-70';
      deafenedIcon.textContent = '🔇';
      deafenedIcon.title = 'Output muted';
      iconsContainer.appendChild(deafenedIcon);
    }

    if (entry.cameraEnabled) {
      const cameraIcon = document.createElement('span');
      cameraIcon.className = 'text-xs opacity-70';
      cameraIcon.textContent = '📹';
      cameraIcon.title = 'Camera on';
      iconsContainer.appendChild(cameraIcon);
    }

    if (entry.screenEnabled) {
      const screenIcon = document.createElement('span');
      screenIcon.className = 'text-xs opacity-70';
      screenIcon.textContent = '🖥️';
      screenIcon.title = 'Sharing screen';
      iconsContainer.appendChild(screenIcon);
    }

    header.appendChild(avatarContainer);
    header.appendChild(userInfo);

    if (iconsContainer.childElementCount > 0) {
      rightSide.appendChild(iconsContainer);
    }

    let controlElements: ReturnType<typeof this.createLocalControls> | null = null;

    if (entry.showLocalControls && !entry.isCurrentUser) {
      controlElements = this.createLocalControls(entry);
      if (controlElements?.muteButton) {
        rightSide.appendChild(controlElements.muteButton);
      }
    }

    if (rightSide.childElementCount > 0) {
      header.appendChild(rightSide);
    }

    item.appendChild(header);

    if (controlElements?.volumeRow) {
      item.appendChild(controlElements.volumeRow);
    }

    // Add moderation button if user can moderate and this is not the current user
    if (entry.canModerate && !entry.isCurrentUser && entry.moderationCallbacks) {
      this.addModerationMenu(item, entry);
    }

    return item;
  }

  private addModerationMenu(item: HTMLElement, entry: VoicePanelEntry): void {
    const modButton = document.createElement('button');
    modButton.type = 'button';
    modButton.className = 'voice-user-mod-btn';
    modButton.title = 'Moderation actions';
    modButton.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="5" r="1.5"></circle>
        <circle cx="12" cy="12" r="1.5"></circle>
        <circle cx="12" cy="19" r="1.5"></circle>
      </svg>
    `;

    let menuEl: HTMLElement | null = null;

    const closeMenu = () => {
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
      }
    };

    const showMenu = (event: MouseEvent) => {
      event.stopPropagation();

      // Close any existing menus
      document.querySelectorAll('.voice-mod-menu').forEach((m) => m.remove());

      menuEl = document.createElement('div');
      menuEl.className = 'voice-mod-menu';

      const menuItems: Array<{ label: string; icon: string; action: () => void; danger?: boolean }> = [
        {
          label: 'Kick from voice',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onKick?.(entry.id, entry.name);
          },
        },
        {
          label: 'Timeout 1 min',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onTimeout?.(entry.id, entry.name, 60 * 1000);
          },
        },
        {
          label: 'Timeout 5 min',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onTimeout?.(entry.id, entry.name, 5 * 60 * 1000);
          },
        },
        {
          label: 'Timeout 1 hour',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onTimeout?.(entry.id, entry.name, 60 * 60 * 1000);
          },
        },
        {
          label: 'Timeout 24 hours',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onTimeout?.(entry.id, entry.name, 24 * 60 * 60 * 1000);
          },
        },
      ];

      // Only add ban option if user has ban permission
      if (entry.moderationCallbacks?.onBan) {
        menuItems.push({
          label: 'Ban from server',
          icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M4.93 4.93l14.14 14.14"/>
          </svg>`,
          action: () => {
            closeMenu();
            entry.moderationCallbacks?.onBan?.(entry.id, entry.name);
          },
          danger: true,
        });
      }

      menuItems.forEach((menuItem) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `voice-mod-menu-item${menuItem.danger ? ' danger' : ''}`;
        btn.innerHTML = `${menuItem.icon}<span>${menuItem.label}</span>`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          menuItem.action();
        });
        menuEl?.appendChild(btn);
      });

      // Position menu
      const rect = modButton.getBoundingClientRect();
      menuEl.style.position = 'fixed';
      menuEl.style.top = `${rect.bottom + 4}px`;
      menuEl.style.right = `${window.innerWidth - rect.right}px`;

      document.body.appendChild(menuEl);

      // Close on outside click
      const handleOutsideClick = (e: MouseEvent) => {
        if (!menuEl?.contains(e.target as Node) && !modButton.contains(e.target as Node)) {
          closeMenu();
          document.removeEventListener('click', handleOutsideClick);
        }
      };
      setTimeout(() => document.addEventListener('click', handleOutsideClick), 0);

      // Close on escape
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          closeMenu();
          document.removeEventListener('keydown', handleEscape);
        }
      };
      document.addEventListener('keydown', handleEscape);
    };

    modButton.addEventListener('click', showMenu);

    // Add to the header (top right of user item)
    const header = item.querySelector('.voice-user-header');
    if (header) {
      header.appendChild(modButton);
    }
  }

  private createLocalControls(entry: VoicePanelEntry): {
    muteButton?: HTMLElement;
    volumeRow?: HTMLElement;
  } | null {
    const hasMuteControl = typeof entry.onLocalMuteToggle === 'function';
    const hasVolumeControl = typeof entry.onLocalVolumeChange === 'function';

    if (!hasMuteControl && !hasVolumeControl) {
      return null;
    }

    const controls: { muteButton?: HTMLElement; volumeRow?: HTMLElement } = {};

    if (hasMuteControl) {
      const muteButton = document.createElement('button');
      muteButton.type = 'button';
      muteButton.className = 'voice-user-control-btn mute';
      muteButton.setAttribute('aria-label', `Toggle local mute for ${entry.name}`);
      muteButton.setAttribute('aria-pressed', entry.localMuted ? 'true' : 'false');

      const setMuteState = (muted: boolean) => {
        muteButton.classList.toggle('active', muted);
        muteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
        muteButton.title = muted ? 'Locally muted – click to unmute' : 'Mute this user just for you';
        muteButton.textContent = muted ? '🙊' : '🔈';
      };

      setMuteState(Boolean(entry.localMuted));

      muteButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextMuted = muteButton.getAttribute('aria-pressed') !== 'true';
        const callback = entry.onLocalMuteToggle;

        if (!callback) {
          setMuteState(nextMuted);
          return;
        }

        try {
          const result = callback(nextMuted);
          setMuteState(nextMuted);
          Promise.resolve(result)
            .then((resolved) => {
              if (typeof resolved === 'boolean') {
                setMuteState(resolved);
              }
            })
            .catch((error) => {
              console.error('[VoicePanel] Failed to update local mute preference:', error);
              setMuteState(!nextMuted);
            });
        } catch (error) {
          console.error('[VoicePanel] Failed to update local mute preference:', error);
          setMuteState(!nextMuted);
        }
      });

      controls.muteButton = muteButton;
    }

    if (hasVolumeControl) {
      const sliderWrapper = document.createElement('div');
      sliderWrapper.className = 'voice-user-volume-wrapper';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'voice-user-volume-slider';
      slider.min = '0';
      slider.max = '200';
      slider.step = '1';
      const initialVolume = Math.max(0, Math.min(200, Math.round((entry.localVolume ?? 1) * 100)));
      slider.value = String(initialVolume);
      slider.setAttribute('aria-label', `Adjust ${entry.name}'s volume`);
      slider.title = `Volume: ${initialVolume}% (Drag past 100% for a boost)`;

      const volumeRow = document.createElement('div');
      volumeRow.className = 'voice-user-volume-row flex items-center gap-3 pl-11 pr-3 pb-1 text-xs text-text-muted';

      const volumeIcon = document.createElement('span');
      volumeIcon.className = 'voice-user-volume-icon text-base leading-none';

      const updateVolumeIcon = (value: number) => {
        if (value <= 0) {
          volumeIcon.textContent = '🔇';
        } else if (value < 60) {
          volumeIcon.textContent = '🔉';
        } else if (value <= 120) {
          volumeIcon.textContent = '🔊';
        } else {
          volumeIcon.textContent = '📢';
        }
      };

      updateVolumeIcon(initialVolume);

      const updateVolume = (value: number) => {
        const normalized = clampVolume(value);
        slider.title = `Volume: ${value}% (Drag past 100% for a boost)`;
        updateVolumeIcon(value);
        entry.onLocalVolumeChange?.(normalized);
      };

      slider.addEventListener('input', (event) => {
        event.stopPropagation();
        const value = Number((event.target as HTMLInputElement).value);
        updateVolume(value);
      });

      slider.addEventListener('change', (event) => {
        event.stopPropagation();
        const value = Number((event.target as HTMLInputElement).value);
        updateVolume(value);
      });

      sliderWrapper.appendChild(slider);
      volumeRow.appendChild(volumeIcon);
      volumeRow.appendChild(sliderWrapper);
      controls.volumeRow = volumeRow;
    }

    return controls;
  }
}

const clampVolume = (value: number): number => {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.max(0, Math.min(2, value / 100));
};
