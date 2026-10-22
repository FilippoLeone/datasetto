/**
 * The Origin rule shared by HTTP CORS, Socket.IO and the Arcade action lane (`/arcade/ws`).
 */
import { describe, expect, it } from 'vitest';
import { createOriginChecker } from '../src/http/origins.js';

describe('createOriginChecker', () => {
  const native = createOriginChecker({ origins: ['https://chat.example.com'], allowNativeOrigins: true });
  const webOnly = createOriginChecker({ origins: ['https://chat.example.com'], allowNativeOrigins: false });

  it('allows the configured origins, case and trailing slash aside, and requests without an Origin', () => {
    expect(native('https://chat.example.com')).toBe(true);
    expect(native('https://Chat.Example.com/')).toBe(true);
    expect(native(undefined)).toBe(true);
    expect(native('https://evil.example')).toBe(false);
  });

  it("allows the native shells' origins, including Electron's file:// (sent by its WebSockets)", () => {
    for (const origin of ['file://', 'FILE://', 'file:', 'null', 'capacitor://localhost', 'app://datasetto', 'http://localhost', 'https://localhost:5173', 'http://127.0.0.1:4000']) {
      expect(native(origin), origin).toBe(true);
    }
    expect(native('https://localhost.evil.example')).toBe(false);
  });

  it('refuses the native origins when they are turned off', () => {
    for (const origin of ['file://', 'null', 'capacitor://localhost', 'http://localhost']) expect(webOnly(origin), origin).toBe(false);
  });
});
