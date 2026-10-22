import type { ComponentChildren } from 'preact';
import { metaOf } from '@/arcade/catalog';
import { Chip, ChipAction, withShell } from './chip';
import { InviteChip } from './InviteChip';
import { arcadeActivity, arcadeHidden, arcadeInvites, arcadeLobby, arcadeSession, arcadeStage, gameEnabled, gameHidden, openArcade, type ActivityEntry } from './state';

/** "Fuseyard · 2/4", "Glimmerhall · Cobble 25/50 · 3 playing". */
export const activitySummary = (entry: ActivityEntry): string => {
  const parts = [metaOf(entry.g)?.name ?? entry.g];
  if (entry.x) parts.push(entry.x);
  parts.push(entry.g === 'glimmer' ? entry.n + ' playing' : entry.n + '/' + entry.max);
  return parts.join(' · ');
};

/** One of this channel's games: Join seat / Watch / Open, or your own lobby's state. */
export const LobbyChip = ({ entry }: { entry: ActivityEntry }) => {
  const meta = metaOf(entry.g);
  const lobby = arcadeLobby.value;
  const mine = lobby && lobby.id === entry.id ? lobby : null;
  const badge = entry.j ? (
    <span className="shrink-0 rounded-sm bg-warning/20 px-1.5 py-0.5 text-[11px] font-bold text-[#ffd38a]" title="Glimmer Pot won">
      Pot {entry.j.amt.toLocaleString()}
    </span>
  ) : null;
  let actions: ComponentChildren;
  if (mine?.st === 'live') actions = <ChipAction label="Open" onClick={() => withShell((shell) => shell.reopenStage())} />;
  else if (mine)
    actions = (
      <>
        <span className="shrink-0 px-1 text-text-muted">You're in</span>
        <ChipAction label="Leave" onClick={() => withShell((shell) => shell.leaveCurrent())} />
      </>
    );
  else
    actions = (
      <>
        {entry.n < entry.max && (
          <ChipAction label={entry.st === 'open' || entry.st === 'dash' ? 'Open' : 'Join seat'} onClick={() => withShell((shell) => shell.joinFromChip(entry.id, 'player'))} />
        )}
        {meta?.watch && <ChipAction label="Watch" onClick={() => withShell((shell) => shell.joinFromChip(entry.id, 'spectator'))} />}
      </>
    );
  return (
    <Chip label={activitySummary(entry)} badge={badge} data={{ 'data-arcade-chip': entry.id }}>
      {actions}
    </Chip>
  );
};

/**
 * The voice header's passive Arcade chips (platform.md §9.2, §10.6): this channel's games, the game
 * minimized on this screen ("Fuseyard running · Return") and your invites. They only ever appear:
 * no toast, no sound, no change of view. Nothing at all with Hide Arcade.
 */
export const ArcadeChips = ({ channelId }: { channelId: string }) => {
  if (arcadeHidden.value?.hidden) return null;
  const stage = arcadeStage.value;
  const session = arcadeSession.value;
  const chips: ComponentChildren[] = [];
  if (stage?.ch === channelId && session?.mode === 'remote' && session.id === stage.lobbyId && session.minimized) {
    chips.push(
      <Chip key="stage" label={(metaOf(stage.game)?.name ?? 'Game') + ' running'} ring={session.attention} data={{ 'data-arcade-chip': 'stage' }}>
        <ChipAction label="Return" onClick={() => openArcade({ mode: 'remote', game: stage.game, channelId })} />
      </Chip>,
    );
  }
  for (const entry of arcadeActivity.value.get(channelId) ?? []) {
    if (metaOf(entry.g) && !gameHidden(entry.g) && gameEnabled(entry.g) && stage?.lobbyId !== entry.id) chips.push(<LobbyChip key={entry.id} entry={entry} />);
  }
  for (const invite of arcadeInvites.value) if (!gameHidden(invite.game) && (!invite.ch || invite.ch === channelId)) chips.push(<InviteChip key={'invite:' + invite.id} invite={invite} />);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-2" data-arcade-chips>
      {chips}
    </div>
  );
};
