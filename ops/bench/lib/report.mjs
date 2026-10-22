/**
 * Measurements and pass/fail for the netbench scenarios (platform.md §15.2 and §15.5, plan.md §3.2):
 *
 * | scenario | pass |
 * |---|---|
 * | 3g | frames/s (median 1 s window) ≥ 13; chat one-way p95 < 300 ms |
 * | 3g-loss | frames/s ≥ 10; chat p95 < 450 ms |
 * | collapse (120 kbit/s), squeeze (12 kbit/s) | the first FRAME at a lower rate (or a park) leaves the server ≤ 1.25 s after its own RTT view starts a sustained run above minRtt + 150 ms (n/a when it never does); ≥ 5 frames/s (mean) or a clean park while collapsed; ≥ 13 frames/s within 5 s after the link returns; no probe over 2 s |
 * | plugin `criteria` | a game may replace a scenario's criteria: `framesMedian`, `chatP95`, `chatP50`, `sioDownKbps {kinds, max}`, `probeMaxMs`, `collapse` + `recoverFrames` |
 * | all | no disconnect or ping timeout on the main socket or the lane, either side; lane `bufferedAmount` < 8 KB |
 *
 * `evaluate` is called every second while a scenario runs and once at the end. A check whose
 * failure is already certain makes the scenario stop early.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const median = (values) => quantile(values, 0.5);
const round = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const within = (t, a, b) => t >= a && t < b;

/** Frames per complete 1 s window in [from, to). */
export const frameWindows = (frames, from, to) => {
  const n = Math.max(0, Math.floor((to - from) / 1000));
  const counts = new Array(n).fill(0);
  for (const [t] of frames) if (t >= from && t < from + n * 1000) counts[Math.floor((t - from) / 1000)] += 1;
  return counts;
};

/** The first time ≥ `from` at which a 1 s window starting there holds at least `need` frames. */
const firstRateAt = (frames, from, until, need) => {
  const ts = frames.map((f) => f[0]).filter((t) => t >= from).sort((a, b) => a - b);
  for (let i = 0; i + need - 1 < ts.length; i += 1) {
    if (ts[i] > until) break;
    if (ts[i + need - 1] - ts[i] < 1000) return Math.max(from, ts[i]);
  }
  return null;
};

/** p95 can no longer pass once this many of at most `n` samples are at or over the limit. */
const p95Allowance = (n) => n - Math.ceil(0.95 * n) + 1;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const TICK_MS = 1000 / 30;
/** platform §6.1: a step down follows rtt − minRtt > 150 ms (pacer PACE.queueHighMs). */
const QUEUE_HIGH_MS = 150;
/** The integrator's bar: the pacer steps after 1 s of queueing; the first FRAME at the new rate leaves within 1.25 s. */
const LADDER_LIMIT_MS = 1250;
const seqDelta = (a, b) => ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000;

/**
 * The server's RTT samples rebuilt from the shaper's lane log, the way its pacer takes them: an ACK
 * or UP that acks a newer frame than the last one gives arrival − sent(ackFrame) − ackDelay (the
 * arrival is the shaper's delivery to the server, the send is the server's write). minRtt is the
 * minimum over the last 10 s. Returns [t, rtt, minRtt, rtt − minRtt].
 */
export const serverRttView = (down, up) => {
  const sentAt = new Map();
  const history = [];
  const samples = [];
  let di = 0;
  let lastAcked = null;
  for (const e of up) {
    if (e[1] !== 0x01 && e[1] !== 0x02) continue;
    const t = e[0];
    while (di < down.length && down[di][0] <= t) {
      const d = down[di];
      if ((d[1] === 0x81 || d[1] === 0x82) && d[3] !== null && d[3] !== undefined) sentAt.set(d[3], d[0]);
      di += 1;
    }
    const ackFrame = e[3];
    if (ackFrame === null || ackFrame === undefined) continue;
    if (lastAcked !== null && seqDelta(ackFrame, lastAcked) <= 0) continue;
    lastAcked = ackFrame;
    const sent = sentAt.get(ackFrame);
    if (sent === undefined) continue;
    const rtt = Math.max(1, t - sent - (e[4] ?? 0));
    history.push([t, rtt]);
    while (history.length > 0 && history[0][0] < t - 10_000) history.shift();
    let minRtt = Infinity;
    for (const h of history) if (h[1] < minRtt) minRtt = h[1];
    samples.push([t, rtt, minRtt, rtt - minRtt]);
  }
  return samples;
};

export const shaperSummary = (buckets) => {
  const kbps = (pick) => buckets.map((b) => (pick(b) * 8) / 1000);
  const stat = (xs) => ({ mean: round(xs.length ? sum(xs) / xs.length : null, 1), max: round(xs.length ? Math.max(...xs) : null, 1) });
  return {
    seconds: buckets.length,
    laneDownKbps: stat(kbps((b) => b.wire.down.lane)),
    laneUpKbps: stat(kbps((b) => b.wire.up.lane)),
    sioDownKbps: stat(kbps((b) => b.wire.down.sio)),
    sioUpKbps: stat(kbps((b) => b.wire.up.sio)),
    totalDownKbps: stat(kbps((b) => sum(Object.values(b.wire.down)) + b.acks.down)),
    totalUpKbps: stat(kbps((b) => sum(Object.values(b.wire.up)) + b.acks.up)),
    laneDownPayloadBps: stat(buckets.map((b) => b.payload.down.lane)),
    laneDownMsgsPerS: stat(buckets.map((b) => b.segments.down.lane)),
    queueWaitMaxMs: { down: round(Math.max(0, ...buckets.map((b) => b.waitMax.down)), 0), up: round(Math.max(0, ...buckets.map((b) => b.waitMax.up)), 0) },
    queueMaxBytes: { down: Math.max(0, ...buckets.map((b) => b.qMax.down)), up: Math.max(0, ...buckets.map((b) => b.qMax.up)) },
    lostSegments: { down: sum(buckets.map((b) => b.lost.down)), up: sum(buckets.map((b) => b.lost.up)) },
    readPauses: { down: sum(buckets.map((b) => b.paused.down)), up: sum(buckets.map((b) => b.paused.up)) },
  };
};

/**
 * @param o {
 *   def: scenario definition, store: page samples, shaperSeconds, serverSeconds, serverDisconnects,
 *   serverLanes, settleAt, mStart, mEnd (planned), now, final
 * }
 */
export const evaluate = (o) => {
  const { def, store, settleAt, mStart } = o;
  const end = Math.min(o.now, o.mEnd);
  const measuredS = Math.max(0, (end - mStart) / 1000);
  const frames = store.frames.filter(([t]) => within(t, mStart, end));
  const windows = frameWindows(store.frames, mStart, end);
  const chat = store.chat.filter(([t]) => within(t, mStart, end)).map((c) => c[1]);
  const probes = store.probes.filter(([t]) => within(t, mStart, end));
  const probeRtts = probes.map((p) => p[1]);
  const keyframes = store.keyframes.filter(([t]) => within(t, settleAt, end));
  const divisors = {};
  for (const f of frames) divisors[f[1]] = (divisors[f[1]] ?? 0) + 1;

  const sockEvents = store.sock.filter((e) => within(e.t, settleAt, end) && e.e === 'disconnect');
  const laneEvents = store.lane.filter((e) => within(e.t, settleAt, end) && (e.e === 'close' || e.e === 'final'));
  const srvDisc = o.serverDisconnects.filter((d) => d.shaped && within(d.t, settleAt, end));
  const srvLaneCloses = o.serverLanes.filter((l) => l.shaped && l.closedAt !== null && within(l.closedAt, settleAt, end));
  const pingTimeouts = [...sockEvents, ...srvDisc].filter((e) => /ping timeout/i.test(e.reason ?? '')).length;
  const srv = o.serverSeconds.filter((b) => within(b.sec * 1000, Math.floor(settleAt / 1000) * 1000, end));
  const laneBufferedMax = Math.max(0, ...srv.map((b) => b.laneShaped));
  const shaper = shaperSummary(o.shaperSeconds.filter((b) => within(b.sec * 1000, Math.floor(mStart / 1000) * 1000, end)));

  // The shaped lane as the server sent and received it (shaper.laneLog).
  const laneDown = o.laneLog?.down ?? [];
  const laneUp = o.laneLog?.up ?? [];
  const sentInWindow = laneDown.filter((e) => e[1] === 0x81 && within(e[0], mStart, end));
  const sentDivisors = {};
  for (const e of sentInWindow) sentDivisors[e[2]] = (sentDivisors[e[2]] ?? 0) + 1;
  const sendGaps = [];
  {
    const inScenario = laneDown.filter((e) => within(e[0], settleAt, end));
    let lastFrameAt = null;
    let lastDivisor = 2;
    let beats = 0;
    for (const e of inScenario) {
      if (e[1] === 0x83) beats += 1;
      if (e[1] !== 0x81 && e[1] !== 0x82) continue;
      if (lastFrameAt !== null && e[0] - lastFrameAt >= 1000) sendGaps.push({ from: lastFrameAt, to: e[0], divisor: lastDivisor, beats, endedBy: e[1] === 0x82 ? 'keyframe:' + e[2] : 'frame' });
      lastFrameAt = e[0];
      if (e[1] === 0x81) lastDivisor = e[2];
      beats = 0;
    }
    if (lastFrameAt !== null && end - lastFrameAt >= 1000) sendGaps.push({ from: lastFrameAt, to: end, divisor: lastDivisor, beats, endedBy: 'still parked' });
  }
  const rttView = def.collapse ? serverRttView(laneDown, laneUp) : [];
  const sioDown = {};
  for (const b of o.shaperSeconds.filter((x) => within(x.sec * 1000, Math.floor(mStart / 1000) * 1000, end))) for (const [k, v] of Object.entries(b.sio?.down ?? {})) sioDown[k] = (sioDown[k] ?? 0) + v;

  const m = {
    measuredS: round(measuredS, 1),
    frames: {
      n: frames.length,
      perSecondMedian: median(windows),
      perSecondMin: windows.length ? Math.min(...windows) : null,
      perSecondMean: measuredS > 0 ? round(frames.length / measuredS, 1) : null,
      windows,
      divisors,
      lagging: frames.filter((f) => f[2] === 1).length,
    },
    keyframes: { n: keyframes.length, reasons: keyframes.map((k) => k[1]) },
    chatOneWayMs: { n: chat.length, p50: round(median(chat)), p95: round(quantile(chat, 0.95)), max: chat.length ? round(Math.max(...chat)) : null },
    probeRttMs: {
      n: probes.length,
      p50: round(median(probeRtts)),
      p95: round(quantile(probeRtts, 0.95)),
      max: probeRtts.length ? round(Math.max(...probeRtts)) : null,
      timeouts: probes.filter((p) => p[2] === -1).length,
      refused: probes.filter((p) => p[2] === 0).length,
    },
    shaper,
    // Per second at the shaper: [sec offset, down wire B by lane/sio/http, down ACK charge B, up wire B, down queue max B, down wait max ms].
    perSecond: o.shaperSeconds
      .filter((b) => within(b.sec * 1000, Math.floor(mStart / 1000) * 1000, end))
      .map((b) => [b.sec - Math.floor(mStart / 1000), b.wire.down.lane, b.wire.down.sio, b.wire.down.http, b.acks.down, sum(Object.values(b.wire.up)), b.qMax.down, Math.round(b.waitMax.down)]),
    serverSend: {
      framesPerSecond: frameWindows(sentInWindow, mStart, end),
      divisors: sentDivisors,
      keyframes: laneDown.filter((e) => e[1] === 0x82 && within(e[0], settleAt, end)).map((e) => ({ t: e[0], reason: e[2] })),
      gaps: sendGaps.map((g) => ({ from: g.from, ms: g.to - g.from, beats: g.beats, endedBy: g.endedBy })),
      clientVis: laneUp.filter((e) => e[1] === 0x05 && within(e[0], settleAt, end)).map((e) => ({ t: e[0], state: e[2] })),
      clientResync: laneUp.filter((e) => e[1] === 0x06 && within(e[0], settleAt, end)).length,
      socketIoDownBytes: sioDown,
    },
    server: {
      laneBufferedMax,
      botLaneBufferedMax: Math.max(0, ...srv.map((b) => b.laneBots)),
      mainBufferedMax: Math.max(0, ...srv.map((b) => b.mainShaped)),
      mainWriteBufferMax: Math.max(0, ...srv.map((b) => b.mainWriteBuffer)),
    },
    disconnects: {
      pageMainSocket: sockEvents.map((e) => ({ t: e.t, reason: e.reason })),
      pageLane: laneEvents.map((e) => ({ t: e.t, e: e.e, code: e.code, reason: e.reason })),
      serverMainSocket: srvDisc.map((d) => ({ t: d.t, reason: d.reason })),
      serverLane: srvLaneCloses.map((l) => ({ t: l.closedAt, hadError: l.hadError })),
      pingTimeouts,
    },
    yields: store.yields.filter(([t]) => within(t, settleAt, end)).map((y) => ({ t: y[0], on: y[1] === 1 })),
    watchdog: (() => {
      const rows = (o.adminStats ?? []).filter((r) => within(r.t, settleAt, end));
      return {
        maxLevel: rows.length ? Math.max(...rows.map((r) => r.level)) : null,
        levels: [...new Set(rows.map((r) => r.level))],
        egressKbpsMax: rows.length ? round(Math.max(...rows.map((r) => r.egressKbps)), 1) : null,
        loopP99Ms: rows.map((r) => round(r.loopP99Ms, 1)).filter((v, i, all) => i === 0 || v !== all[i - 1]),
        loopP99MsMax: rows.length ? round(Math.max(...rows.map((r) => r.loopP99Ms)), 1) : null,
      };
    })(),
    pageErrors: store.errors.filter((e) => within(e.t, settleAt, end)),
  };

  const checks = [];
  const add = (id, label, value, limit, pass, certainFail = false, note) => checks.push({ id, label, value, limit, pass, certainFail, ...(note ? { note } : {}) });
  const disconnects = sockEvents.length + laneEvents.length + srvDisc.length + srvLaneCloses.length;
  add('no-disconnect', 'no disconnect or ping timeout (main socket, lane; both sides)', disconnects, 0, disconnects === 0, disconnects > 0);
  add('lane-buffered', 'server lane bufferedAmount max (B)', laneBufferedMax, '< 8192', laneBufferedMax < 8192, laneBufferedMax >= 8192);

  const totalWindows = def.measureS;
  if (def.criteria.framesMedian !== undefined) {
    const need = def.criteria.framesMedian;
    const below = windows.filter((w) => w < need).length;
    const med = m.frames.perSecondMedian;
    add('frames', 'frames/s at the browser (median 1 s window)', med, '>= ' + need, med === null ? (o.final ? false : null) : o.final ? med >= need : null, below > totalWindows / 2);
  }
  if (def.criteria.chatP95 !== undefined) {
    const limit = def.criteria.chatP95;
    const bad = chat.filter((v) => v >= limit).length;
    const p95 = m.chatOneWayMs.p95;
    add('chat-p95', 'chat one-way p95 (ms)', p95, '< ' + limit, p95 === null ? (o.final ? false : null) : o.final ? p95 < limit : null, bad >= p95Allowance(totalWindows + 2));
  }
  if (def.criteria.chatP50 !== undefined) {
    const limit = def.criteria.chatP50;
    const bad = chat.filter((v) => v >= limit).length;
    const p50 = m.chatOneWayMs.p50;
    // Certain once more than half of the most samples the scenario can give (one a second) are over.
    add('chat-p50', 'chat one-way median (ms)', p50, '< ' + limit, p50 === null ? (o.final ? false : null) : o.final ? p50 < limit : null, bad > (totalWindows + 2) / 2);
  }
  if (def.criteria.sioDownKbps !== undefined) {
    const { kinds, max } = def.criteria.sioDownKbps;
    let bytes = 0;
    for (const b of o.shaperSeconds.filter((x) => within(x.sec * 1000, Math.floor(mStart / 1000) * 1000, end))) {
      for (const [kind, n] of Object.entries(b.sio?.down ?? {})) if (kinds.some((prefix) => kind.startsWith(prefix))) bytes += n;
    }
    const kbps = measuredS > 0 ? round((bytes * 8) / 1000 / measuredS, 2) : null;
    m.sioDownKbps = { kinds, kbps, bytes };
    // Bytes only add up: over the limit for the whole planned window is certain.
    add('sio-down', 'socket.io down kbit/s for [' + kinds.join(', ') + '] (mean over the measured window)', kbps, '<= ' + max, kbps === null ? (o.final ? false : null) : o.final ? kbps <= max : null, (bytes * 8) / 1000 / def.measureS > max);
  }

  if (def.collapse && def.criteria.collapse) {
    const tC = mStart + def.collapse.fromS * 1000;
    const tR = mStart + def.collapse.toS * 1000;
    const need = def.criteria.recoverFrames;
    // The server's reaction, as the shaper saw it leave: the first FRAME at a divisor above 2 (a
    // ladder step), or the first missed slot of a send gap of at least 1 s (a park).
    const sentFrames = laneDown.filter((e) => e[1] === 0x81);
    const stepSent = sentFrames.find((e) => e[0] >= tC && e[0] < tR + 1000 && e[2] > 2);
    const gapsInCollapse = sendGaps.filter((g) => g.to > tC && g.from < tR + 5000);
    const parkAt = gapsInCollapse.length ? gapsInCollapse[0].from + gapsInCollapse[0].divisor * TICK_MS : null;
    const yieldVis = laneUp.find((e) => e[1] === 0x05 && e[2] === 2 && e[0] >= tC && e[0] < tR + 5000);
    const reactions = [stepSent?.[0], parkAt].filter((t) => t !== undefined && t !== null);
    const reaction = reactions.length ? Math.min(...reactions) : null;

    // Onset, the server's own view (the integrator's rule): its RTT samples (ACK arrival − FRAME
    // send − ackDelay, minRtt over 10 s); the onset is the first sample of the first run of samples
    // that all stay above minRtt + 150 ms and that lasts 1 s, or is still running when the server
    // reacts.
    const view = rttView.filter((s) => within(s[0], tC - 2000, tR + 1000));
    let serverOnset = null;
    let runInfo = null;
    for (let i = 0; i < view.length && serverOnset === null; i += 1) {
      if (view[i][3] <= QUEUE_HIGH_MS || view[i][0] < tC) continue;
      let j = i;
      while (j + 1 < view.length && view[j + 1][3] > QUEUE_HIGH_MS) j += 1;
      const endsAt = j + 1 < view.length ? view[j + 1][0] : Infinity;
      const lasts = endsAt - view[i][0];
      const reactedInRun = reaction !== null && reaction >= view[i][0] && reaction <= endsAt;
      if (lasts >= 1000 || reactedInRun) {
        serverOnset = view[i][0];
        runInfo = { samples: j - i + 1, lastsMs: Number.isFinite(lasts) ? lasts : null, maxQueueMs: Math.max(...view.slice(i, j + 1).map((s) => s[3])) };
      }
      i = j;
    }
    const ladderMs = serverOnset !== null && reaction !== null ? reaction - serverOnset : null;

    // The link's view, for information: the first moment the shaper's down queue held a segment
    // for over 150 ms while collapsed.
    const linkOnsets = o.shaperSeconds.filter((b) => b.over150?.down && within(b.over150.down, tC, tR)).map((b) => b.over150.down);
    const linkOnset = linkOnsets.length ? Math.min(...linkOnsets) : null;
    const collapsedView = rttView.filter((s) => within(s[0], tC, tR));
    m.collapse = {
      kbps: def.collapse.kbps,
      serverOnsetMsAfterDrop: serverOnset !== null ? serverOnset - tC : null,
      serverRun: runInfo,
      reactionMsAfterDrop: reaction !== null ? reaction - tC : null,
      reactedBy: reaction === null ? null : stepSent && stepSent[0] === reaction ? 'FRAME at d=' + stepSent[2] : 'send gap (park)',
      ladderMsServerView: ladderMs,
      ladderMsFromLink: linkOnset !== null && reaction !== null ? reaction - linkOnset : null,
      linkOnsetMsAfterDrop: linkOnset !== null ? linkOnset - tC : null,
      clientYieldMsAfterDrop: yieldVis ? yieldVis[0] - tC : null,
      rttSamplesWhileCollapsed: collapsedView.length,
      maxQueueMsServerView: collapsedView.length ? Math.round(Math.max(...collapsedView.map((s) => s[3]))) : null,
      sendGaps: gapsInCollapse.map((g) => ({ fromMs: g.from - tC, toMs: g.to - tC, beats: g.beats, endedBy: g.endedBy })),
      collapsedWindows: frameWindows(store.frames, tC + 1000, Math.min(end, tR)),
      sentDuringCollapse: frameWindows(sentFrames, tC, Math.min(end, tR)),
      recoveryMs: null,
    };
    const label = 'steps down once queueing has held 1 s as the server sees it; first FRAME at the new rate within 1.25 s (ms after the server-view onset)';
    if (serverOnset === null) {
      const done = o.now >= tR;
      add('ladder', label, done ? 'never queued (server view)' : null, '<= ' + LADDER_LIMIT_MS, null, false, done ? 'the server never saw a sustained RTT rise: the game fits the collapsed link, no step needed' + (reaction !== null ? ' (it still reacted at +' + (reaction - tC) + ' ms)' : '') : undefined);
    } else {
      const note =
        (reaction === null ? 'no divisor step and no park' : m.collapse.reactedBy + ' left the server ' + ladderMs + ' ms after the onset') +
        (m.collapse.ladderMsFromLink !== null ? '; from the link (shaper queue > 150 ms → reaction): ' + m.collapse.ladderMsFromLink + ' ms' : '');
      add('ladder', label, ladderMs, '<= ' + LADDER_LIMIT_MS, ladderMs !== null ? ladderMs <= LADDER_LIMIT_MS : o.now > serverOnset + LADDER_LIMIT_MS ? false : null, ladderMs === null && o.now > serverOnset + LADDER_LIMIT_MS, note);
    }
    // At d = 6 the design rate is exactly 5 frames/s, so a single 1 s window can hold 4 by alignment
    // alone: the floor is judged on the mean over the collapsed period (from 1 s after the drop).
    const cw = m.collapse.collapsedWindows;
    const collapsedMin = cw.length ? Math.min(...cw) : null;
    const collapsedMean = cw.length ? round(sum(cw) / cw.length, 1) : null;
    m.collapse.collapsedMean = collapsedMean;
    m.collapse.collapsedMin = collapsedMin;
    const parkEnds = gapsInCollapse.map((g) => g.endedBy);
    const cleanPark = gapsInCollapse.length > 0 && gapsInCollapse.every((g) => g.endedBy === 'keyframe:2' || g.endedBy === 'keyframe:5') && laneEvents.length === 0;
    const floorDone = o.final || o.now >= tR + 5000;
    add(
      'collapse-floor',
      'frames/s while collapsed (mean from 1 s after the drop), or a clean park (ended by a keyframe)',
      cleanPark ? 'clean park (' + parkEnds.join(', ') + ')' : collapsedMean,
      '>= 5 or park',
      floorDone ? cleanPark || (collapsedMean !== null && collapsedMean >= 5) : null,
      false,
      (collapsedMin !== null ? 'min 1 s window ' + collapsedMin : '') + (!cleanPark && gapsInCollapse.length ? '; parks: ' + parkEnds.join(', ') : '') || undefined,
    );
    if (o.now >= tR) {
      const at = firstRateAt(store.frames, tR, tR + 5000, need);
      m.collapse.recoveryMs = at !== null ? at - tR : null;
      const done = at !== null || o.now >= tR + 6000 || o.final;
      add('recovery', 'back to >= ' + need + ' frames/s after the link returns (ms)', m.collapse.recoveryMs, '<= 5000', done ? at !== null && at - tR <= 5000 : null, at === null && o.now >= tR + 6000);
    } else {
      add('recovery', 'back to >= ' + need + ' frames/s after the link returns (ms)', null, '<= 5000', null);
    }
  }

  if (def.criteria.probeMaxMs !== undefined) {
    const limit = def.criteria.probeMaxMs;
    const worst = m.probeRttMs.max;
    const timeouts = m.probeRttMs.timeouts;
    add('probe-max', 'no probe over ' + limit / 1000 + ' s (max RTT, ms)', worst, '< ' + limit, worst === null ? (o.final ? false : null) : worst < limit && timeouts === 0 ? (o.final ? true : null) : false, (worst !== null && worst >= limit) || timeouts > 0);
  }

  const failed = checks.filter((c) => c.pass === false);
  const certainFail = checks.some((c) => c.certainFail);
  const verdict = failed.length > 0 || certainFail ? 'FAIL' : o.final ? 'PASS' : 'RUNNING';
  return { metrics: m, checks, verdict, certainFail };
};

const pad = (s, n) => String(s ?? '-').padEnd(n);
const fmt = (v) => (v === null || v === undefined ? '-' : String(v));

export const textSummary = (run) => {
  const lines = [];
  lines.push('Arcade netbench: game ' + run.game + ', client ' + run.client + ', link ' + run.linkLabel);
  lines.push('started ' + new Date(run.startedAt).toISOString() + ', wall ' + run.wallS + ' s (setup ' + run.setupS + ' s)');
  lines.push('');
  lines.push(
    pad('scenario', 10) +
      pad('frames/s med/min/mean', 23) +
      pad('chat ms p50/p95/max', 21) +
      pad('probe ms p95/max', 18) +
      pad('lane kbit/s dn/up', 19) +
      pad('bufAmt B', 10) +
      pad('disc', 6) +
      'result',
  );
  for (const s of run.scenarios) {
    const m = s.metrics;
    lines.push(
      pad(s.id, 10) +
        pad(fmt(m.frames.perSecondMedian) + ' / ' + fmt(m.frames.perSecondMin) + ' / ' + fmt(m.frames.perSecondMean), 23) +
        pad(fmt(m.chatOneWayMs.p50) + ' / ' + fmt(m.chatOneWayMs.p95) + ' / ' + fmt(m.chatOneWayMs.max), 21) +
        pad(fmt(m.probeRttMs.p95) + ' / ' + fmt(m.probeRttMs.max), 18) +
        pad(fmt(m.shaper.laneDownKbps.mean) + ' / ' + fmt(m.shaper.laneUpKbps.mean), 19) +
        pad(fmt(m.server.laneBufferedMax), 10) +
        pad(fmt(m.disconnects.pageMainSocket.length + m.disconnects.pageLane.length + m.disconnects.serverMainSocket.length + m.disconnects.serverLane.length), 6) +
        s.verdict +
        (s.aborted ? ' (stopped early: ' + s.aborted + ')' : '') +
        (m.sioDownKbps ? '  socket.io down [' + m.sioDownKbps.kinds.join(', ') + '] ' + fmt(m.sioDownKbps.kbps) + ' kbit/s' : ''),
    );
  }
  for (const s of run.scenarios) {
    lines.push('');
    lines.push('[' + s.id + '] measured ' + s.metrics.measuredS + ' s; divisors ' + JSON.stringify(s.metrics.frames.divisors) + '; keyframes ' + s.metrics.keyframes.n + ' ' + JSON.stringify(s.metrics.keyframes.reasons));
    lines.push('  frames per 1 s window: ' + s.metrics.frames.windows.join(' '));
    const ss = s.metrics.serverSend;
    lines.push('  server sent FRAMEs per 1 s window: ' + ss.framesPerSecond.join(' ') + '; divisors ' + JSON.stringify(ss.divisors) + '; keyframes ' + JSON.stringify(ss.keyframes.map((k) => k.reason)) + '; client VIS ' + JSON.stringify(ss.clientVis.map((v) => v.state)) + '; RESYNC ' + ss.clientResync);
    if (ss.gaps.length) lines.push('  send gaps >= 1 s: ' + ss.gaps.map((g) => g.ms + ' ms (' + g.beats + ' beats, ended by ' + g.endedBy + ')').join('; '));
    lines.push('  socket.io down bytes by event: ' + JSON.stringify(ss.socketIoDownBytes));
    lines.push('  shaper: down ' + fmt(s.metrics.shaper.totalDownKbps.mean) + ' kbit/s (max ' + fmt(s.metrics.shaper.totalDownKbps.max) + '), up ' + fmt(s.metrics.shaper.totalUpKbps.mean) + ' (max ' + fmt(s.metrics.shaper.totalUpKbps.max) + '); socket.io dn/up ' + fmt(s.metrics.shaper.sioDownKbps.mean) + ' / ' + fmt(s.metrics.shaper.sioUpKbps.mean) + '; queue wait max dn/up ' + s.metrics.shaper.queueWaitMaxMs.down + ' / ' + s.metrics.shaper.queueWaitMaxMs.up + ' ms; lost dn/up ' + s.metrics.shaper.lostSegments.down + ' / ' + s.metrics.shaper.lostSegments.up);
    lines.push('  watchdog: degrade level max ' + fmt(s.metrics.watchdog.maxLevel) + ', egress max ' + fmt(s.metrics.watchdog.egressKbpsMax) + ' kbit/s, loop p99 (stats().loopP99Ms, changes) ' + (s.metrics.watchdog.loopP99Ms.join(' ') || '-') + ' ms');
    lines.push('  server: main socket bufferedAmount max ' + s.metrics.server.mainBufferedMax + ' B, writeBuffer max ' + s.metrics.server.mainWriteBufferMax + ', bot lanes max ' + s.metrics.server.botLaneBufferedMax + ' B; yields ' + s.metrics.yields.length + '; ping timeouts ' + s.metrics.disconnects.pingTimeouts);
    if (s.metrics.collapse) {
      const c = s.metrics.collapse;
      lines.push(
        '  drop to ' + c.kbps + ' kbit/s (times after the drop): server RTT onset +' + fmt(c.serverOnsetMsAfterDrop) + ' ms ' + (c.serverRun ? JSON.stringify(c.serverRun) : '') +
          ', reaction +' + fmt(c.reactionMsAfterDrop) + ' ms (' + fmt(c.reactedBy) + '), ladder (server view) ' + fmt(c.ladderMsServerView) + ' ms; from the link: queue onset +' + fmt(c.linkOnsetMsAfterDrop) +
          ' ms, ladder ' + fmt(c.ladderMsFromLink) + ' ms; max queueing (server view) ' + fmt(c.maxQueueMsServerView) + ' ms over ' + c.rttSamplesWhileCollapsed + ' samples; client yield +' + fmt(c.clientYieldMsAfterDrop) + ' ms; recovery ' + fmt(c.recoveryMs) + ' ms',
      );
      lines.push('  collapsed: browser frames/s ' + c.collapsedWindows.join(' ') + '; server sent/s ' + c.sentDuringCollapse.join(' '));
    }
    for (const c of s.checks) lines.push('  ' + (c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'n/a ') + '  ' + c.label + ': ' + fmt(c.value) + ' (' + c.limit + ')' + (c.note ? ' — ' + c.note : ''));
  }
  if (run.notes.length) {
    lines.push('');
    for (const n of run.notes) lines.push('note: ' + n);
  }
  lines.push('');
  lines.push('overall: ' + run.verdict);
  return lines.join('\n');
};

export const writeReport = (dir, run) => {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(run, null, 2));
  const text = textSummary(run);
  writeFileSync(join(dir, 'summary.txt'), text + '\n');
  return text;
};
