import { useState } from 'preact/hooks';
import { Gamepad2, Headphones, HeadphoneOff, MessageCircle, Mic, MicOff, MonitorUp, Phone, PhoneOff, RefreshCw, Settings, Video, VideoOff, Volume2, VolumeX } from 'lucide-preact';
import { Avatar, Button, IconButton, Menu, type MenuItem } from '@/components';
import { cn } from '@/lib/cn';
import { canCaptureScreen } from '@/lib/device';
import { MOTION, useListPresence, type PresenceState } from '@/lib/motion';
import { useElementSize } from '@/lib/useElementSize';
import { peerAccountId, peerAudioPref, setPeerAudioPref, volumePercent } from '@/state/peerAudio';
import { usersById, usersInVoice } from '@/state/presence';
import { screenAudioPref, screenHostKey, setScreenAudioPref } from '@/state/screenAudio';
import { OWN_SHARE_CLIP_KEY, voiceClipKey } from '@/features/clips/clipKeys';
import { tileClipControls } from '@/features/clips/tileClip';
import { account, can, socketId } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { isLandscapePhone, isMobile, openModal } from '@/state/ui';
import { minigameState } from '@/state/misc';
import {
  anyVideoActive,
  localCameraStream,
  localDeafened,
  localMuted,
  localScreenStream,
  localSpeaking,
  peerList,
  pttPressed,
  remoteScreenClipsAllowed,
  remoteVideo,
  voiceChannelId,
  voicePeers,
  voiceStatus,
  type VoicePeer,
} from '@/state/voice';
import { api } from '@/services/socket/api';
import { PeerVolumePanel } from './PeerVolumePanel';
import { VideoTile, type TileAudioControls } from './VideoTile';
import { VIDEO_GRID_GAP, videoGridLayout } from './videoGrid';
import { useVoiceTimer } from './VoiceDock';
import { voiceManager } from './voiceManager';
import { MinigamePanel } from '@/features/minigames/MinigamePanel';
import type { Channel } from '@/types/protocol';

const PeerTile = ({ peer, isMe, state }: { peer: VoicePeer; isMe: boolean; state?: PresenceState }) => {
  const user = usersById.value.get(isMe ? (socketId.value ?? '') : peer.id);
  const me = account.value;
  // "Playing …" as the server broadcasts it (my own comes back the same way).
  const activity = user?.activity ?? null;
  const speaking = isMe ? localSpeaking.value : peer.speaking;
  const muted = isMe ? localMuted.value || (audioSettings.value.pttEnable && !pttPressed.value) : peer.muted;
  const deafened = isMe ? localDeafened.value : peer.deafened;
  // What I hear of them: remembered per account, shown and set from this tile's menu.
  const accountId = isMe ? null : peerAccountId(peer.id);
  const pref = peerAudioPref(accountId);
  const percent = volumePercent(pref.volume);

  const items: MenuItem[] = [];
  if (!isMe) {
    if (user) items.push({ label: 'Message', icon: <MessageCircle size={14} />, onSelect: () => api.openDm(user.accountId) });
    if (can('canModerate') && !user?.isSuperuser) {
      items.push({ label: 'Kick from voice', danger: true, onSelect: () => voiceManager.kick(peer.id) });
      items.push({ label: 'Timeout 5 min', danger: true, onSelect: () => voiceManager.timeout(peer.id, 5) });
    }
    if (can('canBanUsers') && !user?.isSuperuser) {
      items.push({
        label: 'Ban',
        danger: true,
        onSelect: () =>
          openModal({
            type: 'confirm',
            title: 'Ban ' + peer.name + '?',
            message: 'They will be disconnected and cannot sign in again until an admin lifts the ban.',
            confirmLabel: 'Ban',
            danger: true,
            onConfirm: () => api.banUser(peer.id, peer.name, 'Banned by ' + (me?.displayName ?? 'moderator')),
          }),
      });
    }
  }

  const header = accountId ? <PeerVolumePanel accountId={accountId} name={peer.name} /> : undefined;

  return (
    <Menu items={items} title={peer.name} header={header}>
      <div
        data-state={state}
        data-peer-tile={peer.id}
        className={cn(
          'motion-tile flex w-36 flex-col items-center gap-2 rounded-lg bg-sidebar p-4 transition-[box-shadow,background-color] duration-150',
          speaking && 'ring-2 ring-success',
          (items.length > 0 || header) && 'cursor-pointer hover:bg-hover',
        )}
      >
        <Avatar seed={user?.accountId ?? peer.id} name={peer.name} src={user?.avatarUrl} size={64} speaking={speaking} />
        <span className="w-full truncate text-center text-sm font-medium text-text-bright">{peer.name}{isMe ? ' (you)' : ''}</span>
        {activity && (
          <span className="flex w-full items-center justify-center gap-1 text-[11px] text-text-muted" title={'Playing ' + activity} data-activity>
            <Gamepad2 size={12} className="shrink-0" />
            <span className="truncate">Playing {activity}</span>
          </span>
        )}
        <span className="flex items-center gap-1.5 text-text-muted">
          {muted ? <MicOff size={14} className="text-live" /> : <Mic size={14} />}
          {deafened && <HeadphoneOff size={14} className="text-live" />}
          {peer.camera && <Video size={14} className="text-success" />}
          {peer.screen && <MonitorUp size={14} className="text-success" />}
          {/* My side only: crossed speaker while they are muted for me, their level when it is not 100 %. */}
          {!isMe && pref.muted && <VolumeX size={14} className="text-live" aria-label="Muted for you" title="Muted for you" data-muted-for-me />}
          {!isMe && !pref.muted && percent !== 100 && (
            <span className="flex items-center gap-0.5 text-[11px] tabular-nums" title={'Plays at ' + percent + '% for you'} data-peer-volume-badge>
              <Volume2 size={12} /> {percent}%
            </span>
          )}
        </span>
      </div>
    </Menu>
  );
};

/** The call controls; `overlay` floats them over the video (landscape phones). */
const Toolbar = ({ overlay = false }: { overlay?: boolean }) => {
  const muted = localMuted.value || (audioSettings.value.pttEnable && !pttPressed.value);
  const cameraOn = localCameraStream.value !== null;
  const screenOn = localScreenStream.value !== null;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-center gap-2 px-3 py-3',
        overlay && 'absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]',
      )}
    >
      <IconButton label={muted ? 'Unmute' : 'Mute'} size="lg" tone={localMuted.value ? 'danger' : 'default'} className="bg-sidebar" onClick={() => void voiceManager.toggleMute()}>
        <span key={muted ? 'muted' : 'live'} className="inline-flex animate-icon-swap">
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </span>
      </IconButton>
      <IconButton label={localDeafened.value ? 'Undeafen' : 'Deafen'} size="lg" tone={localDeafened.value ? 'danger' : 'default'} className="bg-sidebar" onClick={() => void voiceManager.toggleDeafen()}>
        <span key={localDeafened.value ? 'deaf' : 'hearing'} className="inline-flex animate-icon-swap">
          {localDeafened.value ? <HeadphoneOff size={22} /> : <Headphones size={22} />}
        </span>
      </IconButton>
      <IconButton label={cameraOn ? 'Turn camera off' : 'Turn camera on'} size="lg" active={cameraOn} className="bg-sidebar" onClick={() => void voiceManager.toggleCamera()}>
        <span key={cameraOn ? 'on' : 'off'} className="inline-flex animate-icon-swap">
          {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
        </span>
      </IconButton>
      {cameraOn && isMobile.value && (
        <IconButton label="Flip camera" size="lg" className="bg-sidebar" onClick={() => void voiceManager.flipCamera()}>
          <RefreshCw size={22} />
        </IconButton>
      )}
      {canCaptureScreen() && (
        <IconButton label={screenOn ? 'Stop sharing screen' : 'Share screen'} size="lg" active={screenOn} className="bg-sidebar" onClick={() => void voiceManager.toggleScreenShare()}>
          <MonitorUp size={22} />
        </IconButton>
      )}
      <IconButton label="Audio settings" size="lg" className="bg-sidebar" onClick={() => openModal({ type: 'audioSettings' })}>
        <Settings size={22} />
      </IconButton>
      <IconButton label="Leave voice" size="lg" tone="danger" onClick={() => void voiceManager.leave()}>
        <PhoneOff size={22} />
      </IconButton>
    </div>
  );
};

interface Tile {
  key: string;
  stream: MediaStream;
  label: string;
  mirror?: boolean;
  /** Whose camera this is (remote camera tiles carry that person's volume controls). */
  peerId?: string;
  /** Remote screen shares play their sound through the tile; everything else stays muted. */
  screen?: { remote: boolean; peerId?: string };
}

/** The controls for one person's voice as shown on their camera tile (state/peerAudio.ts). */
const personAudioControls = (peerId: string): TileAudioControls | undefined => {
  const accountId = peerAccountId(peerId);
  if (!accountId) return undefined;
  const name = usersById.value.get(peerId)?.displayName ?? voicePeers.value[peerId]?.name ?? 'them';
  const pref = peerAudioPref(accountId);
  return {
    muted: pref.muted,
    volume: pref.volume,
    max: 2,
    sliderLabel: 'Volume for ' + name,
    muteLabel: 'Mute ' + name + ' for me',
    unmuteLabel: 'Unmute ' + name + ' for me',
    onMutedChange: (muted) => setPeerAudioPref(accountId, { muted }),
    onVolumeChange: (volume) => setPeerAudioPref(accountId, { volume }),
    panel: <PeerVolumePanel accountId={accountId} name={name} />,
    panelTitle: name,
  };
};

/**
 * Sound settings for a tile. Own tiles are silent. A friend's camera tile is silent too (their
 * voice plays through the mesh's own audio path) but carries the controls for that voice. A
 * friend's screen has its own mute and volume (remembered per friend) on top of deafen, that
 * person's volume and mute for me, the output volume and the output device.
 */
const tileAudio = (tile: Tile) => {
  if (!tile.screen) return { muted: true, audioIndicator: false, audioControls: tile.peerId ? personAudioControls(tile.peerId) : undefined };
  // Clips of a shared screen: your own always, a friend's unless they said no (features/clips).
  if (!tile.screen.remote || !tile.screen.peerId) return { muted: true, audioIndicator: true, stats: true, clip: tileClipControls(OWN_SHARE_CLIP_KEY) };
  const peerId = tile.screen.peerId;
  const clip = remoteScreenClipsAllowed(peerId) ? tileClipControls(voiceClipKey(peerId)) : undefined;
  const pref = peerAudioPref(peerAccountId(peerId));
  const hostKey = screenHostKey(peerId, peerId) ?? 'peer:' + peerId;
  const streamAudio = screenAudioPref(hostKey);
  const controls: TileAudioControls = {
    muted: streamAudio.muted,
    volume: streamAudio.volume,
    max: 1,
    onlyWithAudio: true,
    onMutedChange: (muted) => setScreenAudioPref(hostKey, { muted }),
    onVolumeChange: (volume) => setScreenAudioPref(hostKey, { volume }),
  };
  return {
    muted: localDeafened.value || pref.muted || streamAudio.muted,
    volume: streamAudio.volume * pref.volume * audioSettings.value.outputVol,
    sinkId: audioSettings.value.spkDeviceId,
    audioIndicator: true,
    stats: true,
    audioControls: controls,
    clip,
  };
};

/** `edge`: no padding, the picture runs to the edges (landscape phones). */
const VideoGrid = ({ edge = false }: { edge?: boolean }) => {
  const [focused, setFocused] = useState<string | null>(null);
  const inset = edge ? 0 : 24;
  const me = account.value;
  const tiles: Tile[] = [];
  if (localScreenStream.value) tiles.push({ key: 'me:screen', stream: localScreenStream.value, label: 'Your screen', screen: { remote: false } });
  if (localCameraStream.value) tiles.push({ key: 'me:camera', stream: localCameraStream.value, label: me?.displayName ?? 'You', mirror: true });
  for (const [peerId, streams] of Object.entries(remoteVideo.value)) {
    const name = usersById.value.get(peerId)?.displayName ?? 'Peer';
    if (streams.screen) tiles.push({ key: peerId + ':screen', stream: streams.screen, label: name + "'s screen", screen: { remote: true, peerId } });
    if (streams.camera) tiles.push({ key: peerId + ':camera', stream: streams.camera, label: name, peerId });
  }
  // Tiles scale in when a stream appears and out when it ends (lib/motion.ts).
  const present = useListPresence(tiles, (tile) => tile.key, MOTION.base);
  // Columns and row height that give the tiles the most picture for the space the grid has
  // (measured; rows share the height equally until the grid has been measured once).
  const [gridRef, gridSize] = useElementSize();
  const layout = gridSize ? videoGridLayout(present.length, gridSize.width - inset, gridSize.height - inset) : null;
  if (tiles.length === 0) return null;
  const focusedTile = tiles.find((tile) => tile.key === focused) ?? (tiles.length === 1 ? tiles[0] : null);
  if (focusedTile) {
    const others = tiles.filter((tile) => tile.key !== focusedTile.key);
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col gap-2', edge ? 'p-0' : 'p-3')}>
        <VideoTile stream={focusedTile.stream} label={focusedTile.label} mirror={focusedTile.mirror} {...tileAudio(focusedTile)} className="min-h-0 flex-1" onClick={() => setFocused(null)} />
        {others.length > 0 && (
          <div className="flex h-24 gap-2 overflow-x-auto">
            {others.map((tile) => (
              <VideoTile key={tile.key} stream={tile.stream} label={tile.label} mirror={tile.mirror} {...tileAudio(tile)} className="aspect-video h-full" onClick={() => setFocused(tile.key)} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      ref={gridRef}
      className={cn('scrollbar-thin grid min-h-0 flex-1 content-center justify-center overflow-y-auto', edge ? 'p-0' : 'p-3')}
      style={{
        gap: VIDEO_GRID_GAP + 'px',
        gridTemplateColumns: layout ? 'repeat(' + layout.columns + ', ' + layout.cellWidth + 'px)' : 'repeat(' + Math.min(2, present.length) + ', minmax(0, 1fr))',
        gridTemplateRows: layout ? 'repeat(' + layout.rows + ', ' + layout.cellHeight + 'px)' : undefined,
        gridAutoRows: layout ? undefined : 'minmax(0, 1fr)',
      }}
    >
      {present.map(({ item: tile, state }) => (
        <VideoTile key={tile.key} state={state} stream={tile.stream} label={tile.label} mirror={tile.mirror} {...tileAudio(tile)} className="min-h-0" onClick={() => setFocused(tile.key)} />
      ))}
    </div>
  );
};

export const VoicePage = ({ channel }: { channel: Channel }) => {
  const connectedHere = voiceStatus.value !== 'idle' && voiceChannelId.value === channel.id;
  const members = usersInVoice(channel.id);
  const me = account.value;
  const elapsed = useVoiceTimer();
  const [showGame, setShowGame] = useState(false);
  const game = minigameState.value;
  const gameOpen = connectedHere && (showGame || (game !== null && game.channelId === channel.id));
  const peers = peerList.value;
  // Friends scale in when they join and out when they leave (lib/motion.ts).
  const peerTiles = useListPresence(peers, (peer) => peer.id, MOTION.base);

  if (!connectedHere) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Volume2 size={48} className="text-text-faint" />
        <div>
          <h3 className="text-xl font-semibold text-text-bright">{channel.name}</h3>
          <p className="mt-1 text-sm text-text-muted">
            {members.length === 0 ? 'Nobody is here yet.' : members.map((user) => user.displayName).join(', ') + (members.length === 1 ? ' is' : ' are') + ' in this channel.'}
          </p>
        </div>
        <Button size="lg" variant="success" loading={voiceStatus.value === 'connecting' && voiceChannelId.value === channel.id} onClick={() => void voiceManager.join(channel.id)}>
          <Phone size={18} /> Join voice
        </Button>
        {members.length > 0 && (
          <div className="flex flex-wrap justify-center gap-3">
            {members.map((user) => (
              <div key={user.id} className="flex flex-col items-center gap-1 text-xs text-text-muted">
                <Avatar seed={user.accountId} name={user.displayName} src={user.avatarUrl} size={40} />
                {user.displayName}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // A phone held sideways while video is on: the picture takes the whole page, the controls float over it.
  const immersive = isLandscapePhone.value && anyVideoActive.value && !gameOpen;

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', immersive ? 'bg-black' : 'bg-base/40')}>
      {!immersive && (
        <div className="flex items-center justify-between px-4 pt-3 text-xs text-text-muted">
          <span>
            {voiceStatus.value === 'connected' ? 'Connected' : voiceStatus.value === 'reconnecting' ? 'Reconnecting (your call stays up)' : 'Connecting'} · {elapsed}
          </span>
          <button
            type="button"
            className={cn('flex items-center gap-1 rounded-sm px-2 py-1 hover:bg-hover hover:text-text-bright pointer-coarse:py-2.5', gameOpen && 'text-warning')}
            onClick={() => setShowGame((value) => !value)}
          >
            <Gamepad2 size={14} /> Minigames
          </button>
        </div>
      )}
      {gameOpen ? (
        <MinigamePanel channel={channel} onClose={() => setShowGame(false)} />
      ) : anyVideoActive.value ? (
        <VideoGrid edge={immersive} />
      ) : (
        <div className="scrollbar-thin flex flex-1 flex-wrap content-start justify-center gap-3 overflow-y-auto p-4">
          {me && <PeerTile peer={{ id: 'me', name: me.displayName, muted: localMuted.value, deafened: localDeafened.value, speaking: localSpeaking.value, camera: false, screen: false, quality: 'unknown' }} isMe />}
          {peerTiles.map((entry) => (
            <PeerTile key={entry.key} peer={entry.item} isMe={false} state={entry.state} />
          ))}
        </div>
      )}
      <Toolbar overlay={immersive} />
    </div>
  );
};
