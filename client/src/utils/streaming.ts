export function buildHlsUrlCandidates(baseUrl: string, channelName: string): string[] {
  const name = channelName?.trim();
  if (!name) {
    return [];
  }

  const encodeName = encodeURIComponent(name);
  const normalize = (value: string): string => value.replace(/\/+$/, '');
  const baseVariants: string[] = [];
  const addBase = (value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const trimmed = normalize(value);
    if (trimmed && !baseVariants.includes(trimmed)) {
      baseVariants.push(trimmed);
    }
  };

  addBase(baseUrl);

  const lowerBase = (baseUrl || '').toLowerCase();
  if (!lowerBase.includes('/hls')) {
    addBase(`${baseUrl}/hls`);
  }
  if (!lowerBase.endsWith('/live')) {
    addBase(`${baseUrl}/live`);
  }
  if (!lowerBase.includes('/hls/live')) {
    addBase(`${baseUrl}/hls/live`);
  }

  const candidates: string[] = [];
  const addCandidate = (value: string): void => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  baseVariants.forEach((base) => {
    const normalizedBase = normalize(base);
    addCandidate(`${normalizedBase}/${encodeName}/index.m3u8`);
    addCandidate(`${normalizedBase}/${encodeName}.m3u8`);
  });

  return candidates;
}
