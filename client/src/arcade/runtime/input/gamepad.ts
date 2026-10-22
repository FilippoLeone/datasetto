/**
 * Gamepad source (standard mapping). No timers: `navigator.getGamepads()` is read once at creation and
 * then only from `sample()`, and only while a pad is known to be connected. All pads are merged.
 */
import { ACT, deadZone, dirBits, on, type Off } from './map';

/** Standard-mapping button index → bits: A 0; B 1 or 2; 3 swap; Back 8 map; Start 9 menu; D-pad 12–15. */
const BUTTONS: readonly number[] = [ACT.a, ACT.b, ACT.b, ACT.swap, 0, 0, 0, 0, ACT.map, ACT.menu, 0, 0, ACT.up, ACT.down, ACT.left, ACT.right];

const DEAD_ZONE = 0.3;

export interface PadState {
  bits: number;
  x: number;
  y: number;
}

const list = (): readonly (Gamepad | null)[] => {
  try {
    return navigator.getGamepads?.() ?? [];
  } catch {
    // Blocked by a permissions policy.
    return [];
  }
};

/** Returns the poll, which `sample()` calls once per tick. */
export const createGamepad = (offs: Off[]): (() => PadState) => {
  const known = new Set<number>();
  for (const p of list()) if (p) known.add(p.index);
  on<GamepadEvent>(window, 'gamepadconnected', (e) => known.add(e.gamepad?.index ?? 0), offs);
  on<GamepadEvent>(window, 'gamepaddisconnected', (e) => known.delete(e.gamepad?.index ?? 0), offs);
  offs.push(() => known.clear());
  const out: PadState = { bits: 0, x: 0, y: 0 };
  return () => {
    out.bits = out.x = out.y = 0;
    if (!known.size) return out;
    for (const p of list()) {
      if (!p || p.connected === false) continue;
      p.buttons.forEach((b, i) => {
        if (BUTTONS[i] && (b.pressed || b.value > 0.5)) out.bits |= BUTTONS[i];
      });
      const ax = p.axes[0] ?? 0;
      const ay = p.axes[1] ?? 0;
      const d = Math.hypot(ax, ay);
      const k = deadZone(d, DEAD_ZONE, 1);
      // The pad pushed furthest wins the stick.
      if (d * k > Math.hypot(out.x, out.y)) {
        out.x = ax * k;
        out.y = ay * k;
      }
    }
    out.bits |= dirBits(out.x, out.y);
    return out;
  };
};
