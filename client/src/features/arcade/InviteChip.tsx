import { X } from 'lucide-preact';
import { metaOf } from '@/arcade/catalog';
import { users } from '@/state/presence';
import { dismissInvite } from './bindings';
import { Chip, ChipAction, withShell } from './chip';
import type { ArcadeInvite } from './state';

/**
 * "Sam invites you to Fuseyard · Join · ×" (platform.md §9.2): passive, dismissible, and gone after
 * 60 s (the bindings' timer). No toast and no sound.
 */
export const InviteChip = ({ invite }: { invite: ArcadeInvite }) => {
  const from = users.value.find((user) => user.accountId === invite.from)?.displayName ?? 'Someone';
  return (
    <Chip label={from + ' invites you to ' + (metaOf(invite.game)?.name ?? invite.game)} data={{ 'data-arcade-invite': invite.id }}>
      <ChipAction label="Join" onClick={() => withShell((shell) => shell.acceptInvite(invite))} />
      <ChipAction label="Dismiss invite" onClick={() => dismissInvite(invite.id)}>
        <X size={14} />
      </ChipAction>
    </Chip>
  );
};
