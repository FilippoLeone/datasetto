/**
 * Free TCP ports. Other sessions on the same machine run Docker on 8080, Vite on 5173 and dev
 * stacks on many 41xx/43xx/51xx/53xx ports, so a port is taken only if `netstat` shows nobody
 * listening on it and an exclusive bind on every interface succeeds.
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';

export const listeningPorts = () => {
  const ports = new Set();
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line);
      if (m) ports.add(Number(m[1]));
    }
  } catch {
    /* no netstat: the bind test below still applies */
  }
  return ports;
};

const tryBind = (port, host) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });

/** An OS-assigned ephemeral port that nobody listens on (checked against netstat). */
export const freePort = async (avoid = new Set()) => {
  const busy = listeningPorts();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.unref();
      s.once('error', reject);
      s.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (busy.has(port) || avoid.has(port)) continue;
    if (!(await tryBind(port, '127.0.0.1'))) continue;
    avoid.add(port);
    return port;
  }
  throw new Error('no free port found');
};
