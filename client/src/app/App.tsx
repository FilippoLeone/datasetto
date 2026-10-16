import { useEffect } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { ToastHost } from '@/components';
import { account, authStatus, connectionStatus, isAuthenticated } from '@/state/session';
import { closeDrawers, isMobile, isPhone, membersOpen, showMembers, sidebarOpen } from '@/state/ui';
import { Sidebar } from './layout/Sidebar';
import { MainArea } from './layout/MainArea';
import { MemberList } from './layout/MemberList';
import { MobileToolbar } from './layout/MobileToolbar';
import { ModalHost } from './ModalHost';
import { AuthScreen } from '@/features/auth/AuthScreen';
import { PasswordChangeScreen } from '@/features/auth/PasswordChangeScreen';
import { useGlobalShortcuts } from './useGlobalShortcuts';

const ConnectionBanner = () => {
  if (connectionStatus.value === 'connected') return null;
  const text = connectionStatus.value === 'connecting' ? 'Connecting to server…' : 'Connection lost. Reconnecting…';
  return (
    <div className="pointer-events-none fixed top-0 right-0 left-0 z-[55] flex justify-center safe-top">
      <div className="mt-2 rounded-full bg-warning px-3 py-1 text-xs font-semibold text-black shadow-pop animate-slide-up">{text}</div>
    </div>
  );
};

export const App = () => {
  useGlobalShortcuts();

  useEffect(() => {
    if (!isMobile.value) closeDrawers();
  }, [isMobile.value]);

  if (!isAuthenticated.value) {
    return (
      <>
        <AuthScreen resuming={authStatus.value === 'resuming'} />
        <ConnectionBanner />
        <ToastHost />
      </>
    );
  }

  if (account.value?.mustChangePassword) {
    return (
      <>
        <PasswordChangeScreen />
        <ConnectionBanner />
        <ToastHost />
      </>
    );
  }

  const mobile = isMobile.value;
  const phone = isPhone.value;
  const membersVisible = mobile ? membersOpen.value : showMembers.value;

  return (
    <div className={cn('flex h-full w-full overflow-hidden bg-main safe-top safe-x', !phone && 'safe-bottom')}>
      {/* Sidebar: static on desktop and tablets, drawer on phones */}
      <aside
        className={cn(
          'flex h-full w-60 shrink-0 flex-col bg-sidebar',
          phone && 'fixed inset-y-0 left-0 z-40 w-[85vw] max-w-xs shadow-modal transition-transform duration-200 safe-top safe-bottom',
          phone && (sidebarOpen.value ? 'translate-x-0' : '-translate-x-full'),
        )}
        aria-label="Channels"
      >
        <Sidebar />
      </aside>

      <main className={cn('flex min-w-0 flex-1 flex-col', phone && 'pb-toolbar')}>
        <MainArea />
      </main>

      {membersVisible && (
        <aside
          className={cn(
            'flex h-full w-60 shrink-0 flex-col bg-sidebar',
            mobile && 'fixed inset-y-0 right-0 z-40 w-[85vw] max-w-xs shadow-modal animate-fade-in safe-top safe-bottom',
          )}
          aria-label="Members"
        >
          <MemberList />
        </aside>
      )}

      {((phone && sidebarOpen.value) || (mobile && membersOpen.value)) && (
        <button type="button" aria-label="Close panels" className="fixed inset-0 z-30 bg-overlay animate-fade-in" onClick={closeDrawers} />
      )}

      {phone && <MobileToolbar />}
      <ModalHost />
      <ConnectionBanner />
      <ToastHost />
    </div>
  );
};
