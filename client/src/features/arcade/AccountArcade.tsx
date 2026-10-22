import { useEffect, useState } from 'preact/hooks';
import { Toggle } from '@/components';
import { formatFullDate } from '@/lib/format';
import { CATALOG } from '@/arcade/catalog';
import type { GameId } from '@/arcade/runtime/types';
import { fetchPrefs, refusalText, savePrefs } from './api';
import { applyPrefs } from './bindings';
import { arcadeHidden } from './state';

/**
 * Profile › Arcade (platform.md §10.6, glimmerhall.md §15): "Hide Arcade" and a switch per game,
 * kept on the server for the account. It doubles as a self-exclusion from the slot machines, so
 * hiding applies at once and turning something back on waits 24 hours. A lazy chunk of its own.
 */
export const AccountArcade = () => {
  const prefs = arcadeHidden.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchPrefs().then((answer) => {
      if (alive && answer.ok) applyPrefs(answer);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next: { hidden?: boolean; games?: Partial<Record<GameId, boolean>> }) => {
    setBusy(true);
    const answer = await savePrefs(next);
    setBusy(false);
    if (!answer.ok) {
      setError(refusalText(answer.code));
      return;
    }
    setError(null);
    applyPrefs(answer);
  };

  const hidden = prefs?.hidden ?? false;
  return (
    <section className="mt-4" data-arcade-account>
      <p className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Arcade</p>
      <Toggle
        label="Hide Arcade"
        description="Hides every game, lobby, invite and badge for your account. It also keeps you away from the slot machines."
        checked={hidden}
        disabled={busy}
        onChange={(on) => void save({ hidden: on })}
      />
      {CATALOG.map((meta) => (
        <Toggle
          key={meta.id}
          label={meta.name}
          description={meta.tagline}
          checked={!hidden && prefs?.games[meta.id] !== false}
          disabled={busy || hidden}
          onChange={(on) => void save({ games: { [meta.id]: on } })}
        />
      ))}
      <p className="mt-1 text-xs text-text-faint">Hiding takes effect at once. Turning something back on takes effect after 24 hours.</p>
      {prefs?.reenableAt && (
        <p className="mt-1 text-xs text-[#ffd38a]" data-arcade-reenable>
          Turning this back on takes effect after 24 hours: on {formatFullDate(prefs.reenableAt)}.
        </p>
      )}
      {error && (
        <p className="mt-1 text-xs text-[#fa777c]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
