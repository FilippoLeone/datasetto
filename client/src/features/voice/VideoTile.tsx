import { useEffect, useRef } from 'preact/hooks';
import { cn } from '@/lib/cn';

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  mirror?: boolean;
  muted?: boolean;
  className?: string;
  onClick?: () => void;
}

/** Plays a MediaStream in a <video>, re-attaching when the stream changes. */
export const VideoTile = ({ stream, label, mirror, muted = true, className, onClick }: VideoTileProps) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.srcObject = stream;
    node.muted = muted;
    const play = () => node.play().catch(() => undefined);
    play();
    const onLoaded = () => play();
    node.addEventListener('loadedmetadata', onLoaded);
    return () => {
      node.removeEventListener('loadedmetadata', onLoaded);
      node.srcObject = null;
    };
  }, [stream, muted]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-black', onClick && 'cursor-pointer', className)} onClick={onClick}>
      <video ref={ref} autoPlay playsInline className={cn('h-full w-full object-contain', mirror && 'mirror')} />
      <span className="absolute bottom-2 left-2 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">{label}</span>
    </div>
  );
};
