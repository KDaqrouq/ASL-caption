// End-to-end smoke test: loads dist/ as an unpacked extension in Chrome, serves a stub
// page at https://meet.google.com/ (with a strict, Meet-like CSP) and checks that the
// overlay mounts, the camera starts and MediaPipe hand tracking initialises.
//
// Usage: npm run build && node scripts/e2e.mjs [--video path/to/fake.mjpeg] [--keep-open]
// Set CHROME_PATH if Chrome is not in the default location.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
const videoIdx = args.indexOf('--video');
const video = videoIdx >= 0 ? resolve(args[videoIdx + 1]) : null;
const keepOpen = args.includes('--keep-open');

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('Chrome not found; set CHROME_PATH');
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Run `npm run build` first');

const STUB = `<!doctype html><html><head><title>Meet stub</title></head>
<body style="background:#202124;color:#fff;font-family:sans-serif"><p>Stub Meet page</p></body></html>`;
// Stricter than Meet's policy: nonce-only scripts (no eval or WASM) and Trusted Types.
const CSP =
  "script-src 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'";

const browser = await puppeteer.launch({
  executablePath,
  headless: !keepOpen,
  pipe: true,
  enableExtensions: [dist],
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().startsWith('https://meet.google.com/')) {
    req.respond({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': CSP }, body: STUB });
  } else {
    req.continue();
  }
});

await page.goto('https://meet.google.com/abc-defg-hij');
await page.waitForSelector('#asl-meet-captions-host', { timeout: 15000 });

const readUi = () =>
  page.evaluate(() => {
    const sr = document.getElementById('asl-meet-captions-host')?.shadowRoot;
    const q = (s) => sr?.querySelector(s);
    return {
      status: q('.asl-status')?.textContent ?? null,
      tracking: q('.asl-panel')?.getAttribute('data-tracking') ?? null,
      hands: q('.asl-panel')?.getAttribute('data-hands') ?? null,
      subtitle: q('.asl-subtitle')?.textContent ?? null,
    };
  });

let ui = await readUi();
const deadline = Date.now() + 30000;
while (Date.now() < deadline && ui.tracking !== 'ready' && ui.tracking !== 'error') {
  await new Promise((r) => setTimeout(r, 500));
  ui = await readUi();
}
console.log('UI state:', ui);
if (video) {
  // Let the fake feed play long enough for hands to be detected.
  const until = Date.now() + 8000;
  let maxHands = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    maxHands = Math.max(maxHands, Number((await readUi()).hands ?? 0));
  }
  console.log('Max hands seen:', maxHands);
}
console.log(logs.slice(-15).join('\n'));

if (keepOpen) {
  console.log('Browser left open; Ctrl+C to exit.');
} else {
  await browser.close();
  process.exit(ui.tracking === 'ready' ? 0 : 1);
}
