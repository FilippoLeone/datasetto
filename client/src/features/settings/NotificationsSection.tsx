import { useEffect, useState } from 'preact/hooks';
import { BellRing } from 'lucide-preact';
import { Button, Toggle } from '@/components';
import { disablePush, enablePush, refreshPushStatus, sendTestNotification } from '@/services/pushNotifications';
import { describePushStatus, pushStatus } from '@/state/notifications';
import { toast } from '@/state/ui';

/**
 * "Notifications" in the settings dialog: one switch per browser for Web Push, the
 * current state in words, and a test button once it is on. Changes apply at once
 * (they are not part of the dialog's Save).
 */
export const NotificationsSection = () => {
  const status = pushStatus.value;
  const view = describePushStatus(status);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void refreshPushStatus();
  }, []);

  const toggle = async (next: boolean) => {
    if (next) {
      if (await enablePush()) toast.success('Notifications are on for this device');
      else if (pushStatus.value.permission === 'denied') toast.warning('Notifications are blocked for this site in the browser settings');
      return;
    }
    await disablePush();
    toast.info('Notifications are off for this device');
  };

  const test = async () => {
    setTesting(true);
    const error = await sendTestNotification();
    setTesting(false);
    if (error) toast.error(error);
    else toast.info('Test notification sent. Switch to another window to see it arrive.');
  };

  return (
    <section className="md:col-span-2">
      <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Notifications</h3>
      <Toggle
        label="Notify me on this device"
        description={view.detail}
        checked={view.toggle === 'on'}
        disabled={view.toggle === 'unavailable' || status.busy}
        onChange={(next) => void toggle(next)}
      />
      <div className="flex items-center justify-between gap-3 py-1 text-xs text-text-muted">
        <span>
          Status: <span className="text-text-bright">{view.label}</span>
          {status.busy && ' (working…)'}
        </span>
        {view.canTest && (
          <Button size="sm" variant="secondary" loading={testing} onClick={() => void test()}>
            <BellRing size={14} /> Send a test
          </Button>
        )}
      </div>
      {status.error && <p className="py-1 text-xs text-danger">{status.error}</p>}
      <p className="text-xs text-text-faint">
        Applies at once, per browser. Direct messages and @mentions are pushed only while none of your windows shows the app, at most once per
        conversation every 30 seconds.
      </p>
    </section>
  );
};
