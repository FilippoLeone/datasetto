/**
 * Mixes the sound of a clip source (a shared screen's audio, a stream's audio) with
 * the voice chat into one audio track for the recorder, through a MediaStreamDestination.
 * Inputs can change while the recorder runs: the destination's track stays the same,
 * only the graph behind it is rewired.
 */
export class ClipMixer {
  private readonly context: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly sources = new Map<MediaStream, MediaStreamAudioSourceNode>();
  private closed = false;

  constructor(context: AudioContext = new AudioContext()) {
    this.context = context;
    this.destination = context.createMediaStreamDestination();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  }

  /** The mixed audio track to record. */
  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  /** Make exactly these streams the inputs (streams without a live audio track are skipped). */
  setInputs(streams: Iterable<MediaStream>): void {
    if (this.closed) return;
    const wanted = new Set<MediaStream>();
    for (const stream of streams) {
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) continue;
      wanted.add(stream);
      if (this.sources.has(stream)) continue;
      try {
        const source = this.context.createMediaStreamSource(stream);
        source.connect(this.destination);
        this.sources.set(stream, source);
      } catch {
        /* a stream whose audio track ended between the check and the node */
      }
    }
    for (const [stream, source] of Array.from(this.sources.entries())) {
      if (wanted.has(stream)) continue;
      try {
        source.disconnect();
      } catch {
        /* already gone */
      }
      this.sources.delete(stream);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const source of this.sources.values()) {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
    for (const track of this.destination.stream.getTracks()) track.stop();
    void this.context.close().catch(() => undefined);
  }
}
