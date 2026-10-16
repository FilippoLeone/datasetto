import { useState } from 'preact/hooks';
import { Gamepad2, Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, Phone, PhoneOff, RefreshCw, Settings, Video, VideoOff, Volume2 } from 'lucide-preact';
import { Avatar, Button, IconButton, Menu, type MenuItem } from '@/components';
import { cn } from '@/lib/cn';
import { canCaptureScreen } from '@/lib/device';
import { usersById, usersInVoice } from '@/state/presence';
import { account, can } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { isMobile, openModal } from '@/state/ui';
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
  remoteVideo,
  voiceChannelId,
  voiceStatus,
  type VoicePeer,
} from '@/state/voice';
import { api } from '@/services/socket/api';
import { VideoTile } from './VideoTile';
import { useVoiceTimer } from './VoiceDock';
import { voiceManager } from './voiceManager';
import { MinigamePanel } from '@/features/minigames/MinigamePanel';
import type { Channel } from '@/types/protocol';

const PeerTile = ({ peer, isMe }: { peer: VoicePeer; isMe: boolean }) => {
  const user = usersById.value.get(peer.id);
  const me = account.value;
  const speaking = isMe ? localSpeaking.value : peer.speaking;
  const muted = isMe ? localMuted.value || (audioSettings.value.pttEnable && !pttPressed.value) : peer.muted;
  const deafened = isMe ? localDeafened.value : peer.deafened;
  const pref = !isMe ? voiceManager.peerVolume(peer.id) : null;

  const items: MenuItem[] = [];
  if (!isMe) {
    items.push({
      label: pref?.muted ? 'Unmute for me' : 'Mute for me',
      icon: <Volume2 size={14} />,
      onSelect: () => voiceManager.setPeerMuted(peer.id, !pref?.muted),
    });
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

  return (
    <Menu items={items}>
      <div
        className={cn(
          'flex w-36 flex-col items-center gap-2 rounded-lg bg-sidebar p-4 transition-shadow',
          speaking && 'ring-2 ring-success',
          items.length > 0 && 'cursor-pointer hover:bg-hover',
        )}
      >
        <Avatar seed={user?.accountId ?? peer.id} name={peer.name} src={user?.avatarUrl} size={64} speaking={speaking} />
        <span className="w-full truncate text-center text-sm font-medium text-text-bright">{peer.name}{isMe ? ' (you)' : ''}</span>
        <span className="flex items-center gap-1.5 text-text-muted">
          {muted ? <MicOff size={14} className="text-live" /> : <Mic size={14} />}
          {deafened && <HeadphoneOff size={14} className="text-live" />}
          {peer.camera && <Video size={14} className="text-success" />}
          {peer.screen && <MonitorUp size={14} className="text-success" />}
        </span>
      </div>
    </Menu>
  );
};

const Toolbar = () => {
  const muted = localMuted.value || (audioSettings.value.pttEnable && !pttPressed.value);
  const cameraOn = localCameraStream.value !== null;
  const screenOn = localScreenStream.value !== null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-3">
      <IconButton label={muted ? 'Unmute' : 'Mute'} size="lg" tone={localMuted.value ? 'danger' : 'default'} className="bg-sidebar" onClick={() => void voiceManager.toggleMute()}>
        {muted ? <MicOff size={22} /> : <Mic size={22} />}
      </IconButton>
      <IconButton label={localDeafened.value ? 'Undeafen' : 'Deafen'} size="lg" tone={localDeafened.value ? 'danger' : 'default'} className="bg-sidebar" onClick={() => void voiceManager.toggleDeafen()}>
        {localDeafened.value ? <HeadphoneOff size={22} /> : <Headphones size={22} />}
      </IconButton>
      <IconButton label={cameraOn ? 'Turn camera off' : 'Turn camera on'} size="lg" active={cameraOn} className="bg-sidebar" onClick={() => void voiceManager.toggleCamera()}>
        {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
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

const VideoGrid = () => {
  const [focused, setFocused] = useState<string | null>(null);
  const me = account.value;
  const tiles: Array<{ key: string; stream: MediaStream; label: string; mirror?: boolean }> = [];
  if (localScreenStream.value) tiles.push({ key: 'me:screen', stream: localScreenStream.value, label: 'Your screen' });
  if (localCameraStream.value) tiles.push({ key: 'me:camera', stream: localCameraStream.value, label: me?.displayName ?? 'You', mirror: true });
  for (const [peerId, streams] of Object.entries(remoteVideo.value)) {
    const name = usersById.value.get(peerId)?.displayName ?? 'Peer';
    if (streams.screen) tiles.push({ key: peerId + ':screen', stream: streams.screen, label: name + "'s screen" });
    if (streams.camera) tiles.push({ key: peerId + ':camera', stream: streams.camera, label: name });
  }
  if (tiles.length === 0) return null;
  const focusedTile = tiles.find((tile) => tile.key === focused) ?? (tiles.length === 1 ? tiles[0] : null);
  if (focusedTile) {
    const others = tiles.filter((tile) => tile.key !== focusedTile.key);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <VideoTile stream={focusedTile.stream} label={focusedTile.label} mirror={focusedTile.mirror} className="min-h-0 flex-1" onClick={() => setFocused(null)} />
        {others.length > 0 && (
          <div className="flex h-24 gap-2 overflow-x-auto">
            {others.map((tile) => (
              <VideoTile key={tile.key} stream={tile.stream} label={tile.label} mirror={tile.mirror} className="aspect-video h-full" onClick={() => setFocused(tile.key)} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-2 p-3 sm:grid-cols-2">
      {tiles.map((tile) => (
        <VideoTile key={tile.key} stream={tile.stream} label={tile.label} mirror={tile.mirror} className="min-h-40" onClick={() => setFocused(tile.key)} />
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

  const peers = peerList.value;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-base/40">
      <div className="flex items-center justify-between px-4 pt-3 text-xs text-text-muted">
        <span>
          {voiceStatus.value === 'connected' ? 'Connected' : 'Connecting'} · {elapsed}
        </span>
        <button type="button" className={cn('flex items-center gap-1 rounded-sm px-2 py-1 hover:bg-hover hover:text-text-bright', gameOpen && 'text-warning')} onClick={() => setShowGame((value) => !value)}>
          <Gamepad2 size={14} /> Minigames
        </button>
      </div>
      {gameOpen ? (
        <MinigamePanel channel={channel} onClose={() => setShowGame(false)} />
      ) : anyVideoActive.value ? (
        <VideoGrid />
      ) : (
        <div className="scrollbar-thin flex flex-1 flex-wrap content-start justify-center gap-3 overflow-y-auto p-4">
          {me && <PeerTile peer={{ id: 'me', name: me.displayName, muted: localMuted.value, deafened: localDeafened.value, speaking: localSpeaking.value, camera: false, screen: false, quality: 'unknown' }} isMe />}
          {peers.map((peer) => (
            <PeerTile key={peer.id} peer={peer} isMe={false} />
          ))}
        </div>
      )}
      <Toolbar />
    </div>
  );
};
