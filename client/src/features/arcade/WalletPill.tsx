import { useEffect, useId, useState } from 'preact/hooks';
import { Coins, Gift } from 'lucide-preact';
import { claimDaily, fetchWallet, refusalText } from './api';
import { arcadeWallet } from './state';

const chips = (n: number): string => n.toLocaleString() + ' chips';
const NO_VALUE = 'Play chips have no value outside the Arcade.';

/**
 * Play chips (platform.md §11.2): the balance, what sits at tables, and the daily claim. Play chips
 * have no value outside the Arcade. The first read creates the wallet with the starting chips.
 * `compact` is the sheet footer's form: "20,000 · +500 at tables · Daily chips". Screen readers hear
 * "20,000 chips" and the no-value note as the group's description.
 */
export const WalletPill = ({ compact = false }: { compact?: boolean }) => {
  const wallet = arcadeWallet.value;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const noteId = 'arcade-chips-' + useId().replace(/[^\w-]/g, '');

  useEffect(() => {
    if (arcadeWallet.peek()) return;
    let alive = true;
    void fetchWallet().then((answer) => {
      if (alive && answer.ok) arcadeWallet.value = { bal: answer.bal, esc: answer.esc, claim: answer.claim };
    });
    return () => {
      alive = false;
    };
  }, []);

  const claim = async () => {
    setBusy(true);
    const answer = await claimDaily();
    setBusy(false);
    if (!answer.ok) {
      setNote(refusalText(answer.code));
      return;
    }
    const current = arcadeWallet.peek();
    arcadeWallet.value = { bal: answer.bal, esc: current?.esc ?? 0, claim: false };
    setNote('+' + chips(answer.got));
  };

  if (compact) {
    return (
      <div role="group" aria-label="Play chips" aria-describedby={noteId} className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-1.5" data-arcade-wallet>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-bright" title={NO_VALUE}>
          <Coins size={14} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="truncate tabular-nums">
            {wallet ? wallet.bal.toLocaleString() : '…'}
            <span className="sr-only"> chips</span>
          </span>
          {wallet && wallet.esc > 0 && <span className="shrink-0 text-text-muted tabular-nums">+{wallet.esc.toLocaleString()} at tables</span>}
        </span>
        <span id={noteId} className="sr-only">
          {NO_VALUE}
        </span>
        {note && <span className="min-w-0 truncate text-xs text-text-muted">{note}</span>}
        {!note && wallet?.claim && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void claim()}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-semibold text-[#a3abff] hover:bg-hover disabled:opacity-50"
            data-arcade-claim
          >
            <Gift size={14} /> Daily chips
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 px-3" data-arcade-wallet>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-bright" title={NO_VALUE}>
        <Coins size={16} className="shrink-0 text-warning" aria-hidden="true" />
        <span className="truncate tabular-nums">{wallet ? chips(wallet.bal) : '…'}</span>
        {wallet && wallet.esc > 0 && <span className="shrink-0 text-xs text-text-muted tabular-nums">+{wallet.esc.toLocaleString()} at tables</span>}
      </span>
      {note && <span className="text-xs text-text-muted">{note}</span>}
      {wallet?.claim && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void claim()}
          className="flex min-h-11 items-center gap-1.5 rounded-full bg-brand px-3 text-xs font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
          data-arcade-claim
        >
          <Gift size={14} /> Daily chips
        </button>
      )}
    </div>
  );
};
