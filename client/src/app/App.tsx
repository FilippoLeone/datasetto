import { useEffect, useRef } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { useBackClose } from '@/lib/backStack';
import { MOTION, usePresence } from '@/lib/motion';
import { ToastHost, UpdateNotice } from '@/components';
import { account, authStatus, canManage, isAuthenticated } from '@/state/session';
import { closeDrawers, isLandscapePhone, isMobile, isPhone, keyboardOpen, membersOpen, modal, openModal, showMembers, sidebarOpen } from '@/state/ui';
import { ConnectionBanner } from './ConnectionBanner';
import { Sidebar } from './layout/Sidebar';
import { MainArea } from './layout/MainArea';
import { MemberList } from './layout/MemberList';
import { MobileToolbar } from './layout/MobileToolbar';
import { ModalHost } from './ModalHost';
import { LightboxHost } from '@/features/chat/Lightbox';
import { AuthScreen } from '@/features/auth/AuthScreen';
import { PasswordChangeScreen } from '@/features/auth/PasswordChangeScreen';
import { openedOnAdminPath } from '@/features/admin/AdminModal';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { useDrawerSwipe } from './useDrawerSwipe';

/** A closed drawer is off screen: keep its controls out of the tab order and the accessibility tree. */
const useInert = (ref: { current: HTMLElement | null }, inert: boolean): void => {
  useEffect(() => {
    const node = ref.current as (HTMLElement & { inert?: boolean }) | null;
    if (!node) return;
    node.inert = inert;
    if (inert) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
  }, [ref, inert]);
};
export const App = () => {
  useGlobalShortcuts();
  useDrawerSwipe();

  useEffect(() => {
    if (!isMobile.value) closeDrawers();
  }, [isMobile.value]);

  // /app/admin opens the admin area once signed in (admins only; others just land in the app).
  const authed = isAuthenticated.value;
  useEffect(() => {
    if (authed && canManage.value && openedOnAdminPath() && modal.value?.type !== 'admin') openModal({ type: 'admin', tab: 'users' });
  }, [authed]);

  const authenticated = isAuthenticated.value;
  const mobile = isMobile.value;
  const phone = isPhone.value;
  // Held sideways: no bottom toolbar (the header has the same buttons), the content gets the height.
  const toolbar = phone && !isLandscapePhone.value && !keyboardOpen.value;
  // The member drawer and the dimmed backdrop stay mounted for their leave animation (lib/motion.ts).
  const memberDrawer = usePresence(authenticated && mobile && membersOpen.value, MOTION.slow);
  const backdrop = usePresence(authenticated && ((phone && sidebarOpen.value) || (mobile && membersOpen.value)), MOTION.fast);
  const sidebarRef = useRef<HTMLElement>(null);
  useInert(sidebarRef, authenticated && phone && !sidebarOpen.value);
  // The back button (Android, or the browser's on touch screens) closes an open drawer before anything else.
  useBackClose(authenticated && phone && sidebarOpen.value, () => (sidebarOpen.value = false));
  useBackClose(authenticated && mobile && membersOpen.value, () => (membersOpen.value = false));

  if (!authenticated) {
    return (
      <>
        <AuthScreen resuming={authStatus.value === 'resuming'} />
        <ConnectionBanner />
        <ToastHost />
        <UpdateNotice />
      </>
    );
  }

  if (account.value?.mustChangePassword) {
    return (
      <>
        <PasswordChangeScreen />
        <ConnectionBanner />
        <ToastHost />
        <UpdateNotice />
      </>
    );
  }

  return (
    <div className={cn('flex h-full w-full overflow-hidden bg-main safe-top safe-x', !toolbar && 'safe-bottom')}>
      {/* Sidebar: static on desktop and tablets, drawer on phones */}
      <aside
        ref={sidebarRef}
        className={cn(
          'flex h-full w-60 shrink-0 flex-col bg-sidebar',
          phone && 'fixed inset-y-0 left-0 z-40 w-[85vw] max-w-xs shadow-modal transition-transform duration-250 ease-out safe-top',
          // The bottom toolbar sits over the drawer: leave room for it so the profile row stays reachable.
          phone && (toolbar ? 'pb-toolbar' : 'safe-bottom'),
          phone && (sidebarOpen.value ? 'translate-x-0' : '-translate-x-full'),
        )}
        aria-label="Channels"
      >
        <Sidebar />
      </aside>

      <main className={cn('flex min-w-0 flex-1 flex-col', toolbar && 'pb-toolbar')}>
        <MainArea />
      </main>

      {mobile
        ? memberDrawer.mounted && (
            <aside
              data-state={memberDrawer.state}
              className={cn('motion-drawer-right fixed inset-y-0 right-0 z-40 flex h-full w-[85vw] max-w-xs shrink-0 flex-col bg-sidebar shadow-modal safe-top', toolbar ? 'pb-toolbar' : 'safe-bottom')}
              aria-label="Members"
            >
              <MemberList />
            </aside>
          )
        : showMembers.value && (
            <aside className="flex h-full w-60 shrink-0 flex-col bg-sidebar animate-view-in" aria-label="Members">
              <MemberList />
            </aside>
          )}

      {backdrop.mounted && (
        <button type="button" aria-label="Close panels" data-state={backdrop.state} className="motion-fade fixed inset-0 z-30 bg-overlay" onClick={closeDrawers} />
      )}

      {toolbar && <MobileToolbar />}
      <ModalHost />
      <LightboxHost />
      <ConnectionBanner />
      <ToastHost />
      <UpdateNotice />
    </div>
  );
};
