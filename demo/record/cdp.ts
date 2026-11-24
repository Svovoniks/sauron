// Small Chrome DevTools Protocol driver for recording the README demo. Needs only Bun and Google Chrome, no npm packages.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
export const W = 1280;
export const H = 760;
export const SCALE = 2;
/** Height the headless window frame takes from --window-size, so the page itself gets exactly W x H. */
const FRAME_H = Number(process.env.FRAME_H ?? 87);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Modifier bits of Input.dispatchKeyEvent. */
export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;

/** t is Chrome's paint time, arrived our wall clock when the frame came in (the two clocks differ). */
export interface Frame { file: string; t: number; arrived: number }
export interface Mark { name: string; t: number }

export class Page {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (value: any) => void>();
  private proc: ChildProcess | null = null;
  private mouse = { x: W / 2, y: H / 2 };
  private recording = false;
  private frameDir = "";
  frames: Frame[] = [];
  marks: Mark[] = [];

  constructor(private workDir: string) {}

  async launch() {
    const profile = `${this.workDir}/profile`;
    rmSync(profile, { recursive: true, force: true });
    this.proc = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      `--window-size=${W},${H + FRAME_H}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars", "--force-color-profile=srgb",
      "--no-first-run", "--no-default-browser-check", "--disable-component-update", "--disable-features=ChromeWhatsNewUI",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "about:blank",
    ], { stdio: "ignore" });
    let targets: any[] = [];
    for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
      await sleep(200);
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {}
    }
    const target = targets.find((t) => t.type === "page");
    if (!target) throw new Error("Chrome did not start");
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => (this.ws.onopen = resolve));
    this.ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)));
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // Chrome sometimes opens a page of its own (About Chrome after an update). The demo page then goes to the
    // background, stops painting, and input events wait forever, so close other pages and keep ours in front.
    setInterval(async () => {
      try {
        const now: any[] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        for (const t of now) if (t.type === "page" && t.id !== target.id) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
        await this.send("Page.bringToFront");
      } catch {}
    }, 1000);
  }

  private onMessage(message: any) {
    if (message.id && this.pending.has(message.id)) {
      this.pending.get(message.id)!(message.error ? Promise.reject(new Error(JSON.stringify(message.error))) : message.result);
      this.pending.delete(message.id);
      return;
    }
    if (message.method === "Page.screencastFrame") {
      const { data, metadata, sessionId } = message.params;
      void this.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (!this.recording) return;
      const file = `${this.frameDir}/f${String(this.frames.length).padStart(5, "0")}.jpg`;
      writeFileSync(file, Buffer.from(data, "base64"));
      this.frames.push({ file, t: metadata.timestamp, arrived: Date.now() / 1000 });
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  }

  async goto(url: string) {
    await this.send("Page.navigate", { url });
    await sleep(2500);
    await this.installCursor();
  }

  /** Waits until a JS expression is truthy. */
  async waitFor(expression: string, timeoutMs = 10_000) {
    for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(150)) {
      if (await this.eval(`!!(${expression})`)) return;
    }
    throw new Error(`timed out waiting for ${expression}`);
  }

  /** A drawn arrow pointer and click ring, since a headless capture has no mouse cursor. */
  private async installCursor() {
    await this.eval(`(() => {
      const cursor = document.createElement('div');
      cursor.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11.5 26 L15 24.5 L11 16 L18.5 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(${W / 2}px, ${H / 2}px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' });
      const ring = document.createElement('div');
      Object.assign(ring.style, { position: 'fixed', left: '-14px', top: '-14px', width: '28px', height: '28px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.85)', zIndex: 2147483646, pointerEvents: 'none', opacity: '0' });
      document.documentElement.append(cursor, ring);
      window.__cursor = (x, y) => { cursor.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)'; };
      window.__ring = (x, y) => ring.animate(
        [{ transform: 'translate(' + x + 'px,' + y + 'px) scale(.4)', opacity: 1 }, { transform: 'translate(' + x + 'px,' + y + 'px) scale(1.3)', opacity: 0 }],
        { duration: 450, easing: 'ease-out' });
    })()`);
  }

  async startRecording(dir: string) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.frameDir = dir;
    this.frames = [];
    this.marks = [];
    this.recording = true;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
  }

  async stopRecording() {
    await sleep(300);
    this.recording = false;
    await this.send("Page.stopScreencast");
  }

  /** Names the moment a scene starts; record.sh cuts one GIF per scene. */
  mark(name: string) {
    this.marks.push({ name, t: Date.now() / 1000 });
  }

  /** Centre of the first visible element matching a selector, optionally the one whose text equals (or starts with) text. */
  async center(selector: string, text?: string, exact = true): Promise<{ x: number; y: number }> {
    for (let i = 0; i < 40; i++) {
      const point = await this.eval(`(() => {
        const want = ${JSON.stringify(text ?? null)};
        const found = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (want === null) return true;
          const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
          return ${exact} ? t === want : t.startsWith(want);
        });
        if (!found) return null;
        const r = found.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (point) return point;
      await sleep(150);
    }
    throw new Error(`not found: ${selector} ${text ?? ""}`);
  }

  /** Glides the pointer to a point with an ease-in-out curve. */
  async moveTo(x: number, y: number, ms = 450) {
    const from = { ...this.mouse };
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const px = from.x + (x - from.x) * e;
      const py = from.y + (y - from.y) * e;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      await this.eval(`window.__cursor && window.__cursor(${px}, ${py})`);
      await sleep(ms / steps);
    }
    this.mouse = { x, y };
  }

  async click(selector: string, text?: string, opts: { exact?: boolean; dx?: number; dy?: number } = {}) {
    const p = await this.center(selector, text, opts.exact ?? true);
    await this.clickAt(p.x + (opts.dx ?? 0), p.y + (opts.dy ?? 0));
  }

  async clickAt(x: number, y: number) {
    await this.moveTo(x, y);
    await sleep(120);
    await this.eval(`window.__ring && window.__ring(${x}, ${y})`);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /**
   * One key press. On macOS editing shortcuts such as Cmd+A only work when passed as commands
   * (for example key("a", META, ["selectAll"])); app shortcuts are plain key events.
   */
  async key(key: string, mods = 0, commands: string[] = []) {
    const named: Record<string, [string, number]> = {
      Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8],
      ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
    };
    const [code, keyCode] = named[key] ?? [/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === "," ? "Comma" : "", key.toUpperCase().charCodeAt(0)];
    const text = key === "Enter" && mods === 0 ? "\r" : key.length === 1 && (mods & (CTRL | META)) === 0 ? key : undefined;
    const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { ...common, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text, commands });
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }

  /** Types text one character at a time with a slightly uneven rhythm, like a person. */
  async type(text: string, delay = 55) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(delay + Math.random() * delay * 0.6);
    }
  }

  async screenshot(file: string) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }

  close() {
    try { this.ws.close(); } catch {}
    this.proc?.kill();
  }
}
