import { useEffect, useRef, useState } from 'preact/hooks';
import { Download, Film, Play, Send, Trash, X } from 'lucide-preact';
import { Button, IconButton, Modal, Spinner } from '@/components';
import { cn } from '@/lib/cn';
import { isCapacitor } from '@/lib/device';
import { formatBytes, formatFullDate, formatSeconds } from '@/lib/format';
import { clipManager } from '@/services/clips/clipManager';
import { downloadClipFile } from '@/services/clips/clipDownload';
import { CLIP_STORAGE_CAP_BYTES, clipFileName, getClipBlobs, type ClipRecord } from '@/services/clips/clipStore';
import { serverConfig } from '@/services/ServerConfigService';
import { UPLOAD_CANCELLED } from '@/services/uploads';
import { channels, selectedChannelId } from '@/state/channels';
import { clipLibrary, clipLibraryBytes } from '@/state/clips';
import { connectionStatus } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { closeModal, toast } from '@/state/ui';
import { clipTooBigReason, defaultPostTarget, lastPostTarget, postClip, postTargetLabel, postTargets, type ClipPost } from './postClip';

/** An object URL for a blob that is revoked when the blob changes or the component goes. */
const useObjectUrl = (blob: Blob | null): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
};

/**
 * The strip under a row after "Post to chat": pick a channel, post, watch the upload.
 * The upload keeps going if the library is closed meanwhile; the toast says where the
 * clip went. Only an explicit Cancel stops it.
 */
const PostBar = ({ clip, onClose }: { clip: ClipRecord; onClose: () => void }) => {
  const targets = postTargets(channels.value);
  const [target, setTarget] = useState<string | null>(() => defaultPostTarget(targets, selectedChannelId.value, lastPostTarget.value));
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useRef<ClipPost | null>(null);
  const tooBig = clipTooBigReason(clip.bytes, serverConfig.uploadLimits().videoMaxBytes);
  const selected = targets.find((channel) => channel.id === target) ?? null;

  const post = async () => {
    if (!selected || tooBig) return;
    setProgress(0);
    try {
      const blobs = await getClipBlobs(clip.id);
      if (!blobs) {
        toast.error('This clip is gone from the storage');
        onClose();
        return;
      }
      const handle = postClip(clip, blobs.video, selected.id, setProgress);
      upload.current = handle;
      await handle.done;
      lastPostTarget.value = selected.id;
      const label = postTargetLabel(selected);
      toast.success(connectionStatus.value === 'connected' ? 'Posted to ' + label : 'Will be posted to ' + label + ' when back online');
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (message === UPLOAD_CANCELLED) toast.info('The clip was not posted');
      else toast.error('Could not post the clip: ' + message);
      setProgress(null);
    } finally {
      upload.current = null;
    }
  };

  if (progress !== null) {
    const percent = Math.round(progress * 100);
    return (
      <div className="mt-2 flex items-center gap-2 rounded-sm bg-base/60 p-2" data-clip-post="uploading">
        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-black/30" role="progressbar" aria-label={'Posting the clip to ' + (selected ? postTargetLabel(selected) : 'chat')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-brand transition-[width] duration-150" style={{ width: percent + '%' }} />
        </div>
        <span className="shrink-0 text-xs text-text-muted tabular-nums" data-clip-post-progress>
          {percent}%
        </span>
        <Button size="sm" variant="ghost" onClick={() => upload.current?.abort()} data-clip-post-cancel>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm bg-base/60 p-2" data-clip-post="pick">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-muted">
        <span className="shrink-0">Post to</span>
        <select
          value={target ?? ''}
          onChange={(event) => setTarget((event.target as HTMLSelectElement).value)}
          aria-label="Channel to post to"
          className="h-9 min-w-0 flex-1 rounded-sm bg-base px-2 text-sm text-text-bright outline-none focus:ring-2 focus:ring-brand"
          data-clip-post-target
        >
          {targets.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {postTargetLabel(channel)}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" onClick={() => void post()} disabled={!selected || Boolean(tooBig)} data-clip-post-send>
        Post
      </Button>
      <IconButton label="Cancel posting" size="sm" onClick={onClose}>
        <X size={16} />
      </IconButton>
      {tooBig && (
        <p className="w-full text-xs text-warning" data-clip-post-too-big>
          {tooBig}
        </p>
      )}
    </div>
  );
};

const ClipRow = ({ clip, playing, onPlay, onDeleted }: { clip: ClipRecord; playing: boolean; onPlay: (clip: ClipRecord, video: Blob) => void; onDeleted: () => void }) => {
  const [thumbnail, setThumbnail] = useState<Blob | null>(null);
  const [busy, setBusy] = useState<'play' | 'download' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [posting, setPosting] = useState(false);
  const thumbnailUrl = useObjectUrl(thumbnail);
  const confirmTimer = useRef<number | null>(null);
  const canPost = postTargets(channels.value).length > 0;

  useEffect(() => {
    let cancelled = false;
    void getClipBlobs(clip.id).then((blobs) => {
      if (!cancelled) setThumbnail(blobs?.thumbnail ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [clip.id]);

  useEffect(() => () => {
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
  }, []);

  const video = async (): Promise<Blob | null> => {
    const blobs = await getClipBlobs(clip.id);
    if (!blobs) toast.error('This clip is gone from the storage');
    return blobs?.video ?? null;
  };

  const play = async () => {
    setBusy('play');
    try {
      const blob = await video();
      if (blob) onPlay(clip, blob);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      const blob = await video();
      if (!blob) return;
      const outcome = await downloadClipFile(blob, clipFileName(clip.sourceName, clip.createdAt));
      if (outcome === 'saved') toast.success('Saved to Documents/Datasetto on this phone');
      else if (outcome === 'shared') toast.info('Pick where the clip goes from the share sheet');
    } catch (error) {
      toast.error('Could not save the clip: ' + (error instanceof Error ? error.message : 'unknown error'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      confirmTimer.current = window.setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setBusy('delete');
    try {
      await clipManager.remove(clip.id);
      onDeleted();
    } catch (error) {
      toast.error('Could not delete the clip: ' + (error instanceof Error ? error.message : 'unknown error'));
    } finally {
      setBusy(null);
    }
  };

  const size = clip.width && clip.height ? clip.width + '×' + clip.height : '';
  return (
    <li className={cn('rounded-md p-2 transition-colors', playing ? 'bg-brand-soft' : 'hover:bg-hover')} data-clip-id={clip.id}>
      {/* On a phone the four buttons do not fit next to the name: they wrap under it instead of squeezing it. */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="relative h-14 w-24 shrink-0 overflow-hidden rounded-sm bg-black" onClick={() => void play()} aria-label={'Play clip of ' + clip.sourceName} disabled={busy !== null}>
          {thumbnailUrl ? <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <Film size={20} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-text-faint" />}
          <span className="absolute right-1 bottom-1 rounded-sm bg-black/70 px-1 text-[10px] font-semibold text-white tabular-nums">{formatSeconds(clip.durationMs)}</span>
        </button>
        <div className="min-w-[9rem] flex-1">
          <p className="truncate text-sm font-medium text-text-bright" data-clip-name>
            {clip.sourceName}
          </p>
          <p className="truncate text-xs text-text-muted">
            {formatFullDate(clip.createdAt)} · {formatBytes(clip.bytes)}
            {size && ' · ' + size}
            {!clip.hasAudio && ' · no sound'}
            {clip.includesVoice && ' · with voice chat'}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="Play" size="sm" onClick={() => void play()} disabled={busy !== null}>
            {busy === 'play' ? <Spinner size={14} /> : <Play size={16} />}
          </IconButton>
          {canPost && (
            <IconButton label="Post to chat" size="sm" tone={posting ? 'brand' : 'default'} active={posting} onClick={() => setPosting((value) => !value)} disabled={busy !== null} data-clip-post-open>
              <Send size={16} />
            </IconButton>
          )}
          <IconButton label={isCapacitor() ? 'Save or share' : 'Download'} size="sm" onClick={() => void download()} disabled={busy !== null} data-clip-download>
            {busy === 'download' ? <Spinner size={14} /> : <Download size={16} />}
          </IconButton>
          {confirmDelete ? (
            <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy !== null} data-clip-delete-confirm>
              {busy === 'delete' ? <Spinner size={14} /> : 'Delete?'}
            </Button>
          ) : (
            <IconButton label="Delete" size="sm" onClick={() => void remove()} disabled={busy !== null} data-clip-delete>
              <Trash size={16} />
            </IconButton>
          )}
        </div>
      </div>
      {posting && <PostBar clip={clip} onClose={() => setPosting(false)} />}
    </li>
  );
};

/**
 * The clips library: every clip saved on this device, with play, post to chat, download
 * and delete. Clips are WebM files recorded by the browser; there is no MP4 conversion.
 */
export const ClipsModal = () => {
  const clips = clipLibrary.value;
  const used = clipLibraryBytes.value;
  const [playing, setPlaying] = useState<{ clip: ClipRecord; blob: Blob } | null>(null);
  const playingUrl = useObjectUrl(playing?.blob ?? null);

  useEffect(() => {
    void clipManager.refreshLibrary();
  }, []);

  const count = clips?.length ?? 0;
  const subtitle =
    clips === null
      ? 'Reading the clips saved on this device…'
      : count === 0
        ? 'Nothing saved yet on this device.'
        : count + (count === 1 ? ' clip, ' : ' clips, ') + formatBytes(used) + ' of ' + formatBytes(CLIP_STORAGE_CAP_BYTES) + ' used on this device.';

  return (
    <Modal title="Clips" subtitle={subtitle} onClose={closeModal} size="lg">
      {playing && playingUrl && (
        <div className="mb-3 overflow-hidden rounded-md bg-black" data-clip-player>
          <video src={playingUrl} controls autoPlay playsInline className="max-h-[50vh] w-full" />
          <div className="flex items-center gap-2 bg-base/60 px-3 py-1.5 text-xs text-text-muted">
            <span className="min-w-0 flex-1 truncate">
              {playing.clip.sourceName} · {formatSeconds(playing.clip.durationMs)} · {formatFullDate(playing.clip.createdAt)}
            </span>
            <IconButton label="Close player" size="sm" onClick={() => setPlaying(null)}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
      )}
      {clips === null ? (
        <div className="flex justify-center py-8">
          <Spinner size={24} />
        </div>
      ) : count === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-text-muted">
          <Film size={36} className="text-text-faint" />
          <p>
            Open a live stream or a shared screen, turn <strong>Clips</strong> on in its corner, and press <strong>Clip</strong> (or your clip key) to save its last {audioSettings.value.clipSeconds} seconds.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1" data-clip-list>
          {clips.map((clip) => (
            <ClipRow key={clip.id} clip={clip} playing={playing?.clip.id === clip.id} onPlay={(record, blob) => setPlaying({ clip: record, blob })} onDeleted={() => playing?.clip.id === clip.id && setPlaying(null)} />
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-text-faint">
        Clips are WebM videos (VP9 or VP8 with Opus) recorded on your device from what you watched; browsers, VLC and most players open them, and there is no MP4 conversion yet. They stay in this browser or app only, up to {formatBytes(CLIP_STORAGE_CAP_BYTES)}; the oldest are removed first when the space is full, so download the ones you want to keep. Post to chat sends a copy to the server for the channel to watch, up to{' '}
        {formatBytes(serverConfig.uploadLimits().videoMaxBytes)} per clip on this server.
      </p>
    </Modal>
  );
};
