import { useEffect, useState } from 'preact/hooks';
import { KeyRound, LogOut } from 'lucide-preact';
import { Button, Field, Modal, TextInput } from '@/components';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { serverConfig } from '@/services/ServerConfigService';
import { account } from '@/state/session';
import type { ServerError } from '@/types/protocol';

/**
 * Shown instead of the app after signing in with a temporary password set by
 * an admin. The server refuses everything else until a new password is saved.
 */
export const PasswordChangeScreen = () => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const minPassword = serverConfig.get()?.limits.passwordMinLength ?? 8;

  useEffect(
    () =>
      socketClient.on<ServerError>('account:error', (payload) => {
        setPending(false);
        setError(payload.message);
      }),
    [],
  );

  const submit = (event: Event) => {
    event.preventDefault();
    if (next.length < minPassword) return setError('The new password needs at least ' + minPassword + ' characters');
    if (next !== confirm) return setError('The new passwords do not match');
    if (next === current) return setError('Pick a password different from the temporary one');
    setError(null);
    setPending(true);
    api.updateAccount({ currentPassword: current, newPassword: next });
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-base p-safe">
      <Modal title="Set a new password" subtitle={'Hi ' + (account.value?.displayName ?? '') + '. An administrator gave you a temporary password; choose your own before continuing.'} size="sm">
        <form onSubmit={submit} noValidate>
          <Field label="Temporary password">
            <TextInput type="password" autoComplete="current-password" value={current} onInput={(e) => setCurrent((e.target as HTMLInputElement).value)} autoFocus required />
          </Field>
          <Field label="New password" hint={'At least ' + minPassword + ' characters.'}>
            <TextInput type="password" autoComplete="new-password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} required />
          </Field>
          <Field label="Confirm new password">
            <TextInput type="password" autoComplete="new-password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} required />
          </Field>
          {error && (
            <p role="alert" className="mt-1 rounded-sm bg-danger/15 px-3 py-2 text-sm text-[#fa777c]">
              {error}
            </p>
          )}
          <Button type="submit" block size="lg" className="mt-4" loading={pending} disabled={!current || !next || !confirm}>
            <KeyRound size={16} /> Save password
          </Button>
          <Button type="button" variant="ghost" block className="mt-2" onClick={() => api.logout()}>
            <LogOut size={16} /> Sign out
          </Button>
        </form>
      </Modal>
    </div>
  );
};
