import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Field, Modal, TextInput } from '@/components';
import { cn } from '@/lib/cn';
import { api } from '@/services/socket/api';
import { serverConfig } from '@/services/ServerConfigService';
import { authError, authStatus, connectionStatus } from '@/state/session';
import { closeModal } from '@/state/ui';

type Mode = 'login' | 'register';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AuthModalProps {
  initialMode: Mode;
  dismissable: boolean;
}

export const AuthModal = ({ initialMode, dismissable }: AuthModalProps) => {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const registration = serverConfig.registrationMode();
  const minPassword = serverConfig.get()?.limits.passwordMinLength ?? 8;
  const pending = authStatus.value === 'pending';
  const offline = connectionStatus.value !== 'connected';
  const error = localError ?? authError.value;

  // Switching between sign-in and register clears stale errors, but the first render must keep
  // a server-provided reason (account disabled, banned, session expired) visible.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    authError.value = null;
    setLocalError(null);
  }, [mode]);

  const submit = (event: Event) => {
    event.preventDefault();
    if (pending || offline) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) return setLocalError('Enter a valid email address');
    if (password.length < minPassword) return setLocalError('Password must be at least ' + minPassword + ' characters');
    if (mode === 'register') {
      if (password !== confirm) return setLocalError('Passwords do not match');
      if (registration === 'closed') return setLocalError('Registration is closed on this server');
      if (registration === 'invite' && !inviteCode.trim()) return setLocalError('An invite code is required');
    }
    setLocalError(null);
    authError.value = null;
    authStatus.value = 'pending';
    if (mode === 'login') api.login(normalizedEmail, password);
    else api.register({ username: normalizedEmail, password, displayName: displayName.trim() || undefined, inviteCode: inviteCode.trim() || undefined });
  };

  const tabs = (
    <div className="mb-4 flex rounded-md bg-base p-1" role="tablist">
      {(['login', 'register'] as Mode[]).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => setMode(value)}
          className={cn('flex-1 rounded-sm py-1.5 text-sm font-medium transition-colors', mode === value ? 'bg-active text-text-bright' : 'text-text-muted hover:text-text')}
        >
          {value === 'login' ? 'Sign in' : 'Create account'}
        </button>
      ))}
    </div>
  );

  return (
    <Modal
      title={mode === 'login' ? 'Welcome back' : 'Join the server'}
      subtitle={
        mode === 'login'
          ? 'Sign in with the email you registered with.'
          : registration === 'closed'
            ? 'Registration is closed. Ask the server owner for an account.'
            : registration === 'invite'
              ? 'You need an invite code from the server owner.'
              : 'Pick an email and a password. The first account becomes admin.'
      }
      onClose={dismissable ? closeModal : undefined}
      size="sm"
    >
      <form onSubmit={submit} noValidate>
        {tabs}
        <Field label="Email">
          <TextInput type="email" autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="name@example.com" required />
        </Field>
        <Field label="Password" hint={mode === 'register' ? 'At least ' + minPassword + ' characters.' : undefined}>
          <TextInput
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </Field>
        {mode === 'register' && (
          <>
            <Field label="Confirm password">
              <TextInput type="password" autoComplete="new-password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} required />
            </Field>
            <Field label="Display name" hint="Shown in chat and voice. Defaults to your email prefix.">
              <TextInput type="text" maxLength={50} value={displayName} onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)} />
            </Field>
            {registration === 'invite' && (
              <Field label="Invite code">
                <TextInput type="text" autoComplete="off" spellcheck={false} value={inviteCode} onInput={(e) => setInviteCode((e.target as HTMLInputElement).value)} required />
              </Field>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="mt-1 rounded-sm bg-danger/15 px-3 py-2 text-sm text-[#fa777c]">
            {error}
          </p>
        )}
        <Button type="submit" block size="lg" className="mt-4" loading={pending} disabled={offline || (mode === 'register' && registration === 'closed')}>
          {offline ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </Modal>
  );
};
