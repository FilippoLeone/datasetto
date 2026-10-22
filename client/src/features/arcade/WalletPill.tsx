import { useEffect, useState } from 'preact/hooks';
import { Coins, Gift } from 'lucide-preact';
import { claimDaily, fetchWallet, refusalText } from './api';
import { arcadeWallet } from './state';

const chips = (n: number): string => n.toLocaleString() + ' chips';

/**
 * Play chips (platform.md §11.2): the balance, what sits at tables, and the daily claim. Play chips
 * have no value outside the Arcade. The first read creates the wallet with the starting chips.
 */
export const WalletPill = () => {
  const wallet = arcadeWallet.value;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 px-3" data-arcade-wallet>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-bright" title="Play chips: they have no value outside the Arcade">
        <Coins size={16} className="shrink-0 text-warning" />
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
