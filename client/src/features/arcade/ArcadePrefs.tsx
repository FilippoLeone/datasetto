import { useEffect, useState } from 'preact/hooks';
import { Slider, Spinner, Toggle } from '@/components';
import { isTouchPrimary } from '@/lib/device';
import type { ArcadePrefs as DevicePrefs } from '@/arcade/runtime/types';
import { useLazy } from './lazy';
import { Pills } from './LobbyForm';

const loadPrefsModule = () => import('@/arcade/runtime/prefs');

/** Vibration and the touch controls: only where a finger is the pointer. */
const TouchPrefs = ({ prefs, update }: { prefs: DevicePrefs; update(patch: Partial<DevicePrefs>): void }) => (
  <>
    <Toggle label="Vibration" description="A short buzz on the touch buttons (Android)" checked={prefs.vibrate} onChange={(vibrate) => update({ vibrate })} />
    <div className="flex flex-col gap-1.5 py-2">
      <span className="text-sm font-medium text-text-bright">Touch movement</span>
      <Pills
        label="Touch movement"
        choices={[
          { value: 'float', label: 'Floating stick' },
          { value: 'dpad', label: 'D-pad' },
        ]}
        value={prefs.stick}
        onPick={(v) => update({ stick: v === 'dpad' ? 'dpad' : 'float' })}
      />
    </div>
    <div className="flex flex-col gap-1.5 py-2">
      <span className="text-sm font-medium text-text-bright">Touch button size</span>
      <Pills
        label="Touch button size"
        choices={[
          { value: 56, label: 'Smaller' },
          { value: 76, label: 'Larger' },
        ]}
        value={prefs.buttonPx}
        onPick={(v) => update({ buttonPx: v === 56 ? 56 : 76 })}
      />
    </div>
  </>
);

/**
 * Game settings for this device (platform.md §10.6, `datasetto.arcade.prefs.v1`): volume (below
 * voice by default, since speaker sound leaks into the mic), music, battery saver, and on touch
 * screens vibration and the touch controls.
 */
export const ArcadePrefs = () => {
  const mod = useLazy(loadPrefsModule);
  const [prefs, setPrefs] = useState<DevicePrefs | null>(null);
  useEffect(() => {
    if (mod) setPrefs(mod.loadPrefs());
  }, [mod]);
  if (!mod || !prefs) return <Spinner size={20} />;
  const update = (patch: Partial<DevicePrefs>) => setPrefs(mod.savePrefs(patch));
  return (
    <div className="flex flex-col gap-1 px-3 py-1" data-arcade-prefs>
      <Slider label="Game volume" value={Math.round(prefs.volume * 100)} min={0} max={100} step={5} format={(v) => v + '%'} onChange={(v) => update({ volume: v / 100 })} />
      <Toggle label="Music" description="Off by default while you are in a call" checked={prefs.music} onChange={(music) => update({ music })} />
      {isTouchPrimary() && <TouchPrefs prefs={prefs} update={update} />}
      <Toggle label="Battery saver" description="Draw fewer frames in the busiest games" checked={prefs.batterySaver} onChange={(batterySaver) => update({ batterySaver })} />
    </div>
  );
};
