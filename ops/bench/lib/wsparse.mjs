/**
 * A streaming WebSocket frame reader for the shaper: it skips the HTTP upgrade request or response,
 * then calls `onMessage(opcode, head, length)` for every frame, with the first 64 payload bytes
 * unmasked. The shaper uses it to see what the server sent and when (lane message types and
 * divisors, Socket.IO event names) independently of the link's delay.
 */
const HEAD = 64;

export const createWsReader = (onMessage) => {
  let http = true;
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    if (http) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 16384) buf = Buffer.alloc(0);
        return;
      }
      buf = buf.subarray(end + 4);
      http = false;
    }
    for (;;) {
      if (buf.length < 2) return;
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const n = Math.min(len, HEAD);
      const head = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i += 1) head[i] = masked ? buf[off + i] ^ buf[maskAt + (i & 3)] : buf[off + i];
      onMessage(buf[0] & 0x0f, head, len);
      buf = buf.subarray(off + len);
    }
  };
};

/** A Socket.IO text frame's kind: the event name, `ack`, `ping`, `pong` or `other`. */
export const sioKind = (head) => {
  const text = head.toString('latin1');
  const event = /^42\d*\["([^"]{1,40})"/.exec(text);
  if (event) return event[1];
  if (/^43\d*/.test(text)) return 'ack';
  if (text === '2') return 'ping';
  if (text === '3') return 'pong';
  return 'other';
};
