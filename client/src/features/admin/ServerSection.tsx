import { useEffect } from 'preact/hooks';
import { RefreshCw, Server } from 'lucide-preact';
import { Button } from '@/components';
import { formatDuration, formatFullDate } from '@/lib/format';
import { api } from '@/services/socket/api';
import { adminServerInfo } from '@/state/misc';

const Row = ({ label, value, hint }: { label: string; value: preact.ComponentChildren; hint?: string }) => (
  <div className="flex gap-3 py-1.5 text-sm">
    <dt className="w-44 shrink-0 text-text-muted" title={hint}>
      {label}
    </dt>
    <dd className="min-w-0 flex-1 break-words text-text-bright">{value}</dd>
  </div>
);

const Group = ({ title, children }: { title: string; children: preact.ComponentChildren }) => (
  <section className="rounded-md bg-base/60 p-3">
    <p className="mb-1 text-sm font-semibold text-text-bright">{title}</p>
    <dl className="divide-y divide-border">{children}</dl>
  </section>
);

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** Read-only view of the running configuration (superusers). Values come from the server's environment. */
export const ServerSection = () => {
  const info = adminServerInfo.value;

  useEffect(() => {
    api.getServerInfo();
  }, []);

  if (!info) return <p className="text-sm text-text-muted">Loading server information…</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm text-text-muted">
          <Server size={14} /> Read from the server's environment (ops/.env). Change values there and restart the app container.
        </p>
        <Button size="sm" variant="ghost" onClick={() => api.getServerInfo()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      <Group title="Server">
        <Row label="Version" value={info.version + ' (' + info.env + ', Node ' + info.node + ')'} />
        <Row label="Up since" value={formatFullDate(info.startedAt) + ' · ' + formatDuration(info.uptimeSeconds * 1000)} />
        <Row label="Accounts / channels" value={info.counts.accounts + ' / ' + info.counts.channels} />
        <Row label="Messages stored" value={String(info.counts.messages)} />
        <Row label="Online now" value={String(info.counts.online)} />
        <Row label="Invite links" value={String(info.counts.invites)} />
      </Group>
      <Group title="Registration and sessions">
        <Row label="Registration mode" value={info.registration.mode} hint="REGISTRATION_MODE" />
        <Row label="Shared invite code set" value={yesNo(info.registration.inviteCodeSet)} hint="REGISTRATION_INVITE_CODE" />
        <Row label="Always superuser" value={info.registration.adminEmails.length > 0 ? info.registration.adminEmails.join(', ') : 'none'} hint="ADMIN_EMAILS" />
        <Row label="Session lifetime" value={info.sessions.ttlDays + ' days (sliding)'} hint="SESSION_TTL_DAYS" />
        <Row label="One active login per account" value={yesNo(info.sessions.singlePerAccount)} hint="SINGLE_SESSION_PER_ACCOUNT" />
        <Row label="Password minimum length" value={String(info.security.passwordMinLength)} hint="PASSWORD_MIN_LENGTH" />
        <Row label="Connections per IP" value={String(info.security.maxConnectionsPerIp)} hint="MAX_CONNECTIONS_PER_IP" />
        <Row label="Behind a proxy" value={yesNo(info.security.trustProxy)} hint="TRUST_PROXY" />
      </Group>
      <Group title="Limits">
        <Row label="Channels" value={String(info.limits.maxChannels)} hint="MAX_CHANNELS" />
        <Row label="Message length" value={info.limits.maxMessageLength + ' characters'} hint="MAX_MESSAGE_LENGTH" />
        <Row label="History per channel" value={info.limits.chatHistoryLimit + ' loaded, ' + info.limits.messageRetentionPerChannel + ' kept'} hint="CHAT_HISTORY_LIMIT / MESSAGE_RETENTION_PER_CHANNEL" />
        <Row label="Messages per minute" value={String(info.limits.maxMessagesPerMinute)} hint="MAX_MESSAGES_PER_MINUTE" />
      </Group>
      <Group title="Streaming">
        <Row label="Viewers per stream" value={info.streaming.maxViewers > 0 ? String(info.streaming.maxViewers) : 'no limit'} hint="STREAM_MAX_VIEWERS" />
        <Row label="Ingest bitrate cap" value={info.streaming.maxBitrateKbps > 0 ? info.streaming.maxBitrateKbps + ' kbps' : 'no limit'} hint="STREAM_MAX_BITRATE_KBPS" />
        <Row label="Monthly egress budget" value={info.streaming.monthlyEgressBytes > 0 ? (info.streaming.monthlyEgressBytes / 1e9).toFixed(0) + ' GB' : 'no limit'} hint="STREAM_MONTHLY_EGRESS_GB" />
        <Row label="Watchdog (rtmp stat)" value={yesNo(info.streaming.watchdog)} hint="RTMP_STAT_URL" />
        <Row label="HLS ticket secret set" value={yesNo(info.streaming.ticketSecretSet)} hint="HLS_TICKET_SECRET" />
        <Row label="Public RTMP / HLS" value={(info.urls.rtmp ?? 'derived') + ' · ' + (info.urls.hls ?? 'derived')} hint="PUBLIC_RTMP_URL / PUBLIC_HLS_URL" />
      </Group>
      <Group title="Voice relay (TURN)">
        <Row label="TURN enabled" value={yesNo(info.turn.enabled)} hint="TURN_URLS / TURN_SECRET" />
        <Row label="TURN servers" value={info.turn.urls.length > 0 ? info.turn.urls.join(', ') : 'none'} />
        <Row label="STUN servers" value={info.turn.stunUrls.join(', ')} hint="STUN_URLS" />
        <Row label="Credential lifetime" value={formatDuration(info.turn.credentialTtlSeconds * 1000)} hint="TURN_CREDENTIAL_TTL_SECONDS" />
      </Group>
      <Group title="Storage and origins">
        <Row label="Database" value={info.storage.databasePath} hint="DATABASE_PATH" />
        <Row label="Uploads" value={info.storage.dataDir} hint="DATA_DIR" />
        <Row label="Allowed origins" value={info.cors.join(', ')} hint="CORS_ORIGINS" />
      </Group>
    </div>
  );
};
