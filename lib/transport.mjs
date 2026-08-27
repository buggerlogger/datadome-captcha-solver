import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findGoBinary() {
  const env = process.env.DD_GO;
  if (env && existsSync(env)) return resolve(env);
  const local = join(__dirname, '..', 'bin', process.platform === 'win32' ? 'fetch.exe' : 'fetch');
  return existsSync(local) ? local : null;
}

const GO = findGoBinary();
export const PROXY = process.env.PROXY || '';
export const TLS_PROFILE = process.env.TLS_PROFILE || 'chrome_win10';
const TLS_MODE = (process.env.TLS || '').toLowerCase();
export const USE_UTLS = TLS_MODE === 'chrome' || !!PROXY || (TLS_MODE !== 'node' && !!GO);

if (USE_UTLS && !GO) {
  throw new Error('Chrome TLS / proxy transport requested but no binary was found. '
    + 'Point DD_GO at a uTLS fetch binary, or set TLS=node to use Node\'s own TLS stack.');
}

export function describeTransport() {
  if (!USE_UTLS) return 'node fetch (Node TLS fingerprint, no proxy)';
  const p = PROXY ? PROXY.replace(/:[^:]*$/, ':***') : 'direct';
  return `uTLS ${TLS_PROFILE} via ${GO.split(/[\\/]/).pop()}  proxy=${p}`;
}

function parseGoOutput(out, bodyPath) {
  const status = Number((out.match(/->\s*(\d{3})\b/) || [])[1] || 0);
  const headers = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s{2,}([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) {
      const k = m[1].toLowerCase();
      if (k === 'set-cookie') { const a = headers.get(k) || []; a.push(m[2]); headers.set(k, a); }
      else headers.set(k, m[2]);
    }
  }
  let body = '';
  try { if (bodyPath && existsSync(bodyPath)) body = readFileSync(bodyPath, 'utf8'); } catch (_) {}
  if (!body) { const i = out.indexOf('<html'); if (i >= 0) body = out.slice(i); }
  return { status, headers, body };
}

const samples = [];

function record(ms, bytes) {
  if (ms > 0 && bytes > 0) samples.push({ ms, bytes });
}

export function networkSample() {
  if (samples.length < 2) return null;
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const rtt = Math.round(ms[0] / 25) * 25;
  const fast = samples.filter((s) => s.ms <= ms[1]);
  const bps = fast.reduce((a, s) => a + s.bytes, 0) * 8000 / fast.reduce((a, s) => a + s.ms, 0);
  const downlink = Math.round(Math.min(10, bps / 1e6) / 0.025) * 0.025;
  if (rtt < 25 || rtt > 300 || downlink < 1 || downlink > 10) return null;
  return { effectiveType: '4g', downlink, rtt, saveData: false };
}

export async function httpGet(url, opts = {}) {
  const { cookie = '', referer = '', mode = 'navigate', headers: extra = {} } = opts;
  const sendCookie = mode === 'check' ? '' : cookie;
  const t0 = Date.now();

  if (!USE_UTLS) {
    const h = mode === 'check' ? { ...extra } : { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...extra };
    if (sendCookie) h.cookie = sendCookie;
    if (referer) h.referer = referer;
    const res = await fetch(url, { method: 'GET', headers: h, redirect: 'manual' });
    const body = await res.text();
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    record(Date.now() - t0, body.length);
    return { status: res.status, body, header: (n) => res.headers.get(n), setCookies: sc };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ddfetch-'));
  const bodyPath = join(tmp, 'body.html');
  const args = ['-fetch', url, '-fetch-mode', mode, '-profile', TLS_PROFILE, '-save', bodyPath];
  if (sendCookie) args.push('-fetch-cookie', sendCookie);
  if (referer) args.push('-fetch-referer', referer);
  if (PROXY) args.push('-proxy', PROXY);
  const r0 = spawnSync(GO, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = String(r0.stdout || '') + '\n' + String(r0.stderr || '');
  if (!/->\s*\d{3}/.test(out) && !existsSync(bodyPath)) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw new Error('uTLS fetch failed: ' + out.trim().slice(0, 300));
  }
  const r = parseGoOutput(out, bodyPath);
  try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  record(Date.now() - t0, String(r.body).length);
  return {
    status: r.status, body: r.body,
    header: (n) => { const v = r.headers.get(String(n).toLowerCase()); return Array.isArray(v) ? v.join(', ') : (v ?? null); },
    setCookies: r.headers.get('set-cookie') || [],
  };
}

export async function closeTransport() {
  const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (d && typeof d.close === 'function') { try { await d.close(); } catch (_) {} }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
