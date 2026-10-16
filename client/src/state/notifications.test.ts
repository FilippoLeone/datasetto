import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_STATUS, describePushStatus, pushStatus, updatePushStatus, type PushStatus } from './notifications';

const status = (patch: Partial<PushStatus>): PushStatus => ({ ...DEFAULT_PUSH_STATUS, ...patch });
const ready = { supported: true, native: false, serverEnabled: true, permission: 'default' as const };

describe('push status', () => {
  beforeEach(() => {
    pushStatus.value = DEFAULT_PUSH_STATUS;
  });

  it('merges patches into the signal', () => {
    expect(pushStatus.value).toEqual(DEFAULT_PUSH_STATUS);
    updatePushStatus({ supported: true, permission: 'default' });
    updatePushStatus({ serverEnabled: true });
    expect(pushStatus.value).toEqual(status({ supported: true, permission: 'default', serverEnabled: true }));
    expect(updatePushStatus({ busy: true }).busy).toBe(true);
    expect(pushStatus.value.busy).toBe(true);
  });

  it('keeps the switch unavailable until the browser, the server and the permission allow it', () => {
    expect(describePushStatus(status({ ...ready, native: true, enabled: true }))).toMatchObject({ toggle: 'unavailable', label: 'Handled by the app', canTest: false });
    expect(describePushStatus(status({ ...ready, supported: false }))).toMatchObject({ toggle: 'unavailable', label: 'Not available in this browser' });
    expect(describePushStatus(status({ ...ready, serverEnabled: false }))).toMatchObject({ toggle: 'unavailable', label: 'Off on this server' });
    expect(describePushStatus(status({ ...ready, permission: 'denied' }))).toMatchObject({ toggle: 'unavailable', label: 'Blocked' });
    expect(describePushStatus(status({ ...ready, permission: 'denied' })).detail).toMatch(/browser settings/);
  });

  it('offers the switch when everything is in place and a test once it is on', () => {
    const off = describePushStatus(status(ready));
    expect(off).toMatchObject({ toggle: 'off', label: 'Off', canTest: false });
    expect(off.detail).toMatch(/ask for permission/);
    expect(describePushStatus(status({ ...ready, permission: 'granted' })).detail).not.toMatch(/ask for permission/);

    const on = describePushStatus(status({ ...ready, permission: 'granted', enabled: true }));
    expect(on).toMatchObject({ toggle: 'on', label: 'On for this device', canTest: true });
    // While something is in progress the view does not change; the component disables the switch itself.
    expect(describePushStatus(status({ ...ready, permission: 'granted', enabled: true, busy: true })).toggle).toBe('on');
  });
});
