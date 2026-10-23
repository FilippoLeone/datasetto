import { Bomb, Coins, Play, SlidersHorizontal, Spade, Sword } from 'lucide-preact';
import { Spinner } from '@/components';
import { cn } from '@/lib/cn';
import type { GameMeta } from '@/arcade/catalog';

export const GameIcon = ({ icon, size = 20 }: { icon: GameMeta['icon']; size?: number }) =>
  icon === 'cards' ? <Spade size={size} /> : icon === 'coins' ? <Coins size={size} /> : icon === 'bomb' ? <Bomb size={size} /> : <Sword size={size} />;

/**
 * One game in the solo catalogue and the sheet's start list (platform.md §10.6): the whole card plays
 * the remembered (or default) setup at once; the Options button beside it opens the setup screen,
 * and only shows when there is something to choose.
 */
export const GameCard = ({
  meta,
  summary,
  onPlay,
  onOptions,
  busy = false,
  disabled = false,
  data,
  className,
}: {
  meta: GameMeta;
  /** The resolved setup: "Cash table · Pebble 5/10". */
  summary: string;
  onPlay(): void;
  onOptions?: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Test hooks on the main button (`data-arcade-tile`, `data-arcade-row`). */
  data?: Record<string, string>;
  /** The card's background (default `bg-sidebar`; the sheet, itself `bg-sidebar`, passes a darker one). */
  className?: string;
}) => (
  <div className={cn('flex min-h-18 items-center rounded-lg', className ?? 'bg-sidebar')} data-arcade-card={meta.id}>
    <button
      type="button"
      onClick={onPlay}
      disabled={disabled || busy}
      aria-label={'Play ' + meta.name + ': ' + summary.split(' · ').join(', ')}
      className="flex min-h-18 min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg p-3 text-left transition-colors enabled:hover:bg-hover enabled:active:bg-active disabled:opacity-60"
      {...data}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-elevated text-text-bright">
        <GameIcon icon={meta.icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-5 font-semibold text-text-bright">{meta.name}</span>
        <span className="block truncate text-xs text-text-muted">{meta.tagline}</span>
        <span className="block truncate text-xs font-medium text-[#a3abff]">{summary}</span>
      </span>
      <span className="flex w-5 shrink-0 justify-center text-text-muted">{busy ? <Spinner size={16} /> : <Play size={16} />}</span>
    </button>
    {onOptions && (
      <button
        type="button"
        onClick={onOptions}
        disabled={disabled || busy}
        aria-label={'Options for ' + meta.name}
        title={'Options for ' + meta.name}
        className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors enabled:hover:bg-hover enabled:hover:text-text-bright disabled:opacity-60"
        data-arcade-options={meta.id}
      >
        <SlidersHorizontal size={18} />
      </button>
    )}
  </div>
);
