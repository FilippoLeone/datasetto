import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Gamepad2, RefreshCw, Wallet } from 'lucide-preact';
import { Button, Field, Select, TextArea, TextInput, Toggle } from '@/components';
import { formatFullDate } from '@/lib/format';
import { CATALOG, metaOf } from '@/arcade/catalog';
import type { GameId } from '@/arcade/runtime/types';
import {
  adminArcadeGet,
  adminArcadeUpdate,
  adminLedger,
  adminVoid,
  adminWalletReset,
  refusalText,
  type ArcadeAdminView,
  type ArcadeLimits,
  type ArcadeSettings,
  type LedgerRow,
  type SettingsField,
} from '@/features/arcade/api';
import { activitySummary } from '@/features/arcade/LobbyChip';
import { arcadeActivity } from '@/features/arcade/state';
import { channelsById } from '@/state/channels';
import { adminAccounts } from '@/state/misc';
import { toast } from '@/state/ui';

/** The limits as the server's schema bounds them (server/src/arcade/settings.ts). */
const LIMITS: readonly { key: keyof ArcadeLimits; label: string; min: number; max: number; scale?: number; unit?: string }[] = [
  { key: 'actionPerChannel', label: 'Action matches per voice channel', min: 0, max: 4 },
  { key: 'tablesPerChannel', label: 'Poker tables per voice channel', min: 0, max: 8 },
  { key: 'hallsPerChannel', label: 'Halls per voice channel', min: 0, max: 2 },
  { key: 'actionMatches', label: 'Action matches on the server', min: 0, max: 32 },
  { key: 'bellwickSessions', label: 'Bellwick sessions on the server', min: 0, max: 16 },
  { key: 'tables', label: 'Poker tables on the server', min: 0, max: 64 },
  { key: 'pokerBots', label: 'Poker bots on the server', min: 0, max: 32 },
  { key: 'spectatorsAction', label: 'Watchers per action match', min: 0, max: 8 },
  { key: 'spectatorsTable', label: 'Watchers per table', min: 0, max: 16 },
  { key: 'lobbyIdleMs', label: 'Unstarted lobby closes after', min: 1, max: 60, scale: 60_000, unit: 'minutes' },
  { key: 'egressKbps', label: 'Game traffic before slowing down', min: 100, max: 100_000, unit: 'kbit/s' },
  { key: 'lanePerIp', label: 'Game connections per IP address', min: 1, max: 64 },
  { key: 'hallMembers', label: 'Players per hall', min: 1, max: 32 },
  { key: 'dashes', label: 'Glimmer Dashes at once', min: 0, max: 16 },
];

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(n)));

const NumberField = ({ label, value, min, max, step, hint, onChange }: { label: string; value: number; min: number; max: number; step?: number; hint?: string; onChange(n: number): void }) => (
  <Field label={label} hint={hint}>
    <TextInput
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step ?? 1}
      value={String(value)}
      onChange={(event) => {
        const n = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(n)) onChange(step && step < 1 ? Math.max(min, Math.min(max, n)) : clamp(n, min, max));
      }}
    />
  </Field>
);

const Card = ({ title, children }: { title: string; children: ComponentChildren }) => (
  <section className="rounded-md bg-base/60 p-3">
    <p className="mb-1 text-sm font-semibold text-text-bright">{title}</p>
    {children}
  </section>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 rounded-sm bg-sidebar px-3 py-2">
    <p className="truncate text-xs text-text-muted">{label}</p>
    <p className="text-lg font-bold text-text-bright tabular-nums">{value}</p>
  </div>
);

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The top-level settings that changed, with only the changed limits. */
const changes = (before: ArcadeSettings, after: ArcadeSettings): Parameters<typeof adminArcadeUpdate>[0] => {
  const out: Record<string, unknown> = {};
  for (const key of ['enabled', 'games', 'startChips', 'claimFloor', 'claimMin', 'serverBots', 'gameSettings'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  const limits: Partial<ArcadeLimits> = {};
  for (const { key } of LIMITS) if (before.limits[key] !== after.limits[key]) limits[key] = after.limits[key];
  if (Object.keys(limits).length > 0) out.limits = limits;
  return out as Parameters<typeof adminArcadeUpdate>[0];
};

/** A table game's own setting, drawn by kind (number, toggle, JSON). */
const GameField = ({ field, value, onChange, onInvalid }: { field: SettingsField; value: unknown; onChange(v: unknown): void; onInvalid(bad: boolean): void }) => {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState(false);
  if (field.kind === 'toggle') return <Toggle label={field.label} description={field.help} checked={value === true} onChange={onChange} />;
  if (field.kind === 'number') return <NumberField label={field.label} hint={field.help} value={typeof value === 'number' ? value : field.min} min={field.min} max={field.max} step={field.step} onChange={onChange} />;
  return (
    <Field label={field.label} hint={field.help} error={bad ? 'Not valid JSON' : null}>
      <TextArea
        className="font-mono text-xs"
        value={text}
        spellcheck={false}
        onInput={(event) => {
          const next = (event.target as HTMLTextAreaElement).value;
          setText(next);
          try {
            onChange(JSON.parse(next));
            setBad(false);
            onInvalid(false);
          } catch {
            setBad(true);
            onInvalid(true);
          }
        }}
      />
    </Field>
  );
};

/** Reset a wallet to the starting chips, and the account's last 100 ledger rows. */
const WalletTools = () => {
  const accounts = adminAccounts.value.filter((entry) => entry.status !== 'deleted');
  const [accountId, setAccountId] = useState('');
  const [armed, setArmed] = useState(false);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const chosen = accountId || accounts[0]?.id || '';
  const reset = async () => {
    setArmed(false);
    const answer = await adminWalletReset(chosen);
    setNote(answer.ok ? 'Balance is now ' + answer.bal.toLocaleString() + ' chips.' : refusalText(answer.code));
    if (answer.ok && rows) void ledger();
  };
  const ledger = async () => {
    const answer = await adminLedger(chosen);
    if (answer.ok) setRows(answer.rows);
    else setNote(refusalText(answer.code));
  };
  return (
    <Card title="Wallets">
      <Select
        label="Account"
        value={chosen}
        options={accounts.map((entry) => ({ value: entry.id, label: entry.displayName + ' (' + entry.username + ')' }))}
        onChange={(id) => {
          setAccountId(id);
          setRows(null);
          setNote(null);
          setArmed(false);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!chosen} onClick={() => void ledger()}>
          <Wallet size={14} /> Show ledger
        </Button>
        {armed ? (
          <Button size="sm" variant="danger" onClick={() => void reset()} data-arcade-reset-confirm>
            Reset to the starting chips
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={!chosen} onClick={() => setArmed(true)}>
            Reset wallet
          </Button>
        )}
      </div>
      {note && <p className="mt-2 text-xs text-text-muted">{note}</p>}
      {rows && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="py-1 font-medium">When</th>
                <th className="py-1 font-medium">Kind</th>
                <th className="py-1 font-medium">Ref</th>
                <th className="py-1 text-right font-medium">Change</th>
                <th className="py-1 text-right font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-1 whitespace-nowrap text-text-faint">{formatFullDate(row.at)}</td>
                  <td className="py-1">{row.kind}</td>
                  <td className="max-w-40 truncate py-1 text-text-muted">{row.ref ?? '—'}</td>
                  <td className="py-1 text-right tabular-nums">{(row.delta > 0 ? '+' : '') + row.delta.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{row.after.toLocaleString()}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-text-muted">
                    No chip movements yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

/** End a running game or table (refunds what sits in it). */
const RunningGames = () => {
  const [armed, setArmed] = useState<string | null>(null);
  const games = [...arcadeActivity.value].flatMap(([ch, list]) => list.map((entry) => ({ ch, entry })));
  return (
    <Card title="Running now">
      {games.length === 0 ? (
        <p className="text-sm text-text-muted">No games are running in channels you can see.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {games.map(({ ch, entry }) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-text-bright">
                {activitySummary(entry)} <span className="text-text-muted">in {channelsById.value.get(ch)?.name ?? 'a voice channel'}</span>
              </span>
              <Button
                size="sm"
                variant={armed === entry.id ? 'danger' : 'ghost'}
                onClick={() => {
                  if (armed !== entry.id) return setArmed(entry.id);
                  setArmed(null);
                  void adminVoid(entry.id).then((answer) => (answer.ok ? toast.success('Game ended') : toast.error(refusalText(answer.code))));
                }}
              >
                {armed === entry.id ? 'End it now' : 'End game'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

/**
 * Admin › Arcade (platform.md §11.4): switch the Arcade and each game on or off, the play-chip
 * numbers, server bots, the limits, each table game's own settings, live load figures, and the
 * wallet tools. Turning a game off ends its rooms and refunds what sits in them.
 */
export const ArcadeSection = () => {
  const [view, setView] = useState<ArcadeAdminView | null>(null);
  const [draft, setDraft] = useState<ArcadeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});

  const refresh = async (full: boolean) => {
    const answer = await adminArcadeGet();
    if (!answer.ok) return setError(refusalText(answer.code));
    setError(null);
    setView((prev) => (prev && !full ? { ...prev, stats: answer.stats } : answer));
  };
  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!view) return <p className="text-sm text-text-muted">{error ?? 'Loading Arcade settings…'}</p>;
  const settings = draft ?? view.settings;
  const set = (patch: Partial<ArcadeSettings>) => setDraft({ ...settings, ...patch });
  const setGameSetting = (game: 'lamplight' | 'glimmer', key: string, value: unknown) =>
    set({ gameSettings: { ...settings.gameSettings, [game]: { ...record(settings.gameSettings[game]), [key]: value } } });
  const dirty = draft !== null && Object.keys(changes(view.settings, draft)).length > 0;
  const blocked = Object.values(invalid).some(Boolean);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const answer = await adminArcadeUpdate(changes(view.settings, draft));
    setSaving(false);
    if (!answer.ok) return setError(refusalText(answer.code));
    setError(null);
    setView({ ...view, settings: answer.settings });
    setDraft(null);
    toast.success('Arcade settings saved');
  };

  const stats = view.stats;
  const fieldGroups = Object.entries(view.fields) as ['lamplight' | 'glimmer', SettingsField[]][];

  return (
    <div className="flex flex-col gap-4" data-arcade-admin>
      <Card title="Load right now">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Action matches" value={String(stats.matches)} />
          <Stat label="Game connections" value={String(stats.lanes)} />
          <Stat label="Load level" value={stats.level === 0 ? 'Normal' : 'Slowed ' + stats.level} />
          <Stat label="Loop delay p99" value={stats.loopP99Ms !== undefined ? Math.round(stats.loopP99Ms) + ' ms' : '—'} />
          <Stat label="Game traffic" value={stats.egressKbps !== undefined ? Math.round(stats.egressKbps) + ' kbit/s' : '—'} />
        </div>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void refresh(false)}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </Card>

      <Card title="Games">
        <Toggle label="Arcade" description="Off hides the Arcade from everyone on this server (solo play on a device still works)." checked={settings.enabled} onChange={(enabled) => set({ enabled })} />
        {CATALOG.map((meta) => (
          <Toggle
            key={meta.id}
            label={meta.name}
            description={view.available[meta.id] === false ? 'Not built into this server yet' : 'Turning it off ends its games and refunds what sits in them'}
            checked={settings.games[meta.id] !== false}
            disabled={!settings.enabled}
            onChange={(on) => set({ games: { ...settings.games, [meta.id]: on } as Record<GameId, boolean> })}
          />
        ))}
      </Card>

      <Card title="Play chips">
        <div className="grid gap-x-3 sm:grid-cols-3">
          <NumberField label="Starting chips" value={settings.startChips} min={0} max={10_000_000} onChange={(startChips) => set({ startChips })} />
          <NumberField label="Daily claim tops up to" value={settings.claimFloor} min={0} max={10_000_000} onChange={(claimFloor) => set({ claimFloor })} />
          <NumberField label="Daily claim at least" value={settings.claimMin} min={0} max={10_000_000} onChange={(claimMin) => set({ claimMin })} />
        </div>
        <p className="text-xs text-text-faint">Once a day an account may claim the larger of the minimum and what tops it up to the floor. Chips have no value outside the Arcade.</p>
        <Toggle label="Server bots" description="Poker bots fill the low-stakes cash tables" checked={settings.serverBots} onChange={(serverBots) => set({ serverBots })} />
      </Card>

      <Card title="Limits">
        <div className="grid gap-x-3 sm:grid-cols-2">
          {LIMITS.map((limit) => (
            <NumberField
              key={limit.key}
              label={limit.label + (limit.unit ? ' (' + limit.unit + ')' : '')}
              value={Math.round(settings.limits[limit.key] / (limit.scale ?? 1))}
              min={limit.min}
              max={limit.max}
              onChange={(n) => set({ limits: { ...settings.limits, [limit.key]: n * (limit.scale ?? 1) } })}
            />
          ))}
        </div>
      </Card>

      {fieldGroups.map(([game, fields]) => (
        <Card key={game} title={(metaOf(game)?.name ?? game) + ' settings'}>
          {fields.map((field) => (
            <GameField
              key={game + ':' + field.key}
              field={field}
              value={record(settings.gameSettings[game])[field.key]}
              onChange={(value) => setGameSetting(game, field.key, value)}
              onInvalid={(bad) => setInvalid((prev) => ({ ...prev, [game + ':' + field.key]: bad }))}
            />
          ))}
        </Card>
      ))}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-md bg-main/95 py-2">
        {error && (
          <p className="text-sm text-[#fa777c]" role="alert">
            {error}
          </p>
        )}
        <span className="flex-1" />
        <Button variant="ghost" disabled={!draft} onClick={() => setDraft(null)}>
          Discard
        </Button>
        <Button disabled={!dirty || blocked} loading={saving} onClick={() => void save()} data-arcade-admin-save>
          <Gamepad2 size={16} /> Save Arcade settings
        </Button>
      </div>

      <RunningGames />
      <WalletTools />
    </div>
  );
};
