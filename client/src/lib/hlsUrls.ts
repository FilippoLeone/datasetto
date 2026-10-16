export function buildHlsUrlCandidates(baseUrl: string, channelName: string, streamKeyToken?: string): string[] {
  const name = channelName?.trim();
  if (!name) {
    return [];
  }

  const token = streamKeyToken?.trim();
  const normalize = (value: string): string => value.replace(/\/+$/, '');
  const dedupePush = (list: string[], value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const trimmed = normalize(value);
    if (trimmed && !list.includes(trimmed)) {
      list.push(trimmed);
    }
  };

  const stripKnownSuffixes = (value: string): string => {
    let current = normalize(value);
    const suffixes = ['/live', '/hls'];
    let updated = true;
    while (updated && current) {
      updated = false;
      for (const suffix of suffixes) {
        if (current.toLowerCase().endsWith(suffix)) {
          current = normalize(current.slice(0, -suffix.length));
          updated = true;
        }
      }
    }
    return current;
  };

  const baseVariants: string[] = [];
  dedupePush(baseVariants, baseUrl);

  const rootBase = stripKnownSuffixes(baseUrl);
  dedupePush(baseVariants, rootBase);
  dedupePush(baseVariants, `${rootBase}/hls`);
  dedupePush(baseVariants, `${rootBase}/live`);
  dedupePush(baseVariants, `${rootBase}/hls/live`);

  const candidates: string[] = [];
  const addCandidate = (value: string): void => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  const streamNames: string[] = [];
  if (token) {
    streamNames.push(`${name}+${token}`);
  }
  streamNames.push(name);

  baseVariants.forEach((base) => {
    const normalizedBase = normalize(base);
    streamNames.forEach((streamName) => {
      const encoded = encodeURIComponent(streamName);
      addCandidate(`${normalizedBase}/${encoded}/index.m3u8`);
      addCandidate(`${normalizedBase}/${encoded}.m3u8`);
    });
  });

  return candidates;
}
