import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Bot } from 'lucide-preact';
import { Sheet } from '@/components';
import { isTouchPrimary } from '@/lib/device';
import { metaOf } from '@/arcade/catalog';
import { arcadeActivity, gameHidden, openArcade, type ActivityEntry } from './state';
import { GameIcon, offlineGames } from './ArcadeOverlay';

/** One line of the channel's activity: "Fuseyard · 2/4 · live". */
export const activityLabel = (entry: ActivityEntry): string => {
  const meta = metaOf(entry.g);
  const parts = [meta?.name ?? entry.g];
  if (entry.x) parts.push(entry.x);
  parts.push(entry.g === 'glimmer' ? entry.n + ' playing' : entry.n + '/' + entry.max);
  if (entry.st === 'live') parts.push('playing');
  else if (entry.st === 'dash') parts.push('Glimmer Dash');
  else parts.push('setting up');
  return parts.join(' · ');
};

const Popover = ({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose(): void; children: ComponentChildren }) => {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect();
    const width = 320;
    if (!rect) {
      setPos({ top: 64, left: Math.max(8, window.innerWidth - width - 8) });
      return;
    }
    setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
  }, [anchor]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Arcade"
      className="fixed z-[70] w-80 max-w-[calc(100vw-1rem)] rounded-lg bg-sidebar p-1 shadow-modal animate-pop"
      style={pos ? { top: pos.top + 'px', left: pos.left + 'px' } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
};

const Row = ({ icon, label, detail, onSelect, testId }: { icon: ComponentChildren; label: string; detail?: string; onSelect(): void; testId?: string }) => (
  <button type="button" onClick={onSelect} className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left hover:bg-hover active:bg-active" data-arcade-row={testId}>
    <span className="flex w-5 shrink-0 justify-center text-text-muted">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-text-bright">{label}</span>
      {detail && <span className="block truncate text-xs text-text-muted">{detail}</span>}
    </span>
  </button>
);

/**
 * The Arcade sheet (platform.md §10.6): a bottom sheet on touch screens, a popover elsewhere. It lists
 * this channel's games, "Start a game" and "Solo vs bots". Opening it changes nothing for anyone else.
 */
export const ArcadeSheet = ({ channelId, anchor, onClose }: { channelId: string | null; anchor: HTMLElement | null; onClose(): void }) => {
  const entries = (channelId ? (arcadeActivity.value.get(channelId) ?? []) : []).filter((entry) => !gameHidden(entry.g));
  const solo = offlineGames();
  const body = (
    <div className="flex flex-col py-1" data-arcade-sheet>
      {entries.length > 0 && (
        <>
          <p className="px-3 pt-1 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">In this channel</p>
          {entries.map((entry) => {
            const meta = metaOf(entry.g);
            return <Row key={entry.id} icon={meta ? <GameIcon icon={meta.icon} size={16} /> : null} label={activityLabel(entry)} onSelect={() => undefined} testId={'activity-' + entry.id} />;
          })}
        </>
      )}
      <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Solo vs bots</p>
      {solo.length === 0 ? (
        <p className="px-3 pb-2 text-sm text-text-muted">No games are ready yet.</p>
      ) : (
        <Row
          icon={<Bot size={16} />}
          label="Play on this device"
          detail="Practice chips; nothing is sent to the server"
          onSelect={() => {
            onClose();
            openArcade({ mode: 'local' });
          }}
          testId="solo"
        />
      )}
    </div>
  );
  if (isTouchPrimary()) {
    return (
      <Sheet title="Arcade" onClose={onClose}>
        {body}
      </Sheet>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose}>
      {body}
    </Popover>
  );
};
