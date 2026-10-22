import { MicOff } from 'lucide-preact';
import { Avatar } from '@/components';
import { cn } from '@/lib/cn';
import { usersById } from '@/state/presence';
import { account } from '@/state/session';
import { localMuted, localSpeaking, peerList } from '@/state/voice';

/**
 * The call as a strip of small tiles while a game has the voice page (platform.md §10.6). Its own
 * component, so speaking rings re-render the strip and nothing else.
 */
export const VoiceStrip = () => {
  const me = account.value;
  const byId = usersById.value;
  const people = [
    ...(me ? [{ key: 'me', seed: me.id, name: me.displayName + ' (you)', src: me.avatarUrl, speaking: localSpeaking.value, muted: localMuted.value }] : []),
    ...peerList.value.map((peer) => {
      const user = byId.get(peer.id);
      return { key: peer.id, seed: user?.accountId ?? peer.id, name: peer.name, src: user?.avatarUrl, speaking: peer.speaking, muted: peer.muted };
    }),
  ];
  return (
    <div className="scrollbar-thin flex shrink-0 gap-2 overflow-x-auto px-3 py-2" data-voice-strip>
      {people.map((person) => (
        <div key={person.key} className={cn('flex shrink-0 items-center gap-1.5 rounded-full bg-sidebar py-1 pr-3 pl-1', person.speaking && 'ring-2 ring-success')} title={person.name}>
          <Avatar seed={person.seed} name={person.name} src={person.src} size={28} speaking={person.speaking} />
          <span className="max-w-28 truncate text-xs text-text-bright">{person.name}</span>
          {person.muted && <MicOff size={12} className="shrink-0 text-live" />}
        </div>
      ))}
    </div>
  );
};
