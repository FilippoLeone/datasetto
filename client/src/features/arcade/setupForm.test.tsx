/**
 * The setup form (LobbyForm.tsx SetupForm): Bellwick's "Replaces" field shows only for a new tale
 * with every slot used, and then under the tales rather than under More options; each radio group
 * is one Tab stop whose arrow keys move between the choices and pick one.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultOptions } from '@/arcade/catalog';
import { meta as bellwick } from '@/arcade/bellwick/meta';
import { meta as fuseyard } from '@/arcade/fuseyard/meta';
import { SetupForm } from './LobbyForm';
import type { SlotInfo } from './setup';

const host = document.createElement('div');
document.body.appendChild(host);
afterEach(() => act(() => render(null, host)));

const slot = (n: number, updatedAt: number, inUse = false): SlotInfo => ({ slot: n, updatedAt, inUse });
const FULL = [slot(0, 10), slot(1, 20), slot(2, 30)];

const Harness = ({ meta, where, start, slots }: { meta: typeof bellwick; where: 'online' | 'offline'; start: Record<string, unknown>; slots?: readonly SlotInfo[] }) => {
  const [mode, setMode] = useState(meta.modes.find((m) => (where === 'online' ? m.online : m.offline))!.id);
  const [values, setValues] = useState(start);
  return <SetupForm meta={meta} where={where} mode={mode} values={values} slots={slots} onMode={setMode} onChange={(key, value) => setValues((old) => ({ ...old, [key]: value }))} />;
};

const show = (props: Parameters<typeof Harness>[0]) => {
  act(() => render(null, host));
  act(() => render(<Harness {...props} />, host));
};
const radios = (selector: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(selector + ' [role="radio"]'));
const checkedText = (selector: string) => radios(selector).find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? null;
const press = (key: string) =>
  act(() => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

describe('the Bellwick tale field', () => {
  it('asks which tale a new one replaces only when every slot is used, right under the tales', () => {
    show({ meta: bellwick, where: 'online', start: { slot: 'new', into: 0 }, slots: FULL });
    const into = host.querySelector('[data-arcade-field="into"]');
    expect(into).not.toBeNull();
    expect(host.querySelector('[data-arcade-more]')).toBeNull();
    expect(host.querySelector('[data-arcade-field="slot"]')?.nextElementSibling).toBe(into);
    expect(host.textContent).toContain('All slots are full: choose the tale it replaces');
  });

  it('shows no "Replaces" while no tale is picked, while the saves load, or when a slot is empty', () => {
    show({ meta: bellwick, where: 'online', start: { into: 0 }, slots: FULL });
    expect(host.querySelector('[data-arcade-field="into"]')).toBeNull();
    expect(checkedText('[data-arcade-field="slot"]')).toBeNull();
    // With no tale checked, Tab still reaches the list: its first free tale.
    expect(radios('[data-arcade-field="slot"]').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);

    show({ meta: bellwick, where: 'online', start: { slot: 'new', into: 0 } });
    expect(host.textContent).toContain('Looking up your tales');
    expect(host.querySelector('[data-arcade-field="into"]')).toBeNull();

    show({ meta: bellwick, where: 'online', start: { slot: 'new', into: 0 }, slots: [slot(0, 10)] });
    expect(host.querySelector('[data-arcade-field="into"]')).toBeNull();
    expect(host.textContent).toContain('It will be saved in Slot 2');
  });

  it('moves between the tales with the arrow keys, skipping one in use', () => {
    // Every slot is used here, so a new tale asks which one it replaces.
    show({ meta: bellwick, where: 'online', start: { slot: 0 }, slots: [slot(0, 10), slot(1, 20, true), slot(2, 30)] });
    const [first] = radios('[data-arcade-field="slot"]');
    act(() => first!.focus());
    press('ArrowDown');
    expect(checkedText('[data-arcade-field="slot"]')).toContain('Continue Slot 3');
    expect(document.activeElement?.getAttribute('data-arcade-slot')).toBe('2');
    press('ArrowDown');
    expect(document.activeElement?.getAttribute('data-arcade-slot')).toBe('new');
    expect(host.querySelector('[data-arcade-field="into"]')).not.toBeNull();
    press('ArrowDown');
    expect(document.activeElement?.getAttribute('data-arcade-slot')).toBe('0');
    expect(host.querySelector('[data-arcade-field="into"]')).toBeNull();
  });
});

describe('radio groups', () => {
  it('are one Tab stop, and the arrow keys, Home and End pick a choice', () => {
    show({ meta: fuseyard, where: 'offline', start: defaultOptions(fuseyard, 'brawl', 'offline') });
    const bots = '[data-arcade-field="bots"]';
    expect(radios(bots).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    act(() => radios(bots)[1]!.focus());
    press('ArrowRight');
    expect(checkedText(bots)).toContain('Menace');
    expect(radios(bots).map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    expect(document.activeElement).toBe(radios(bots)[2]);
    press('ArrowRight');
    expect(checkedText(bots)).toContain('Sprout');
    press('End');
    expect(checkedText(bots)).toContain('Menace');
    press('Home');
    expect(checkedText(bots)).toContain('Sprout');
    press('ArrowUp');
    expect(checkedText(bots)).toContain('Menace');

    // The mode cards too: Quickfire drops Wins from More options.
    const modes = '[role="radiogroup"][aria-label="Mode"]';
    act(() => radios(modes)[0]!.focus());
    press('ArrowDown');
    expect(checkedText(modes)).toContain('Quickfire');
    expect(host.querySelector('[data-arcade-more]')?.textContent).not.toContain('first to');
  });
});
