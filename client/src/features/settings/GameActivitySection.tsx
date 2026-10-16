import { useState } from 'preact/hooks';
import { Gamepad2, Plus, RefreshCw, Trash2 } from 'lucide-preact';
import { Button, IconButton, Select, TextInput, Toggle } from '@/components';
import { listRunningProcesses } from '@/features/activity/desktopActivity';
import { addCustomGame, MAX_CUSTOM_GAMES, MAX_TITLE_LENGTH, removeCustomGame } from '@/features/activity/gameActivity';
import { catalogueSize, detectedGame, gameActivitySettings, updateGameActivitySettings } from '@/state/activity';
import { toast } from '@/state/ui';

/**
 * "Game activity" in the settings dialog, desktop app only (the dialog renders it when
 * the bridge supports it). The switch is off by default; what leaves the machine is the
 * matched title and nothing else. Changes apply at once, not through the dialog's Save.
 */
export const GameActivitySection = () => {
  const settings = gameActivitySettings.value;
  const detected = detectedGame.value;
  const known = catalogueSize.value;
  const [adding, setAdding] = useState(false);
  const [processes, setProcesses] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [exe, setExe] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadProcesses = async () => {
    setLoading(true);
    const list = await listRunningProcesses();
    setLoading(false);
    setProcesses(list ?? []);
    if (list === null) setError('The list of running programs could not be read.');
    else if (exe && !list.includes(exe)) setExe('');
  };

  const openAdd = () => {
    setAdding(true);
    setError(null);
    void loadProcesses();
  };

  const add = () => {
    const result = addCustomGame(settings.custom, exe, title);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    updateGameActivitySettings({ custom: result.custom });
    toast.success(result.replaced ? 'Game renamed' : 'Game added');
    setExe('');
    setTitle('');
    setError(null);
    setAdding(false);
  };

  const remove = (target: string) => {
    updateGameActivitySettings({ custom: removeCustomGame(settings.custom, target) });
  };

  const status = !settings.enabled ? 'Off. Nobody sees what you play.' : detected ? 'Playing ' + detected : 'No game from the list is running.';
  const options = [
    { value: '', label: loading ? 'Reading the running programs…' : processes && processes.length > 0 ? 'Pick a running program' : 'No programs to pick from' },
    ...(processes ?? []).map((name) => ({ value: name, label: name })),
  ];

  return (
    <section className="md:col-span-2" data-game-activity>
      <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Game activity</h3>
      <Toggle
        label="Show what I'm playing"
        description="Others see “Playing <game>” under your name while a game from our list, or one of your own entries, is running."
        checked={settings.enabled}
        onChange={(enabled) => {
          updateGameActivitySettings({ enabled });
          toast.info(enabled ? 'Game activity is on' : 'Game activity is off');
        }}
      />
      <p className="flex items-center gap-1.5 py-1 text-xs text-text-muted" data-activity-status>
        <Gamepad2 size={14} className={detected && settings.enabled ? 'text-success' : 'text-text-faint'} />
        <span>
          Right now: <span className="text-text-bright">{status}</span>
        </span>
      </p>
      <p className="text-xs text-text-faint">
        What leaves this machine: only the name of a game from our list, never your process list. The app reads the names of running programs every
        20 seconds the way Task Manager does; it opens no other program, injects nothing and installs no hooks, so anti-cheat systems see an ordinary
        app.{known > 0 ? ' The list knows ' + known + ' games.' : ''}
      </p>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-text-bright">Your own games</span>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={openAdd} disabled={settings.custom.length >= MAX_CUSTOM_GAMES}>
            <Plus size={14} /> Add a game
          </Button>
        )}
      </div>
      {settings.custom.length === 0 ? (
        <p className="py-1 text-xs text-text-faint">None yet. Add a game that is missing from the list: start it, pick its program here and give it a name.</p>
      ) : (
        <ul className="divide-y divide-border rounded-sm bg-base/60" data-custom-games>
          {settings.custom.map((entry) => (
            <li key={entry.exe} className="flex items-center gap-3 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text-bright">{entry.title}</span>
                <span className="block truncate font-mono text-[11px] text-text-faint">{entry.exe}</span>
              </span>
              <IconButton label={'Remove ' + entry.title} size="sm" onClick={() => remove(entry.exe)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="mt-2 rounded-sm bg-base/60 p-3" data-add-game>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Select label="Program" value={exe} options={options} disabled={loading} onChange={setExe} className="py-0" />
            </div>
            <IconButton label="Read the running programs again" size="md" className="mb-0.5" onClick={() => void loadProcesses()} disabled={loading}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : undefined} />
            </IconButton>
          </div>
          <label className="block py-2">
            <span className="mb-1.5 block text-sm font-medium text-text-bright">Shown as</span>
            <TextInput
              value={title}
              maxLength={MAX_TITLE_LENGTH}
              placeholder="Playing …"
              onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </label>
          {error && <p className="pb-2 text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={add} disabled={!exe || !title.trim()}>
              Add
            </Button>
          </div>
          <p className="mt-2 text-xs text-text-faint">The programs are read on this machine and shown only here. Start the game first, then pick it; Minecraft (Java) runs as javaw.exe, for example.</p>
        </div>
      )}
    </section>
  );
};
