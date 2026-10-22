/**
 * A minimal Chrome DevTools Protocol driver (promoted from the project's idle-cost harness).
 *
 * Every Chrome it starts is headless and muted (`--mute-audio`), with fake media devices and a
 * silent WAV as the microphone, so nothing can reach the speakers. The profile is a short folder
 * under %TEMP% (long paths break IndexedDB); the DevTools port is chosen by Chrome
 * (`--remote-debugging-port=0`, read back from DevToolsActivePort). `kill()` ends the process tree
 * by PID and removes the profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

export const chromePath = () => {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found (set CHROME_PATH)');
  return found;
};

const TEMP = join(tmpdir(), 'ds-nb');

/** 10 s of 48 kHz mono 16-bit silence: the fake microphone. */
export const silentWav = () => {
  const file = join(TEMP, 'silent.wav');
  if (existsSync(file)) return file;
  mkdirSync(TEMP, { recursive: true });
  const rate = 48000;
  const data = rate * 10 * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  writeFileSync(file, buf);
  return file;
};

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message + ' (' + JSON.stringify(message.error) + ')'));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('devtools connection closed'));
      this.pending.clear();
    };
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

const openSocket = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (event) => reject(new Error('websocket error ' + (event.message || url)));
  });

export class Page extends Connection {
  constructor(ws, name) {
    super(ws);
    this.name = name;
    this.console = [];
    this.navigations = [];
    this.on((message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
        this.console.push({ t: Date.now(), type: message.params.type, text: text.slice(0, 500) });
        if (this.console.length > 400) this.console.shift();
      } else if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails;
        this.console.push({ t: Date.now(), type: 'exception', text: String(d.exception?.description ?? d.text).slice(0, 500) });
      } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        this.navigations.push({ t: Date.now(), url: message.params.frame.url });
      }
    });
  }
  async eval(expression, timeoutMs = 30000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => {
        throw new Error(this.name + ' eval timed out after ' + timeoutMs + ' ms');
      }),
    ]);
    if (result.exceptionDetails) throw new Error(this.name + ' eval failed: ' + (result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)));
    return result.result.value;
  }
  async waitFor(expression, { timeout = 20000, interval = 200, label = expression } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      last = await this.eval(expression);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(this.name + ' timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  }
  async goto(url, waitMs = 30000) {
    const loaded = new Promise((resolve) => {
      const off = this.on((m) => {
        if (m.method === 'Page.loadEventFired') {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, waitMs);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }
}

export const killTree = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });

const waitForFile = async (file, timeout) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      if (text.includes('\n')) return text;
    }
    await sleep(100);
  }
  throw new Error('Chrome did not open its DevTools port');
};

/** Headless, muted Chrome with a silent fake microphone. Returns { page, browser, pid, kill }. */
export const launchChrome = async ({ name = 'shaped', width = 1280, height = 800, args = [] } = {}) => {
  const profile = join(TEMP, 'p' + Date.now().toString(36));
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chromePath(),
    [
      '--headless=new',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${silentWav()}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=TranslateUI,MediaRouter,OptimizationHints',
      ...args,
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  let browser = null;
  let page = null;
  const kill = async () => {
    try {
      if (browser) await Promise.race([browser.send('Browser.close'), sleep(1500)]);
    } catch {
      /* closing */
    }
    page?.close();
    browser?.close();
    killTree(child.pid);
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  };
  try {
    const active = await waitForFile(join(profile, 'DevToolsActivePort'), 20000);
    const [portLine, pathLine] = active.split(/\r?\n/);
    const port = Number(portLine);
    browser = new Connection(await openSocket(`ws://127.0.0.1:${port}${pathLine}`));
    let target = null;
    for (let i = 0; i < 20 && !target; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('no page target');
    page = new Page(await openSocket(target.webSocketDebuggerUrl), name);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return { page, browser, pid: child.pid, profile, kill };
  } catch (error) {
    await kill();
    throw error;
  }
};
