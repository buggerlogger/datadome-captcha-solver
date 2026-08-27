import { webcrypto } from 'node:crypto';
import { Writable } from 'node:stream';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas as createSkiaCanvas, GlobalFonts } from '@napi-rs/canvas';
import { baseDevice } from '../lib/device_profile.mjs';
import { gpuWorkerTextHash } from '../lib/gpu-canvas.mjs';
import * as GPU from '../lib/gpu-canvas.mjs';

try {
  const windir = process.env.WINDIR || 'C:/Windows';
  for (const [file, family] of [
    ['arial.ttf', 'sans-serif'], ['arial.ttf', 'Arial'],
    ['times.ttf', 'serif'], ['times.ttf', 'Times New Roman'],
    ['cour.ttf', 'monospace'], ['cour.ttf', 'Courier New'],
  ]) {
    const p = join(windir, 'Fonts', file);
    if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
} catch (_) {}

let PENDING_RENDER_MS = 0;
function chargeRender(ms) { PENDING_RENDER_MS += ms; }
function drainRenderMs() { const t = PENDING_RENDER_MS; PENDING_RENDER_MS = 0; return t; }

function gpuUsable(el) {
  return el && el._opsUsable !== false && Array.isArray(el._ops) && GPU && GPU.gpuAvailable();
}
function gpuFillPixels(el, args, imageData) {
  if (process.env.DD_GPU_PX === '0') return imageData;
  if (!gpuUsable(el) || !imageData || !imageData.data) return imageData;
  const w = Math.max(1, Number(el.width) || 300), h = Math.max(1, Number(el.height) || 150);
  const rect = [Number(args[0]) || 0, Number(args[1]) || 0, Math.max(1, Number(args[2]) || 1), Math.max(1, Number(args[3]) || 1)];
  const r = GPU.gpuRenderSync({ w, h, ops: el._ops, mode: 'px', rect });
  if (r && Array.isArray(r.px) && r.px.length === imageData.data.length) {
    try { imageData.data.set(r.px); } catch (_) {}
  }
  return imageData;
}
function gpuDataURL(el, type, quality) {
  if (!gpuUsable(el)) return null;
  const w = Math.max(1, Number(el.width) || 300), h = Math.max(1, Number(el.height) || 150);
  const r = GPU.gpuRenderSync({ w, h, ops: el._ops, mode: 'url', type: typeof type === 'string' ? type : null, quality: quality ?? null });
  return r && typeof r.url === 'string' ? r.url : null;
}

const KNOWN_FONT_FAMILIES = (() => {
  try { return new Set((GlobalFonts.families || []).map((f) => String(f.family || f).toLowerCase())); }
  catch (_) { return new Set(); }
})();
function normalizeFontString(font) {
  const s = String(font);
  const m = s.match(/^(.*?\d[\d.]*(?:px|pt|em|rem|ex|ch|%|vw|vh)\s+)(.+)$/i);
  if (!m) return s;
  const prefix = m[1];
  const families = m[2].split(',');
  let fam = families[0].trim().replace(/^["']|["']$/g, '');
  const low = fam.toLowerCase();
  let mapped = null;
  if (low === 'serif' || low === 'cursive' || low === 'fantasy') mapped = 'Times New Roman';
  else if (low === 'sans-serif' || low === 'system-ui' || low === 'ui-sans-serif') mapped = 'Arial';
  else if (low === 'monospace' || low === 'ui-monospace') mapped = 'Courier New';
  else if (!KNOWN_FONT_FAMILIES.has(low)) mapped = 'Times New Roman';
  if (!mapped) return s;
  families[0] = mapped;
  return prefix + families.join(',');
}
const CTX_STATE_PROPS = new Set(['fillStyle', 'strokeStyle', 'font', 'globalCompositeOperation',
  'globalAlpha', 'filter', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'shadowBlur', 'shadowColor',
  'shadowOffsetX', 'shadowOffsetY', 'textAlign', 'textBaseline', 'direction', 'imageSmoothingEnabled',
  'imageSmoothingQuality', 'letterSpacing', 'wordSpacing', 'fontKerning']);

function fontNormCtx(ctx, el) {
  const ops = (el._ops = []);
  const mark = () => { el._opsUsable = false; };
  return new Proxy(ctx, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      const name = String(p);
      return function (...a) {
        if (/^create(Linear|Radial|Conic)Gradient$/.test(name)) {
          const out = v.apply(t, a);
          const id = ops.length + 1;
          const stops = [];
          ops.push({ t: 'g', i: id, k: name[6] === 'R' ? 'r' : name[6] === 'C' ? 'c' : 'l', a: a.map(Number), s: stops });
          if (out && typeof out.addColorStop === 'function') {
            const orig = out.addColorStop.bind(out);
            Object.defineProperty(out, 'addColorStop', {
              configurable: true, writable: true,
              value: (off, col) => { stops.push([Number(off), String(col)]); return orig(off, col); },
            });
          }
          if (out && typeof out === 'object') { try { out.__gcId = id; } catch (_) {} }
          return out;
        }
        if (name === 'getImageData') {
          const px = Math.max(1, (Number(a[2]) || 1) * (Number(a[3]) || 1));
          chargeRender(0.06 + px / 90000 * 0.5);
          return gpuFillPixels(el, a, v.apply(t, a));
        }
        if (name === 'createPattern' || name === 'drawImage' || name === 'putImageData') mark();
        else if (a.every((x) => x == null || typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean')) {
          ops.push({ t: 'c', m: name, a });
        } else mark();
        return v.apply(t, a);
      };
    },
    set(t, p, val) {
      const name = String(p);
      if (CTX_STATE_PROPS.has(name)) {
        if (val && typeof val === 'object') {
          if (val.__gcId != null) ops.push({ t: 's', p: name, g: val.__gcId });
          else mark();
        } else ops.push({ t: 's', p: name, v: typeof val === 'number' ? val : String(val) });
      }
      t[p] = (name === 'font') ? normalizeFontString(val) : val;
      return true;
    },
  });
}

function traceCtx(ctx, w, h) {
  const log = (globalThis.__CTXLOG = globalThis.__CTXLOG || []);
  const drawish = new Set(['fillRect','strokeRect','clearRect','fillText','strokeText','fill','stroke',
    'beginPath','closePath','moveTo','lineTo','arc','arcTo','bezierCurveTo','quadraticCurveTo','rect',
    'ellipse','drawImage','putImageData','createLinearGradient','createRadialGradient','createConicGradient',
    'createPattern','setTransform','transform','translate','rotate','scale','save','restore','clip',
    'getImageData','measureText','setLineDash','roundRect']);
  return new Proxy(ctx, {
    get(t, p) {
      const v = t[p];
      if (typeof v === 'function') {
        return function (...a) {
          const exists = typeof ctx[p] === 'function';
          let rec = { m: String(p), exists };
          if (p === 'fillText' || p === 'strokeText') rec.args = [String(a[0]).slice(0, 30), a[1], a[2]];
          else if (drawish.has(p)) rec.args = a.slice(0, 6).map(x => (typeof x === 'object' ? (x && x.constructor && x.constructor.name) || 'obj' : x));
          log.push(rec);
          try {
            const out = v.apply(t, a);
            if (/^create(Linear|Radial|Conic)Gradient$/.test(String(p)) && out && typeof out.addColorStop === 'function') {
              const stops = [];
              rec.stops = stops;
              const orig = out.addColorStop.bind(out);
              Object.defineProperty(out, 'addColorStop', {
                configurable: true, writable: true,
                value: (off, col) => { stops.push([off, String(col)]); return orig(off, col); },
              });
            }
            return out;
          } catch (e) { rec.threw = String(e).slice(0, 60); return undefined; }
        };
      }
      return v;
    },
    set(t, p, val) {
      if (['fillStyle','strokeStyle','font','globalCompositeOperation','globalAlpha','filter','lineWidth','shadowBlur','shadowColor','textAlign','textBaseline'].includes(String(p)))
        log.push({ set: String(p), v: typeof val === 'object' ? (val && val.constructor && val.constructor.name) || 'obj' : String(val).slice(0, 40) });
      t[p] = val; return true;
    },
  });
}

function attachSkiaCanvas(el) {
  const w = Math.max(1, Number(el.width) || 300);
  const h = Math.max(1, Number(el.height) || 150);
  el._skiaCanvas = createSkiaCanvas(w, h);
  el._opsUsable = true;
  el._ctx2d = fontNormCtx(el._skiaCanvas.getContext('2d'), el);
  if (process.env.DD_TRACE_CTX) el._ctx2d = traceCtx(el._ctx2d, w, h);
  return el._ctx2d;
}

export const NATIVE_FNS = new WeakMap();
let VM_FN_PROTO = null;
export function adoptFns(o) {
  if (!o) return o;
  nativizeAll(o);
  return o;
}

import { loadWindowGlobals, withEnumeratedGlobals } from './window_globals.mjs';
import { buildFragment, findInTree, evalLength, substituteVars } from './css_layout.mjs';
import { computeTransform, computeColor } from './css_transform.mjs';
import { compileFragmentShader, toBytes } from './glsl_eval.mjs';

const REAL_GLOBALS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../dump/real_window_globals.json'), join(here, 'real_window_globals.json'),
                   join(here, '../../dump/real_window_globals.json')]) {
    try { if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); return j.iframeGlobals || j.globals || j; } } catch (_) {}
  }
  return [];
})();

const _PluginCtor = nativeCtor('Plugin');
const _PluginArrayCtor = nativeCtor('PluginArray');
const _MimeTypeCtor = nativeCtor('MimeType');
const _MimeTypeArrayCtor = nativeCtor('MimeTypeArray');
const _pluginData = new WeakMap();
function _defProtoGetters(proto, props) {
  for (const p of props) Object.defineProperty(proto, p, {
    configurable: true, enumerable: true,
    get: markNative(function () { const d = _pluginData.get(this); return d ? d[p] : undefined; }, 'get ' + p) });
}
_defProtoGetters(_PluginCtor.prototype, ['name', 'filename', 'description', 'length']);
_defProtoGetters(_MimeTypeCtor.prototype, ['type', 'suffixes', 'description', 'enabledPlugin']);
Object.defineProperty(_PluginArrayCtor.prototype, 'length', { configurable: true, enumerable: true, get: markNative(function () { return _pluginData.get(this).length; }, 'get length') });
Object.defineProperty(_MimeTypeArrayCtor.prototype, 'length', { configurable: true, enumerable: true, get: markNative(function () { return _pluginData.get(this).length; }, 'get length') });
for (const proto of [_PluginCtor.prototype, _PluginArrayCtor.prototype, _MimeTypeArrayCtor.prototype]) {
  Object.defineProperty(proto, 'item', { configurable: true, writable: true, value: markNative(function item(i) { i = i >>> 0; return i < this.length ? this[i] : null; }, 'item') });
  Object.defineProperty(proto, 'namedItem', { configurable: true, writable: true, value: markNative(function namedItem(n) { const v = this[n]; return v == null ? null : v; }, 'namedItem') });
}
Object.defineProperty(_PluginArrayCtor.prototype, 'refresh', { configurable: true, writable: true, value: markNative(function refresh() {}, 'refresh') });
for (const [proto, tag] of [[_PluginCtor.prototype, 'Plugin'], [_PluginArrayCtor.prototype, 'PluginArray'], [_MimeTypeCtor.prototype, 'MimeType'], [_MimeTypeArrayCtor.prototype, 'MimeTypeArray']])
  Object.defineProperty(proto, Symbol.toStringTag, { configurable: true, value: tag });

function makePluginsAndMimeTypes() {
  const mkMime = (data) => { const m = Object.create(_MimeTypeCtor.prototype); _pluginData.set(m, data); return m; };
  const mimeTypes = [
    mkMime({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
    mkMime({ type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
  ];
  const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
  const plugins = names.map((name) => {
    const p = Object.create(_PluginCtor.prototype);
    _pluginData.set(p, { name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 });
    p[0] = mimeTypes[0]; p[1] = mimeTypes[1]; p[mimeTypes[0].type] = mimeTypes[0]; p[mimeTypes[1].type] = mimeTypes[1];
    return p;
  });
  const plugArr = Object.create(_PluginArrayCtor.prototype);
  _pluginData.set(plugArr, { length: plugins.length });
  Object.defineProperty(plugArr, Symbol.iterator, { configurable: true, writable: true, value: function () { return plugins[Symbol.iterator](); } });
  plugins.forEach((p, i) => { plugArr[i] = p; plugArr[_pluginData.get(p).name] = p; });
  const mimeArr = Object.create(_MimeTypeArrayCtor.prototype);
  _pluginData.set(mimeArr, { length: mimeTypes.length });
  Object.defineProperty(mimeArr, Symbol.iterator, { configurable: true, writable: true, value: function () { return mimeTypes[Symbol.iterator](); } });
  mimeTypes.forEach((m, i) => { mimeArr[i] = m; mimeArr[_pluginData.get(m).type] = m; _pluginData.get(m).enabledPlugin = plugins[0]; });
  return { plugins: plugArr, mimeTypes: mimeArr, ctors: { Plugin: _PluginCtor, PluginArray: _PluginArrayCtor, MimeType: _MimeTypeCtor, MimeTypeArray: _MimeTypeArrayCtor } };
}

const ORIG_FN_TOSTRING = Function.prototype.toString;
let SHARED_TOSTRING = null;

function installSharedToString() {
  if (SHARED_TOSTRING) return SHARED_TOSTRING;
  const holder = {
    toString() {
      const label = NATIVE_FNS.get(this);
      if (label !== undefined) return 'function ' + label + '() { [native code] }';
      return ORIG_FN_TOSTRING.call(this);
    },
  };
  const P = holder.toString;
  NATIVE_FNS.set(P, 'toString');
  try { Object.defineProperty(P, 'length', { value: 0, configurable: true }); } catch (_) {}
  try { Object.defineProperty(P, 'name', { value: 'toString', configurable: true }); } catch (_) {}
  try { Object.defineProperty(Function.prototype, 'toString', { value: P, writable: true, configurable: true }); } catch (_) {}
  SHARED_TOSTRING = P;
  return P;
}
installSharedToString();

export function markNative(fn, name) {
  if (typeof fn !== 'function') return fn;
  NATIVE_FNS.set(fn, name || fn.name || '');
  try { if (Object.prototype.hasOwnProperty.call(fn, 'toString')) delete fn.toString; } catch (_) {}
  return fn;
}

export function setArity(fn, n) {
  if (typeof fn !== 'function') return fn;
  try { Object.defineProperty(fn, 'length', { value: n, writable: false, enumerable: false, configurable: true }); } catch (_) {}
  return fn;
}

let ACTIVE_DOCUMENT = null, ACTIVE_WINDOW = null;
const LISTENERS = new WeakMap();
export function installEvents(obj) {
  if (!obj || LISTENERS.has(obj)) return obj;
  const listeners = Object.create(null);
  try { LISTENERS.set(obj, listeners); } catch (_) { return obj; }
  obj.addEventListener = function (type, fn) {
    if (typeof fn !== 'function') return;
    (listeners[type] || (listeners[type] = [])).push(fn);
  };
  obj.removeEventListener = function (type, fn) {
    const a = listeners[type]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  obj.dispatchEvent = function (ev) { return dispatchOn(obj, ev); };
  return obj;
}
function runListeners(node, ev) {
  const store = node && LISTENERS.get(node); const a = store && store[ev.type];
  if (!a) return;
  ev.currentTarget = node;
  for (const fn of a.slice()) {
    if (ev.__stop) break;
    try { fn.call(node, ev); } catch (_) {}
  }
}
export function dispatchOn(target, ev) {
  if (!ev || typeof ev !== 'object') return true;
  ev.target = ev.target || target;
  ev.srcElement = ev.target;
  ev.stopPropagation = function () {};
  ev.stopImmediatePropagation = function () { ev.__stop = true; };
  ev.preventDefault = function () { ev.defaultPrevented = true; };
  if (ev.defaultPrevented === undefined) ev.defaultPrevented = false;
  runListeners(target, ev);
  ev.__stop = false;
  if (target !== ACTIVE_DOCUMENT && ACTIVE_DOCUMENT) runListeners(ACTIVE_DOCUMENT, ev);
  ev.__stop = false;
  if (target !== ACTIVE_WINDOW && ACTIVE_WINDOW) runListeners(ACTIVE_WINDOW, ev);
  return !ev.defaultPrevented;
}

function nativizeAll(obj, seen) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
  seen = seen || new Set();
  if (seen.has(obj)) return obj;
  seen.add(obj);
  const used = nativizeAll._used || (nativizeAll._used = new WeakMap());
  for (const k of Object.getOwnPropertyNames(obj)) {
    let d;
    try { d = Object.getOwnPropertyDescriptor(obj, k); } catch (_) { continue; }
    if (!d || d.get || d.set || typeof d.value !== 'function') continue;
    let fn = d.value;
    const claimed = used.get(fn);
    const proto = fn.prototype;
    const isCtor = /^[A-Z]/.test(k) || (!!proto && Object.getOwnPropertyNames(proto).filter((x) => x !== 'constructor').length > 0);
    if (claimed !== undefined && claimed !== k && !isCtor) {
      const inner = fn;
      fn = function () { return inner.apply(this, arguments); };
      try { Object.defineProperty(fn, 'length', { value: inner.length, configurable: true }); } catch (_) {}
      if (d.writable !== false && d.configurable !== false) {
        try { Object.defineProperty(obj, k, { value: fn, writable: true, enumerable: d.enumerable, configurable: true }); } catch (_) { fn = inner; }
      } else { fn = inner; }
    }
    if (k !== 'constructor') {
      try { Object.defineProperty(fn, 'name', { value: k, configurable: true }); } catch (_) {}
    }
    used.set(fn, k);
    try { markNative(fn, k); } catch (_) {}
  }
  return obj;
}

function brandObj(o, tag) { try { Object.defineProperty(o, Symbol.toStringTag, { value: tag, configurable: true }); } catch (_) {} return o; }

const ASYNC_LATENCY = {
  aiAvailability: 190,
  battery: 210,
  highEntropy: 225,
  keyboardLayout: 230,
  permissionsQuery: 235,
  storageEstimate: 240,
  gpuAdapter: 15,
  enumerateDevices: 85,
};

function stripNodeFrames(stack) {
  return String(stack || '')
    .split('\n')
    .filter((line) => !isNodeFrameText(line))
    .map((line) => line.replace(/^\s+at /, 'at '))
    .join('\n');
}

function isNodeFrameText(s) {
  return /node:internal|node:vm|node:modules|processTicksAndRejections|process\.processTicks|internal\/process\/task_queues|^file:\/\/|\(file:\/\//.test(String(s || ''));
}

function isNodeCallSite(f) {
  try {
    const n = (typeof f.getFileName === 'function' && f.getFileName()) || '';
    return isNodeFrameText(n) || isNodeFrameText(String(f));
  } catch (_) { return false; }
}

let SCRIPT_HASH = '';
let SCRIPT_HASH_HOOK_LOGGED = false;
export function setVmScriptHash(h) { SCRIPT_HASH = String(h || ''); }

function wrapCallSite(f) {
  const hash = SCRIPT_HASH;
  if (!hash || !f || typeof f.getScriptHash !== 'function') return f;
  try {
    Object.defineProperty(f, 'getScriptHash', {
      configurable: true,
      writable: true,
      value: function getScriptHash() { return hash; },
    });
  } catch (_) {}
  return f;
}

function installFilteredError(sandbox) {
  let NativeError = sandbox && sandbox.Error;
  if (typeof NativeError !== 'function') {
    try { NativeError = vm.runInContext('Error', sandbox); } catch { return; }
  }
  if (typeof NativeError !== 'function') return;
  if (Object.prototype.hasOwnProperty.call(NativeError, '__ddPst')) return;

  try { delete sandbox.__DD_SCRIPT_HASH; } catch (_) {}

  let userPST;
  function formatChrome(err, frames) {
    let s = err && typeof err.toString === 'function' ? err.toString() : String(err);
    for (const f of frames) s += '\nat ' + f;
    return stripNodeFrames(s);
  }
  function wrappedPST(err, frames) {
    if (!SCRIPT_HASH_HOOK_LOGGED) {
      SCRIPT_HASH_HOOK_LOGGED = true;
      if (process.env.DD_VERBOSE === '1') process.stderr.write('  getScriptHash hook len=' + SCRIPT_HASH.length + ' head=' + SCRIPT_HASH.slice(0, 16) + '\n');
    }
    const raw = frames && typeof frames.length === 'number' ? Array.from(frames) : [];
    const list = raw.filter((f) => !isNodeCallSite(f)).map(wrapCallSite);
    let out;
    if (typeof userPST === 'function') {
      try { out = userPST(err, list); } catch (_) { out = formatChrome(err, list); }
    } else {
      out = formatChrome(err, list);
    }
    return typeof out === 'string' ? stripNodeFrames(out) : out;
  }
  const origDP = Object.defineProperty;
  origDP(NativeError, 'prepareStackTrace', {
    configurable: false,
    enumerable: false,
    get() { return wrappedPST; },
    set(v) { userPST = (v === wrappedPST) ? undefined : v; },
  });
  function swallowPst(obj, prop, desc) {
    if (obj !== NativeError || prop !== 'prepareStackTrace') return false;
    const v = desc && Object.prototype.hasOwnProperty.call(desc, 'value')
      ? desc.value
      : (desc && typeof desc.get === 'function' ? desc.get() : undefined);
    userPST = (v === wrappedPST) ? undefined : (typeof v === 'function' ? v : userPST);
    return true;
  }
  let VMObject = sandbox && sandbox.Object;
  if (typeof VMObject !== 'function') {
    try { VMObject = vm.runInContext('Object', sandbox); } catch { VMObject = Object; }
  }
  const hookedDP = function defineProperty(obj, prop, desc) {
    if (swallowPst(obj, prop, desc)) return obj;
    return origDP(obj, prop, desc);
  };
  markNative(hookedDP, 'defineProperty');
  setArity(hookedDP, 3);
  try {
    origDP(VMObject, 'defineProperty', { configurable: true, writable: true, value: hookedDP });
  } catch (_) {}
  if (VMObject !== Object) {
    try { origDP(Object, 'defineProperty', { configurable: true, writable: true, value: hookedDP }); } catch (_) {}
  }
  try {
    const VMReflect = vm.runInContext('Reflect', sandbox);
    const origReflectDP = VMReflect.defineProperty;
    const hookedRDP = function defineProperty(obj, prop, desc) {
      if (swallowPst(obj, prop, desc)) return true;
      return origReflectDP.call(this, obj, prop, desc);
    };
    markNative(hookedRDP, 'defineProperty');
    setArity(hookedRDP, 3);
    VMReflect.defineProperty = hookedRDP;
  } catch (_) {}
  try { origDP(NativeError, '__ddPst', { value: true }); } catch (_) { NativeError.__ddPst = true; }
}

function nativeCtor(name) {
  const f = function () {};
  try { Object.defineProperty(f, 'name', { value: name, configurable: true }); } catch (_) {}
  return markNative(f, name);
}

const CHROME_FULL = '151.0.7922.174';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const CHROME_BRANDS = [
  { brand: 'Not=A?Brand', version: '99' },
  { brand: 'Google Chrome', version: '151' },
  { brand: 'Chromium', version: '151' },
];
const CHROME_FULL_VERSION_LIST = [
  { brand: 'Not=A?Brand', version: '99.0.0.0' },
  { brand: 'Google Chrome', version: CHROME_FULL },
  { brand: 'Chromium', version: CHROME_FULL },
];

const BASE = baseDevice();

export const CHROME151_WIN10 = {
  userAgent: CHROME_UA,
  appVersion: CHROME_UA.slice('Mozilla/'.length),
  platform: 'Win32',
  vendor: 'Google Inc.',
  language: 'en-US',
  languages: ['en-US', 'en'],
  maxTouchPoints: 0,
  onLine: true,
  webdriver: false,
  timezoneOffset: 0,
  hardwareConcurrency: BASE.hardwareConcurrency,
  deviceMemory: BASE.deviceMemory,
  devicePixelRatio: BASE.devicePixelRatio,
  innerWidth: BASE.innerWidth,
  innerHeight: BASE.innerHeight,
  outerWidth: BASE.outerWidth,
  outerHeight: BASE.outerHeight,
  screen: BASE.screen,
  connection: BASE.connection,
  glVendor: BASE.glVendor,
  glRenderer: BASE.glRenderer,
};

const devNull = new Writable({ write(_c, _e, cb) { cb(); } });
const SANDBOX_CONSOLE = process.env.DD_VERBOSE
  ? console
  : new console.Console({ stdout: devNull, stderr: devNull });

function deriveTextHash(prof) {
  const measured = gpuWorkerTextHash();
  if (measured) return measured;
  const p = prof || {};
  const s = prof && prof.screen ? prof.screen : {};

  const identity = [
    p.glVendor, p.glRenderer, p.platform, p.userAgent,
    p.hardwareConcurrency, p.deviceMemory, p.devicePixelRatio,
    s.width, s.height, s.colorDepth,
    Array.isArray(p.languages) ? p.languages.join(',') : p.languages,
  ].join('|');

  let mixed = 0;
  for (let i = 0; i < identity.length; i++) mixed = (Math.imul(mixed, 31) + identity.charCodeAt(i)) | 0;
  return hex32FromSeed('text:' + identity.length + ':' + mixed);
}

function defaultFpResults(prof, seed) {
  const r = charSum(String(seed)) % 10 || 10;
  return {
    nav: { ua: prof.userAgent, hc: prof.hardwareConcurrency, pf: prof.platform,
           mob: false, lgs: JSON.stringify(prof.languages), onL: prof.onLine,
           glvd: prof.glVendor, glrd: prof.glRenderer },
    textHash: deriveTextHash(prof),
    procHash: hex32FromSeed('proc:' + seed + ':' + r),
    procR: r,
    timing: 3.14,
  };
}
function charSum(s) { let n = 0; for (let i = 0; i < s.length; i++) n += s.charCodeAt(i); return n; }
function hex32FromSeed(s) {
  let x = 0x9e3779b1 ^ charSum(s);
  let out = '';
  for (let i = 0; i < 32; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out += ((x >>> 0) & 255).toString(16).padStart(2, '0'); }
  return out;
}

function makeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c) => (set.has(c) ? (set.delete(c), false) : (set.add(c), true)) };
}
function matchMediaFor(qs, prof) {
  const q = String(qs || '').trim();
  const dpr = Number(prof && prof.devicePixelRatio) || 1;
  const innerW = Number(prof && prof.innerWidth) || 1773;
  const innerH = Number(prof && prof.innerHeight) || 829;
  const evalClause = (raw) => {
    let s = String(raw || '').trim();
    while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
    if (!s) return true;
    if (/^(only\s+)?(all|screen)$/i.test(s)) return true;
    if (/^(only\s+)?(print|speech)$/i.test(s)) return false;
    if (/^not\s+(all|screen|print|speech)$/i.test(s)) return false;
    if (/any-pointer:\s*fine|pointer:\s*fine/.test(s)) return true;
    if (/any-pointer:\s*coarse|pointer:\s*coarse/.test(s)) return false;
    if (/any-hover:\s*hover|hover:\s*hover/.test(s)) return true;
    if (/any-hover:\s*none|hover:\s*none/.test(s)) return false;
    if (/color-gamut:\s*srgb/.test(s)) return true;
    if (/color-gamut:\s*(p3|rec2020)/.test(s)) return false;
    if (/dynamic-range:\s*standard/.test(s)) return true;
    if (/dynamic-range:\s*high/.test(s)) return false;
    if (/display-mode:\s*browser/.test(s)) return true;
    if (/prefers-color-scheme:\s*light/.test(s)) return true;
    if (/prefers-color-scheme:\s*dark/.test(s)) return false;
    if (/prefers-reduced-motion:\s*reduce/.test(s)) return false;
    if (/prefers-reduced-motion:\s*no-preference/.test(s)) return true;
    let m;
    if ((m = s.match(/-webkit-min-device-pixel-ratio:\s*([\d.]+)/))) return dpr + 1e-6 >= Number(m[1]);
    if ((m = s.match(/min-device-pixel-ratio:\s*([\d.]+)/))) return dpr + 1e-6 >= Number(m[1]);
    if ((m = s.match(/-webkit-max-device-pixel-ratio:\s*([\d.]+)/))) return dpr - 1e-6 <= Number(m[1]);
    if ((m = s.match(/max-device-pixel-ratio:\s*([\d.]+)/))) return dpr - 1e-6 <= Number(m[1]);
    if ((m = s.match(/-webkit-device-pixel-ratio:\s*([\d.]+)/))) return Math.abs(dpr - Number(m[1])) < 0.05;
    if ((m = s.match(/(?:^|\s)device-pixel-ratio:\s*([\d.]+)/))) return Math.abs(dpr - Number(m[1])) < 0.05;
    if ((m = s.match(/min-resolution:\s*([\d.]+)\s*dppx/))) return dpr + 1e-6 >= Number(m[1]);
    if ((m = s.match(/max-resolution:\s*([\d.]+)\s*dppx/))) return dpr - 1e-6 <= Number(m[1]);
    if ((m = s.match(/min-resolution:\s*([\d.]+)\s*dpi/))) return dpr * 96 + 1e-6 >= Number(m[1]);
    if ((m = s.match(/max-resolution:\s*([\d.]+)\s*dpi/))) return dpr * 96 - 1e-6 <= Number(m[1]);
    if ((m = s.match(/(?:^|\s)resolution:\s*([\d.]+)\s*dppx/))) return Math.abs(dpr - Number(m[1])) < 0.05;
    if ((m = s.match(/min-width:\s*([\d.]+)px/))) return innerW + 1e-6 >= Number(m[1]);
    if ((m = s.match(/max-width:\s*([\d.]+)px/))) return innerW - 1e-6 <= Number(m[1]);
    if ((m = s.match(/min-height:\s*([\d.]+)px/))) return innerH + 1e-6 >= Number(m[1]);
    if ((m = s.match(/max-height:\s*([\d.]+)px/))) return innerH - 1e-6 <= Number(m[1]);
    if (/orientation:\s*landscape/.test(s)) return innerW >= innerH;
    if (/orientation:\s*portrait/.test(s)) return innerH > innerW;
    return false;
  };
  const clauses = q ? q.split(/\s+and\s+/i) : [];
  const matches = clauses.length ? clauses.every(evalClause) : false;
  if (process.env.DD_DUMP_T && q) {
    try {
      const g = globalThis.__DD_MM || (globalThis.__DD_MM = []);
      if (g.length < 220) g.push(q + '=>' + matches);
    } catch (_) {}
  }
  return {
    matches, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
  };
}

function VisualViewportCtor() {}
markNative(VisualViewportCtor, 'VisualViewport');
Object.defineProperty(VisualViewportCtor.prototype, Symbol.toStringTag, { value: 'VisualViewport', configurable: true });
for (const [prop, fallback] of [['width', 0], ['height', 0], ['offsetLeft', 0], ['offsetTop', 0], ['pageLeft', 0], ['pageTop', 0]]) {
  Object.defineProperty(VisualViewportCtor.prototype, prop, {
    configurable: true, enumerable: true,
    get: markNative(function () { return this['_' + prop] != null ? this['_' + prop] : fallback; }, 'get ' + prop),
  });
}
Object.defineProperty(VisualViewportCtor.prototype, 'scale', {
  configurable: true, enumerable: true,
  get: markNative(function scale() {
    if (process.env.DD_DUMP_T) {
      try { globalThis.__DD_VV = (globalThis.__DD_VV || 0) + 1; } catch (_) {}
    }
    return 1;
  }, 'get scale'),
});
VisualViewportCtor.prototype.addEventListener = markNative(function addEventListener() {}, 'addEventListener');
VisualViewportCtor.prototype.removeEventListener = markNative(function removeEventListener() {}, 'removeEventListener');
VisualViewportCtor.prototype.dispatchEvent = markNative(function dispatchEvent() { return true; }, 'dispatchEvent');

function makeVisualViewport(prof) {
  const w = Number(prof && prof.innerWidth) || 958;
  const h = Number(prof && prof.innerHeight) || 937;
  const vv = Object.create(VisualViewportCtor.prototype);
  vv._width = w;
  vv._height = h;
  vv._offsetLeft = 0;
  vv._offsetTop = 0;
  vv._pageLeft = 0;
  vv._pageTop = 0;
  try { Object.defineProperty(vv, 'constructor', { value: VisualViewportCtor, writable: true, configurable: true }); } catch (_) {}
  return vv;
}
function makeWebGLContext(prof, attrs, canvas) {
  const glState = { program: null, uniforms: Object.create(null), compiled: new Map() };
  const P = {
    0x1F00: 'WebKit',
    0x1F01: 'WebKit WebGL',
    0x1F02: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    0x8B8C: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    0x9245: prof.glVendor,
    0x9246: prof.glRenderer,
    0x0D33: 16384, 0x851C: 16384, 0x84E8: 16384, 0x8869: 16, 0x8DFB: 4095, 0x8DFC: 30,
    0x8B4C: 16, 0x8B4D: 32, 0x8872: 16, 0x8B49: 1024, 0x8B4A: 1024, 0x8DFD: 1024,
    0x0D3A: [32767, 32767], 0x846D: [1, 1], 0x846E: [1, 1024],
    0x0D52: 8, 0x0D53: 8, 0x0D54: 8, 0x0D55: 8, 0x0D56: 24, 0x0D57: 0,
    0x80A8: 1, 0x80A9: 4, 0x0D50: 4,
  };
  const noop = () => {};
  const GL_CONST = {
    DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, COLOR_BUFFER_BIT: 0x4000,
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    ZERO: 0, ONE: 1, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305, DST_COLOR: 0x0306,
    FUNC_ADD: 0x8006, BLEND_EQUATION: 0x8009, FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4,
    DYNAMIC_DRAW: 0x88E8, BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
    FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408, CULL_FACE: 0x0B44, BLEND: 0x0BE2,
    DITHER: 0x0BD0, STENCIL_TEST: 0x0B90, DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11,
    POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502, OUT_OF_MEMORY: 0x0505,
    CW: 0x0900, CCW: 0x0901, LINE_WIDTH: 0x0B21, ALIASED_POINT_SIZE_RANGE: 0x846D,
    ALIASED_LINE_WIDTH_RANGE: 0x846E, CULL_FACE_MODE: 0x0B45, FRONT_FACE: 0x0B46,
    DEPTH_RANGE: 0x0B70, DEPTH_WRITEMASK: 0x0B72, DEPTH_CLEAR_VALUE: 0x0B73, DEPTH_FUNC: 0x0B74,
    STENCIL_CLEAR_VALUE: 0x0B91, STENCIL_FUNC: 0x0B92, VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10,
    COLOR_CLEAR_VALUE: 0x0C22, COLOR_WRITEMASK: 0x0C23, MAX_TEXTURE_SIZE: 0x0D33,
    MAX_VIEWPORT_DIMS: 0x0D3A, SUBPIXEL_BITS: 0x0D50, RED_BITS: 0x0D52, GREEN_BITS: 0x0D53,
    BLUE_BITS: 0x0D54, ALPHA_BITS: 0x0D55, DEPTH_BITS: 0x0D56, STENCIL_BITS: 0x0D57,
    TEXTURE_2D: 0x0DE1, UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, RGB: 0x1907, RGBA: 0x1908,
    FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31, MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_VARYING_VECTORS: 0x8DFC,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    SHADING_LANGUAGE_VERSION: 0x8B8C, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
    MAX_RENDERBUFFER_SIZE: 0x84E8, TEXTURE_CUBE_MAP: 0x8513, TEXTURE0: 0x84C0,
    ACTIVE_TEXTURE: 0x84E0, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    NEAREST: 0x2600, LINEAR: 0x2601, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
    FRAMEBUFFER_COMPLETE: 0x8CD5, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    CONTEXT_LOST_WEBGL: 0x9242, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
    VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02,
  };
  return nativizeAll({
    ...GL_CONST,
    getParameter: (p) => {
      if (process.env.DD_DUMP_T) {
        try {
          const g = globalThis.__DD_GP || (globalThis.__DD_GP = []);
          if (g.length < 120) g.push(p);
        } catch (_) {}
      }
      if (p === 0x84FF) return 16;
      if (p === 0x8824) return 8;
      if (p === 0x8CDF) return 8;
      if (p === 0x86A3) return new Uint32Array([
        0x83F0, 0x83F1, 0x83F2, 0x83F3, 0x8C4C, 0x8C4D, 0x8C4E, 0x8C4F,
        0x8DBB, 0x8DBC, 0x8DBD, 0x8DBE, 0x8E8C, 0x8E8D, 0x8E8E, 0x8E8F,
      ]);
      return p in P ? P[p] : 0;
    },
    getExtension: (name) => {
      const n = String(name || '');
      if (process.env.DD_DUMP_T) {
        try {
          const g = globalThis.__DD_GE || (globalThis.__DD_GE = []);
          if (g.length < 80) g.push(n);
        } catch (_) {}
      }
      const EXT = {
        WEBGL_debug_renderer_info: { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 },
        EXT_texture_filter_anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF },
        WEBKIT_EXT_texture_filter_anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF },
        WEBGL_draw_buffers: {
          COLOR_ATTACHMENT0_WEBGL: 0x8CE0, DRAW_BUFFER0_WEBGL: 0x8825,
          MAX_DRAW_BUFFERS_WEBGL: 0x8824, MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF,
        },
        OES_vertex_array_object: { VERTEX_ARRAY_BINDING_OES: 0x85B5, createVertexArrayOES: noop, bindVertexArrayOES: noop, deleteVertexArrayOES: noop, isVertexArrayOES: () => false },
        WEBGL_lose_context: { loseContext: noop, restoreContext: noop },
        WEBGL_debug_shaders: { getTranslatedShaderSource: () => '' },
        EXT_disjoint_timer_query: { QUERY_COUNTER_BITS_EXT: 0x8864, TIME_ELAPSED_EXT: 0x88BF, TIMESTAMP_EXT: 0x8E28, GPU_DISJOINT_EXT: 0x8FBB, createQueryEXT: () => ({}), deleteQueryEXT: noop, beginQueryEXT: noop, endQueryEXT: noop, getQueryEXT: () => 0, getQueryObjectEXT: () => 0 },
        WEBGL_compressed_texture_s3tc: { COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83F0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83F1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83F2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83F3 },
        WEBGL_compressed_texture_s3tc_srgb: { COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8C4C, COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8C4D, COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8C4E, COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8C4F },
        WEBGL_depth_texture: { UNSIGNED_INT_24_8_WEBGL: 0x84FA },
        WEBGL_color_buffer_float: { RGBA32F_EXT: 0x8814, RGB32F_EXT: 0x8815, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 },
        EXT_color_buffer_half_float: { RGBA16F_EXT: 0x881A, RGB16F_EXT: 0x881B, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 },
        EXT_sRGB: { SRGB_EXT: 0x8C40, SRGB_ALPHA_EXT: 0x8C42, SRGB8_ALPHA8_EXT: 0x8C43, FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING_EXT: 0x8210 },
        OES_texture_half_float: { HALF_FLOAT_OES: 0x8D61 },
        OES_standard_derivatives: { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8B8B },
        EXT_blend_minmax: { MIN_EXT: 0x8007, MAX_EXT: 0x8008 },
        ANGLE_instanced_arrays: { VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE, drawArraysInstancedANGLE: noop, drawElementsInstancedANGLE: noop, vertexAttribDivisorANGLE: noop },
        OES_element_index_uint: {},
        OES_texture_float: {},
        OES_texture_float_linear: {},
        OES_texture_half_float_linear: {},
        OES_fbo_render_mipmap: {},
        EXT_float_blend: {},
        EXT_frag_depth: {},
        EXT_shader_texture_lod: {},
        EXT_clip_control: {},
        EXT_depth_clamp: {},
        EXT_polygon_offset_clamp: {},
        EXT_texture_compression_bptc: { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8E8C, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8E8D, COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8E8E, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8E8F },
        EXT_texture_compression_rgtc: { COMPRESSED_RED_RGTC1_EXT: 0x8DBB, COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8DBC, COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8DBD, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8DBE },
        EXT_texture_mirror_clamp_to_edge: { MIRROR_CLAMP_TO_EDGE_EXT: 0x8743 },
        KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91B1 },
        WEBGL_blend_func_extended: { SRC1_COLOR_WEBGL: 0x88F9, SRC1_ALPHA_WEBGL: 0x8589, MAX_DUAL_SOURCE_DRAW_BUFFERS_WEBGL: 0x88FC },
        WEBGL_multi_draw: { multiDrawArraysWEBGL: noop, multiDrawElementsWEBGL: noop },
        WEBGL_polygon_mode: { POLYGON_MODE_WEBGL: 0x0B40, POLYGON_OFFSET_LINE_WEBGL: 0x2A02 },
      };
      if (Object.prototype.hasOwnProperty.call(EXT, n)) return EXT[n];
      return null;
    },
    getSupportedExtensions: () => {
      const list = ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control',
      'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_disjoint_timer_query', 'EXT_float_blend',
      'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_shader_texture_lod', 'EXT_texture_compression_bptc',
      'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge',
      'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap',
      'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear',
      'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object',
      'WEBGL_blend_func_extended', 'WEBGL_color_buffer_float',
      'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info',
      'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context',
      'WEBGL_multi_draw', 'WEBGL_polygon_mode'];
      if (process.env.DD_DUMP_T) {
        try { globalThis.__DD_GSE = (globalThis.__DD_GSE || 0) + 1; } catch (_) {}
      }
      return list;
    },
    getContextAttributes: () => ({
      alpha: true, antialias: true, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false,
      powerPreference: (attrs && attrs.powerPreference) || 'default',
      premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, xrCompatible: false,
    }),
    createShader: () => ({}),
    shaderSource: (sh, src) => { try { if (sh) sh.__src = String(src); } catch (_) {} },
    compileShader: noop, createProgram: () => ({}),
    attachShader: (prog, sh) => { try { if (prog && sh && sh.__src && sh.__src.indexOf('gl_FragColor') >= 0) prog.__frag = sh.__src; } catch (_) {} },
    linkProgram: noop,
    useProgram: (prog) => { glState.program = prog || null; },
    createBuffer: () => ({}), bindBuffer: noop,
    bufferData: noop, getAttribLocation: () => 0, enableVertexAttribArray: noop,
    vertexAttribPointer: noop, drawArrays: noop, viewport: noop, clearColor: noop, clear: noop,
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    readPixels: (x, y, w, h, fmt, type, dst) => {
      if (!dst || typeof dst.length !== 'number') return;
      try {
        const src = glState.program && glState.program.__frag;
        if (src) {
          const fn = glState.compiled.get(src) || (glState.compiled.set(src, compileFragmentShader(src)), glState.compiled.get(src));
          if (fn) {
            const px = toBytes(fn(glState.uniforms));
            for (let i = 0; i < dst.length; i++) dst[i] = px[i % 4];
            return;
          }
        }
      } catch (_) {}
      let s = 0x9e3779b9;
      for (const ch of String(ACTIVE_PROF && ACTIVE_PROF.glRenderer || 'gpu')) s = (Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0);
      for (let i = 0; i < dst.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; dst[i] = (s >>> 24) & 0xFF; }
    },
    createTexture: () => ({}), bindTexture: noop, texParameteri: noop, texImage2D: noop,
    uniform1f: (loc, v) => { try { if (loc && loc.__name) glState.uniforms[loc.__name] = Number(v); } catch (_) {} },
    uniform2f: noop, uniform3f: noop, uniform4f: noop, uniform1i: noop, uniform2i: noop,
    uniform1fv: noop, uniform2fv: noop, uniform3fv: noop, uniform4fv: noop, uniformMatrix4fv: noop,
    getUniformLocation: (prog, name) => ({ __name: String(name) }),
    vertexAttrib1f: noop, disableVertexAttribArray: noop,
    getShaderParameter: () => true, getProgramParameter: () => true, getShaderInfoLog: () => '',
    getProgramInfoLog: () => '', getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    viewport: noop, clearColor: noop, clear: noop, enable: noop, disable: noop, depthFunc: noop,
    blendFunc: noop, activeTexture: noop, generateMipmap: noop, pixelStorei: noop, deleteShader: noop,
    deleteProgram: noop, deleteBuffer: noop, deleteTexture: noop, finish: noop, flush: noop,
    isContextLost: () => false, getError: () => 0,
    canvas: canvas || null,
    get drawingBufferWidth() {
      const w = Number(canvas && canvas.width);
      return Math.max(1, Math.floor(Number.isFinite(w) && w > 0 ? w : 300));
    },
    get drawingBufferHeight() {
      const h = Number(canvas && canvas.height);
      return Math.max(1, Math.floor(Number.isFinite(h) && h > 0 ? h : 150));
    },
  });
}
function makeCanvasContext2D() {
  let cksum = 2166136261 >>> 0;
  let lastFill = "";
  let painted = false;
  const oplog = [];
  const mix = (...args) => {
    const s = args.join(',');
    if (globalThis.__DU_TRACE) oplog.push(s);
    for (let i = 0; i < s.length; i++) { cksum ^= s.charCodeAt(i); cksum = Math.imul(cksum, 16777619) >>> 0; }
  };
  const draw = (name) => (...a) => { mix(name, ...a); painted = true; };
  const ctx = {
    fillRect: draw('fillRect'), fillText: draw('fillText'), beginPath: draw('beginPath'),
    arc: draw('arc'), moveTo: draw('moveTo'), lineTo: draw('lineTo'),
    bezierCurveTo: draw('bezierCurveTo'), quadraticCurveTo: draw('quadraticCurveTo'),
    closePath: draw('closePath'), stroke: draw('stroke'), fill: draw('fill'),
    rect: draw('rect'), roundRect: draw('roundRect'), ellipse: draw('ellipse'), arcTo: draw('arcTo'),
    strokeRect: draw('strokeRect'), clearRect: draw('clearRect'), strokeText: draw('strokeText'),
    save: draw('save'), restore: draw('restore'), translate: draw('translate'), rotate: draw('rotate'),
    scale: draw('scale'), transform: draw('transform'), setTransform: draw('setTransform'),
    resetTransform: draw('resetTransform'), clip: draw('clip'), drawImage: draw('drawImage'),
    createLinearGradient: (...a) => { mix('linearGradient', ...a); return { addColorStop: (o, c) => mix('stop', o, c) }; },
    createPattern: () => null, createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, (w|0) * (h|0) * 4)) }),
    putImageData: draw('putImageData'), isPointInPath: () => false, isPointInStroke: () => false,
    setLineDash: draw('setLineDash'), getLineDash: () => [], measureTextWidth: undefined,
    createRadialGradient: (...a) => { mix('radialGradient', ...a); return { addColorStop: (o, c) => mix('stop', o, c) }; },
    measureText: () => ({ width: 0 }),
    getImageData: (x, y, w, h) => {
      const n = Math.max(0, (w | 0) * (h | 0) * 4);
      const data = new Uint8ClampedArray(n);
      const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(lastFill || '');
      let r = 0, g = 0, b = 0;
      if (m) { r = Math.round(+m[1]) & 255; g = Math.round(+m[2]) & 255; b = Math.round(+m[3]) & 255; } else {
        const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((lastFill || '').trim());
        if (hx) {
          const s = hx[1].length === 3 ? hx[1].replace(/./g, (c) => c + c) : hx[1];
          r = parseInt(s.slice(0, 2), 16); g = parseInt(s.slice(2, 4), 16); b = parseInt(s.slice(4, 6), 16);
        }
      }
      const a = painted ? 255 : 0;
      for (let i = 0; i < n; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
      return { data, width: w | 0, height: h | 0, colorSpace: 'srgb' };
    },
    set fillStyle(v) { mix('fillStyle', v); lastFill = String(v); },
    get fillStyle() { return lastFill || '#000'; },
    set font(v) { mix('font', v); }, get font() { return '10px sans-serif'; },
    set textBaseline(v) { mix('textBaseline', v); }, set shadowBlur(v) { mix('shadowBlur', v); },
    set shadowColor(v) { mix('shadowColor', v); }, set globalCompositeOperation(v) { mix('gco', v); },
    _checksum() { return cksum >>> 0; },
    _oplog() { return oplog; },
  };
  nativizeAll(ctx);
  return ctx;
}
export const DOM_CTORS = (() => {
  const mk = (name, parent) => {
    const f = function () {};
    try { Object.defineProperty(f, 'name', { value: name, configurable: true }); } catch (_) {}
    markNative(f, name);
    if (parent) f.prototype = Object.create(parent.prototype);
    Object.defineProperty(f.prototype, 'constructor', { value: f, writable: true, configurable: true });
    return f;
  };
  const EventTarget = mk('EventTarget', null);
  const Node = mk('Node', EventTarget);
  const Element = mk('Element', Node);
  const HTMLElement = mk('HTMLElement', Element);
  const byTag = {};
  const TAGMAP = { div: 'HTMLDivElement', span: 'HTMLSpanElement', p: 'HTMLParagraphElement',
    a: 'HTMLAnchorElement', img: 'HTMLImageElement', input: 'HTMLInputElement', button: 'HTMLButtonElement',
    canvas: 'HTMLCanvasElement', form: 'HTMLFormElement', body: 'HTMLBodyElement', head: 'HTMLHeadElement',
    html: 'HTMLHtmlElement', script: 'HTMLScriptElement', style: 'HTMLStyleElement', link: 'HTMLLinkElement',
    meta: 'HTMLMetaElement', iframe: 'HTMLIFrameElement', label: 'HTMLLabelElement', audio: 'HTMLAudioElement',
    video: 'HTMLVideoElement', title: 'HTMLTitleElement', i: 'HTMLElement', table: 'HTMLTableElement' };
  const HTMLMediaElement = mk('HTMLMediaElement', HTMLElement);
  for (const [tag, iface] of Object.entries(TAGMAP)) {
    if (iface === 'HTMLElement') { byTag[tag] = HTMLElement; continue; }
    byTag[tag] = mk(iface, iface === 'HTMLVideoElement' || iface === 'HTMLAudioElement' ? HTMLMediaElement : HTMLElement);
  }
  const def = (proto, name, fn, len) => {
    markNative(fn, name);
    if (len !== undefined) { try { Object.defineProperty(fn, 'length', { value: len, configurable: true }); } catch (_) {} }
    Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: false, configurable: true });
  };
  const MP = HTMLMediaElement.prototype;
  def(MP, 'play', function play() { return Promise.resolve(); }, 0);
  def(MP, 'pause', function pause() {}, 0);
  def(MP, 'load', function load() {}, 0);
  def(MP, 'canPlayType', function canPlayType(t) { return globalThis.__dd_cpt ? globalThis.__dd_cpt(t) : ''; }, 1);
  def(MP, 'addTextTrack', function addTextTrack() { return { cues: null, activeCues: null, mode: 'hidden' }; }, 1);
  def(MP, 'captureStream', function captureStream() { return { active: true, id: '', getTracks: () => [] }; }, 0);
  def(MP, 'setSinkId', function setSinkId() { return Promise.resolve(); }, 1);
  for (const [k, v] of Object.entries({ HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4, NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3 })) {
    Object.defineProperty(MP, k, { value: v, writable: false, enumerable: true, configurable: false });
  }
  const VP = byTag.video.prototype;
  def(VP, 'getVideoPlaybackQuality', function getVideoPlaybackQuality() {
    return { creationTime: 0, totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0 };
  }, 0);
  def(VP, 'requestVideoFrameCallback', function requestVideoFrameCallback() { return 1; }, 1);
  def(VP, 'cancelVideoFrameCallback', function cancelVideoFrameCallback() {}, 1);
  def(VP, 'requestPictureInPicture', function requestPictureInPicture() { return Promise.resolve({}); }, 0);
  return { EventTarget, Node, Element, HTMLElement, HTMLMediaElement, byTag, TAGMAP, HTMLUnknownElement: mk('HTMLUnknownElement', HTMLElement) };
})();
function htmlIfaceName(tagName) {
  const t = String(tagName || 'div').toLowerCase();
  return DOM_CTORS.TAGMAP[t] || 'HTMLUnknownElement';
}
function htmlProtoFor(tagName) {
  const t = String(tagName || 'div').toLowerCase();
  const C = DOM_CTORS.byTag[t] || DOM_CTORS.HTMLUnknownElement;
  return C.prototype;
}

export const EVENT_CTORS = (() => {
  function Event(type, init) { initEvent(this, type, init); }
  Object.assign(Event.prototype, {
    composedPath: markNative(function composedPath() { return this.__path || []; }, 'composedPath'),
    stopPropagation: markNative(function stopPropagation() { this.__stopProp = true; }, 'stopPropagation'),
    stopImmediatePropagation: markNative(function stopImmediatePropagation() { this.__stop = true; this.__stopProp = true; }, 'stopImmediatePropagation'),
    preventDefault: markNative(function preventDefault() { if (this.cancelable) { this.defaultPrevented = true; this.returnValue = false; } }, 'preventDefault'),
    initEvent: markNative(function initEvent2() {}, 'initEvent'),
    NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3,
  });
  Object.defineProperty(Event.prototype, Symbol.toStringTag, { value: 'Event', configurable: true });

  function UIEvent(type, init) { Event.call(this, type, init); const i = init || {}; this.view = i.view || null; this.detail = i.detail || 0; this.which = i.which != null ? i.which : 0; this.sourceCapabilities = null; }
  UIEvent.prototype = Object.create(Event.prototype);
  Object.defineProperty(UIEvent.prototype, 'constructor', { value: UIEvent, writable: true, configurable: true });
  Object.defineProperty(UIEvent.prototype, Symbol.toStringTag, { value: 'UIEvent', configurable: true });

  function MouseEvent(type, init) {
    UIEvent.call(this, type, init);
    const i = init || {};
    const cx = i.clientX || 0, cy = i.clientY || 0;
    this.clientX = cx; this.clientY = cy;
    this.x = cx; this.y = cy;
    this.screenX = i.screenX != null ? i.screenX : cx;
    this.screenY = i.screenY != null ? i.screenY : cy;
    this.pageX = i.pageX != null ? i.pageX : cx;
    this.pageY = i.pageY != null ? i.pageY : cy;
    this.offsetX = i.offsetX != null ? i.offsetX : cx;
    this.offsetY = i.offsetY != null ? i.offsetY : cy;
    this.layerX = i.layerX != null ? i.layerX : cx;
    this.layerY = i.layerY != null ? i.layerY : cy;
    this.movementX = i.movementX || 0; this.movementY = i.movementY || 0;
    this.button = i.button || 0; this.buttons = i.buttons || 0;
    this.ctrlKey = !!i.ctrlKey; this.shiftKey = !!i.shiftKey; this.altKey = !!i.altKey; this.metaKey = !!i.metaKey;
    this.relatedTarget = i.relatedTarget || null; this.fromElement = null; this.toElement = null;
    if (this.which === 0) this.which = 1;
  }
  MouseEvent.prototype = Object.create(UIEvent.prototype);
  Object.defineProperty(MouseEvent.prototype, 'constructor', { value: MouseEvent, writable: true, configurable: true });
  MouseEvent.prototype.getModifierState = markNative(function getModifierState(k) {
    return k === 'Control' ? this.ctrlKey : k === 'Shift' ? this.shiftKey : k === 'Alt' ? this.altKey : k === 'Meta' ? this.metaKey : false;
  }, 'getModifierState');
  Object.defineProperty(MouseEvent.prototype, Symbol.toStringTag, { value: 'MouseEvent', configurable: true });

  function PointerEvent(type, init) {
    MouseEvent.call(this, type, init);
    const i = init || {};
    this.pointerId = i.pointerId != null ? i.pointerId : 1;
    this.width = i.width != null ? i.width : 1; this.height = i.height != null ? i.height : 1;
    this.pressure = i.pressure != null ? i.pressure : 0;
    this.tangentialPressure = 0; this.tiltX = 0; this.tiltY = 0; this.twist = 0;
    this.altitudeAngle = 1.5707963267948966; this.azimuthAngle = 0;
    this.pointerType = i.pointerType || 'mouse';
    this.isPrimary = i.isPrimary !== undefined ? i.isPrimary : true;
    this.__coalesced = i.__coalesced || [];
  }
  PointerEvent.prototype = Object.create(MouseEvent.prototype);
  Object.defineProperty(PointerEvent.prototype, 'constructor', { value: PointerEvent, writable: true, configurable: true });
  PointerEvent.prototype.getCoalescedEvents = markNative(function getCoalescedEvents() {
    return this.__coalesced && this.__coalesced.length ? this.__coalesced : [this];
  }, 'getCoalescedEvents');
  PointerEvent.prototype.getPredictedEvents = markNative(function getPredictedEvents() { return []; }, 'getPredictedEvents');
  Object.defineProperty(PointerEvent.prototype, Symbol.toStringTag, { value: 'PointerEvent', configurable: true });

  function initEvent(ev, type, init) {
    const i = init || {};
    ev.type = String(type);
    ev.target = i.target || null; ev.currentTarget = null; ev.srcElement = i.target || null;
    ev.eventPhase = 0;
    ev.bubbles = i.bubbles !== undefined ? !!i.bubbles : true;
    ev.cancelable = i.cancelable !== undefined ? !!i.cancelable : true;
    ev.composed = !!i.composed;
    ev.defaultPrevented = false; ev.returnValue = true; ev.cancelBubble = false;
    ev.timeStamp = i.timeStamp != null ? i.timeStamp : 0;
    Object.defineProperty(ev, 'isTrusted', { value: i.isTrusted !== undefined ? !!i.isTrusted : false, enumerable: true, configurable: false, writable: false });
  }
  for (const [C, n] of [[Event, 'Event'], [UIEvent, 'UIEvent'], [MouseEvent, 'MouseEvent'], [PointerEvent, 'PointerEvent']]) markNative(C, n);
  return { Event, UIEvent, MouseEvent, PointerEvent };
})();

const DOM_TAGS = { div: 431, span: 214, p: 15, input: 14, button: 7, i: 6, canvas: 2, meta: 4, link: 3,
  style: 2, script: 3, label: 2, form: 1, a: 1, img: 1, body: 1, head: 1, html: 1, title: 1, iframe: 1 };
const DOM_TOTAL = Object.values(DOM_TAGS).reduce((a, b) => a + b, 0);
const _domCache = new Map();
function domPool(tag) {
  const t = String(tag || '*').toLowerCase();
  if (_domCache.has(t)) return _domCache.get(t);
  let list;
  if (t === '*') {
    list = [];
    for (const [name, n] of Object.entries(DOM_TAGS)) for (let i = 0; i < n; i++) list.push(makeElement(name));
  } else {
    const n = DOM_TAGS[t] != null ? DOM_TAGS[t] : 1;
    list = []; for (let i = 0; i < n; i++) list.push(makeElement(t));
  }
  _domCache.set(t, list);
  return list;
}

let SHARED_OFFSET_PARENT = null;
let SHARED_ANIMATED_EL = null;
let ACTIVE_PROF = CHROME151_WIN10;

function makeChildWindow() {
  const childMath = Object.create(Math);
  const p = ACTIVE_PROF;
  const win = {
    Math: childMath,
    decodeURI: (s) => decodeURIComponent(s),
    encodeURI: (s) => encodeURI(s),
    decodeURIComponent: (s) => decodeURIComponent(s),
    parseInt: (s, r) => parseInt(s, r), parseFloat: (s) => parseFloat(s),
    navigator: {
      userAgent: p.userAgent, platform: p.platform, language: p.language, languages: p.languages,
      hardwareConcurrency: p.hardwareConcurrency, vendor: p.vendor, webdriver: false,
      deviceMemory: p.deviceMemory, maxTouchPoints: p.maxTouchPoints, onLine: p.onLine,
      userAgentData: { mobile: false, platform: 'Windows', brands: CHROME_BRANDS },
      ...makePluginsAndMimeTypes(),
    },
    outerHeight: p.outerHeight ?? 1032, outerWidth: p.outerWidth ?? 974,
    innerHeight: p.innerHeight ?? 937, innerWidth: p.innerWidth ?? 958,
    visualViewport: makeVisualViewport(p),
    matchMedia: (qs) => matchMediaFor(qs, p),
    screen: { ...p.screen },
    document: { createElement: (t) => makeElement(t), documentElement: makeElement('html'), body: makeElement('body') },
    location: { href: 'about:blank' },
    eval: (s) => undefined,
    postMessage(msg) {
      if (msg && typeof msg === 'object') {
        const iface = msg[Symbol.toStringTag] || (msg.constructor && msg.constructor.name);
        if (iface && iface !== 'Object' && iface !== 'Array') {
          const e = new Error("Failed to execute 'postMessage' on 'Window': " + iface + ' object could not be cloned.');
          e.name = 'DataCloneError';
          throw e;
        }
      }
    },
  };
  {
    const dprVal = Number(p.devicePixelRatio) || 1;
    Object.defineProperty(win, 'devicePixelRatio', {
      configurable: true, enumerable: true,
      get() {
        if (process.env.DD_DUMP_T) {
          try {
            const g = globalThis.__DD_DPR || (globalThis.__DD_DPR = []);
            if (g.length < 80) g.push('iframe');
          } catch (_) {}
        }
        return dprVal;
      },
    });
  }
  const proxied = withEnumeratedGlobals(win, loadWindowGlobals());
  win.self = proxied; win.window = proxied; win.top = proxied; win.parent = proxied; win.globalThis = proxied;
  return proxied;
}

function cssValue(prop) {
  const p = String(prop);
  if (p.startsWith('--')) return '';
  switch (p) {
    case 'color': case 'backgroundColor': case 'borderColor': case 'outlineColor': return 'rgb(0, 255, 36)';
    case 'transform': return 'none';
    case 'height': case 'blockSize': return '0px';
    case 'width': case 'inlineSize': return '150px';
    case 'fontFamily': return 'Arial';
    case 'font': return '16px Arial';
    case 'fontSize': return '16px';
    case 'letterSpacing': case 'wordSpacing': return 'normal';
    case 'opacity': return '1';
    case 'filter': case 'backdropFilter': return 'none';
    case 'zoom': return '1';
    default: return '0px';
  }
}
const SYSTEM_FONTS = { caption: 'Arial', icon: 'Arial', 'message-box': 'Arial', menu: '"Segoe UI"', 'small-caption': '"Segoe UI"', 'status-bar': '"Segoe UI"' };
const _animReads = new WeakMap();
function animatedLeftTop(el, prop) {
  let n = _animReads.get(el) || 0;
  if (prop === 'left') { n += 1; _animReads.set(el, n); }
  const vw = 479;
  const phase = ((n - 1) % 8) / 8;
  if (prop === 'left') return (phase < 0.5 ? phase * 2 * vw : (1 - phase) * 2 * vw) + 'px';
  return (phase < 0.25 ? 0 : phase < 0.5 ? (phase - 0.25) * 4 * vw : phase < 0.75 ? vw : (1 - phase) * 4 * vw) + 'px';
}
const STYLE_STORE = Symbol('dd.styleStore');

function collectCustomProps(el) {
  const props = {};
  const chain = [];
  for (let n = el, guard = 0; n && guard < 64; n = n.parentNode || n.parentElement, guard++) chain.push(n);
  for (let i = chain.length - 1; i >= 0; i--) {
    const st = chain[i] && chain[i].style;
    if (!st) continue;
    let store; try { store = st[STYLE_STORE]; } catch (_) {}
    if (store) for (const k of Object.keys(store)) {
      if (k.startsWith('--') && store[k] !== undefined && store[k] !== '') props[k] = String(store[k]);
    }
    try {
      for (const m of String(st.cssText || '').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) props[m[1]] = m[2].trim();
    } catch (_) {}
  }
  return props;
}

function resolveDeclared(el, prop, cssText) {
  const p = String(prop);
  const kind = /^(transform|webkitTransform|-webkit-transform)$/.test(p) ? 'transform'
    : /^(color|backgroundColor|background-color|borderColor|border-color|outlineColor|outline-color)$/.test(p) ? 'color'
      : null;
  if (!kind) return undefined;
  const cssName = kind === 'transform' ? 'transform'
    : p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^-webkit/, '-webkit');
  let raw;
  try { raw = el && el.style && el.style.getPropertyValue && el.style.getPropertyValue(cssName); } catch (_) {}
  if (!raw && cssText) {
    const re = new RegExp('(?:^|;)\\s*' + cssName.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+)', 'i');
    const m = re.exec(cssText);
    if (m) raw = m[1];
  }
  if (!raw) return undefined;
  let value = String(raw).trim();
  try { value = substituteVars(value, collectCustomProps(el)); } catch (_) {}
  if (/var\(/.test(value)) return undefined;
  try {
    return kind === 'transform' ? computeTransform(value) : computeColor(value);
  } catch (_) { return undefined; }
}

function makeComputedStyle(el) {
  const cssText = (el && el.style && el.style.cssText) || '';
  let sysFont = el && el.style && (el.style.font || el.style.getPropertyValue?.('font'));
  if (!sysFont && cssText) { const m = /(?:^|;)\s*font:\s*([^;]+)/i.exec(cssText); if (m) sysFont = m[1].trim(); }
  const isAnimated = el && typeof el.className === 'string' && el.className.indexOf('rdanmdd') > -1;
  const val = (prop) => {
    const p = String(prop);
    if (globalThis.__CSS_TRACE) { try { globalThis.__CSS_TRACE(p, el); } catch (_) {} }
    if (isAnimated && (p === 'left' || p === 'top')) return animatedLeftTop(el, p);
    if ((p === 'fontFamily' || p === 'font-family') && sysFont && SYSTEM_FONTS[sysFont]) return SYSTEM_FONTS[sysFont];
    const resolved = resolveDeclared(el, p, cssText);
    return resolved !== undefined ? resolved : cssValue(p);
  };
  return new Proxy({ getPropertyValue: (p) => val(p), setProperty() {}, removeProperty() {}, length: 0, item: () => '' },
    { get(t, prop) { if (prop in t) return t[prop]; if (typeof prop === 'symbol') return undefined; return val(prop); } });
}
function makeStyleDecl(onChange) {
  const store = {};
  const fire = () => { try { if (onChange) onChange(store); } catch (_) {} };
  return new Proxy({ setProperty(k, v) { if (globalThis.__STYLE_TRACE) { try { globalThis.__STYLE_TRACE(k, v); } catch (_) {} } store[k] = v; fire(); }, getPropertyValue: (k) => store[k] ?? '', removeProperty(k) { delete store[k]; fire(); } },
    { get(t, prop) {
        if (prop === STYLE_STORE) return store;
        if (prop in t) return t[prop]; if (typeof prop === 'symbol') return undefined; return store[prop] ?? ''; },
      set(t, prop, v) { store[prop] = v; fire(); return true; } });
}

function applyStyleBox(el, store) {
  const px = (v) => (v === undefined || v === '' ? null : evalLength(String(v)));
  const w = px(store.width);
  if (w === null) return;
  const padShort = px(store.padding);
  const pl = px(store.paddingLeft ?? store['padding-left']) ?? padShort ?? 0;
  const pr = px(store.paddingRight ?? store['padding-right']) ?? padShort ?? 0;
  const border = String(store.boxSizing ?? store['box-sizing'] ?? '').trim() === 'border-box';
  const content = border ? Math.max(0, w - pl - pr) : w;
  const box = Math.round(content + pl + pr);
  el._offsetWidth = box;
  el.clientWidth = box;
  el.scrollWidth = box;
  el._cssWidth = Math.round(content);
}

const INSTALLED_FONTS = new Set(['calibri', 'cambria', 'tahoma', 'simsun', 'microsoft yahei',
  'cascadia code', 'cascadia mono', 'bahnschrift', 'ink free', 'segoe ui historic', 'segoe ui emoji',
  'sitka text', 'leelawadee ui', 'gadugi', 'nirmala ui']);
const PAGE_FONTS = new Set();
export function setPageFonts(list) {
  PAGE_FONTS.clear();
  for (const f of list || []) PAGE_FONTS.add(String(f).trim().toLowerCase());
}
export const FONT_LOG = [];

let CANVAS_FEED = null;
export function setCanvasFeed(uris) {
  CANVAS_FEED = Array.isArray(uris) && uris.length ? { uris, i: 0 } : null;
  return CANVAS_FEED ? CANVAS_FEED.uris.length : 0;
}
function fontPrimaryFrom(el) {
  let store;
  try { store = el && el.style && el.style[STYLE_STORE]; } catch (_) {}
  const fromStore = store && (store.fontFamily || store['font-family'] || store.font);
  const cssText = (el && el.style && (el.style.cssText || store && store.cssText)) || '';
  let raw = fromStore ? String(fromStore) : '';
  if (!raw && cssText) {
    const m = /font-family:\s*([^;]+)/i.exec(String(cssText));
    if (m) raw = m[1];
  }
  if (!raw) return null;
  return raw.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
}
function fontDetectWidth(el) {
  const primary = typeof el === 'string' ? null : fontPrimaryFrom(el);
  if (!primary) {
    if (typeof el === 'string') {
      const m = /font-family:\s*([^;,]+)/i.exec(el);
      if (!m) return null;
      return fontDetectWidthFromPrimary(m[1].trim().replace(/^["']|["']$/g, '').toLowerCase());
    }
    return null;
  }
  return fontDetectWidthFromPrimary(primary);
}
function fontDetectWidthFromPrimary(primary) {
  FONT_LOG.push(primary);
  if (process.env.DD_DUMP_T) {
    try {
      const g = globalThis.__DD_FONTS || (globalThis.__DD_FONTS = []);
      if (g.length < 80) g.push(primary);
    } catch (_) {}
  }
  const available = INSTALLED_FONTS.has(primary);
  return available ? 173 : 150;
}

export function canPlayType(type) {
  const t = String(type || '').toLowerCase();
  if (globalThis.__cptlog) { const r = _canPlayType(t); globalThis.__cptlog(String(type), r); return r; }
  return _canPlayType(t);
}
globalThis.__dd_cpt = canPlayType;
function _canPlayType(t) {
  if (/mpegurl/.test(t)) return 'maybe';
  if (/theora|x-flv|x-msvideo|mpeg2|dolby|ec-3|ac-3/.test(t)) return '';
  if (/video\/mpeg\b/.test(t) || /video\/quicktime/.test(t) || /video\/ogg/.test(t)) return '';
  if (/x-matroska|matroska/.test(t) || /video\/3gpp/.test(t)) return 'maybe';
  if (/video\/mp4/.test(t) && /(avc1|h264|mp4v|av01|hev1|hvc1)/.test(t)) return 'probably';
  if (/video\/webm/.test(t) && /(vp8|vp9|vp09|av01)/.test(t)) return 'probably';
  if (/audio\/mp4/.test(t) && /mp4a/.test(t)) return 'probably';
  if (/audio\/aac/.test(t)) return 'probably';
  if (/audio\/(mpeg|mp3)/.test(t)) return 'probably';
  if (/audio\/(ogg|webm)/.test(t) && /(vorbis|opus)/.test(t)) return 'probably';
  if (/audio\/flac/.test(t)) return 'probably';
  if (/audio\/wav/.test(t) && /codecs/.test(t)) return 'probably';
  if (/(ogg|ogv|ogm)/.test(t)) return '';
  if (/audio\/(mp4|x-m4a|wav|x-wav|webm)/.test(t)) return 'maybe';
  if (/video\/(mp4|webm)/.test(t)) return 'maybe';
  return '';
}
export function isTypeSupported(type) {
  const t = String(type || '').toLowerCase();
  if (globalThis.__itslog) { const r = _isTypeSupported(t); globalThis.__itslog(String(type), r); return r; }
  return _isTypeSupported(t);
}
function _isTypeSupported(t) {
  if (/theora|matroska|x-matroska|3gpp|quicktime|ogg|ogv|dolby|ec-3|ac-3|mpegurl/.test(t)) return false;
  if (/^audio\/(mpeg|aac)/.test(t)) return true;
  return /(video\/mp4|video\/webm|audio\/mp4|audio\/webm|audio\/mpeg)/.test(t) && /(avc1|h264|av01|vp8|vp9|vp09|hev1|hvc1|mp4a|opus|vorbis|aac)/.test(t);
}

function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), nodeType: 1, dataset: {},
    classList: makeClassList(), children: [], childNodes: [], attributes: {},
    width: /^canvas$/i.test(tag) ? 300 : 0, height: /^canvas$/i.test(tag) ? 150 : 0, textContent: '',
    id: '', className: '',
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) {
      this._innerHTML = String(v == null ? '' : v);
      this.children.length = 0;
      if (this.childNodes) this.childNodes.length = 0;
      try { buildFragment(this._innerHTML, makeElement, this); } catch (_) {}
    },
    _offsetWidth: 0,
    get offsetWidth() { const w = fontDetectWidth(this); return w == null ? this._offsetWidth : w; },
    set offsetWidth(v) { this._offsetWidth = v; },
    offsetHeight: 0, offsetLeft: 0, offsetTop: 0,
    clientWidth: 0, clientHeight: 0, clientLeft: 0, clientTop: 0,
    scrollWidth: 0, scrollHeight: 0, scrollLeft: 0, scrollTop: 0,
    _laidOut: true,
    nodeName: String(tag || 'div').toUpperCase(), namespaceURI: 'http://www.w3.org/1999/xhtml',
    setAttribute(k, v) {
      this.attributes[k] = v;
      const n = String(k).toLowerCase();
      if (n === 'id') this.id = String(v);
      else if (n === 'class') {
        this.className = String(v);
        if (this.classList && this.classList.add) for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
      } else if (n === 'style') { this._inlineCss = String(v); if (this.style) this.style.cssText = String(v); }
      else if (n === 'width' && /^canvas$/i.test(tag)) this.width = Number(v) || 0;
      else if (n === 'height' && /^canvas$/i.test(tag)) this.height = Number(v) || 0;
    },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); if (c && c._parent !== undefined) c._parent = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(newNode, refNode) { if (!refNode) { this.children.push(newNode); } else { const i = this.children.indexOf(refNode); if (i >= 0) this.children.splice(i, 0, newNode); else this.children.push(newNode); } if (newNode && newNode._parent !== undefined) newNode._parent = this; return newNode; },
    replaceChild(newNode, oldNode) { const i = this.children.indexOf(oldNode); if (i >= 0) this.children[i] = newNode; if (newNode && newNode._parent !== undefined) newNode._parent = this; return oldNode; },
    prepend(...nodes) { this.children.unshift(...nodes); },
    append(...nodes) { this.children.push(...nodes); },
    insertAdjacentElement(pos, el) { this.children.push(el); return el; },
    insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {}, remove() {},
    dispatchEvent() { return true; },
    getContext(kind, attrs) {
      if (kind === '2d') return this._ctx2d || attachSkiaCanvas(this);
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
        chargeRender(9.4 + Math.random() * 6.2);
        const gl = adoptFns(makeWebGLContext(ACTIVE_PROF, attrs, this));
        try { Object.defineProperty(gl, Symbol.toStringTag, { value: kind === 'webgl2' ? 'WebGL2RenderingContext' : 'WebGLRenderingContext', configurable: true }); } catch (_) {}
        return gl;
      }
      return null;
    },
    toDataURL(type, quality) {
      if (CANVAS_FEED && CANVAS_FEED.uris && CANVAS_FEED.i < CANVAS_FEED.uris.length) {
        return CANVAS_FEED.uris[CANVAS_FEED.i++];
      }
      if (!this._skiaCanvas) attachSkiaCanvas(this);
      let out = gpuDataURL(this, type, quality);
      if (out == null && typeof type === 'string') {
        try { out = this._skiaCanvas.toDataURL(type, quality); } catch (_) {}
      }
      if (out == null) out = this._skiaCanvas.toDataURL('image/png');
      chargeRender(1.55 + (Number(this.width) || 300) * (Number(this.height) || 300) / 90000 * 0.55 + Math.random() * 0.25);
      if (process.env.DD_DUMP_PICASSO) {
        (globalThis.__PICASSO = globalThis.__PICASSO || []).push({ w: this.width, h: this.height, len: out.length, full: out });
      }
      if (process.env.DD_TRACE_CTX && globalThis.__CTXLOG) globalThis.__CTXLOG.push({ snapshot: out.length });
      return out;
    },
    toBlob(cb) { if (typeof cb === 'function') cb({ size: 0, type: 'image/png', _dataURL: this.toDataURL() }); },
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    querySelector(sel) { const hit = findInTree(this, String(sel || '')); return hit || makeElement('div'); },
    querySelectorAll(sel) { const hit = findInTree(this, String(sel || '')); return hit ? [hit] : [makeElement('div')]; },
    getElementsByTagName() { return [makeElement('div')]; },
    getElementsByClassName() { return [makeElement('div')]; },
    get firstElementChild() { return this.children[0] || makeElement('div'); },
    get lastElementChild() { return this.children[this.children.length - 1] || makeElement('div'); },
    get firstChild() { return this.children[0] || makeElement('div'); },
    get lastChild() { return this.children[this.children.length - 1] || makeElement('div'); },
    get parentNode() { return this._parent || (this._parent = makeElement('div')); },
    get parentElement() { return this.parentNode; },
    get offsetParent() { return SHARED_OFFSET_PARENT || (SHARED_OFFSET_PARENT = makeElement('body')); },
    get nextSibling() { return null; }, get previousSibling() { return null; },
    get nextElementSibling() { return null; }, get previousElementSibling() { return null; },
    contains() { return true; }, cloneNode() { return makeElement(this.tagName); },
    hasAttribute(k) { return k in this.attributes; }, removeAttribute(k) { delete this.attributes[k]; },
    _svgDim(name) {
      const a = this.attributes && this.attributes[name];
      const v = a !== undefined && a !== null ? Number(a) : Number(this[name]);
      return Number.isFinite(v) ? v : 0;
    },
    getBBox() {
      const w = this._svgDim('width'), h = this._svgDim('height');
      if (w || h) return { x: 0, y: 0, width: w, height: h };
      return { x: 0, y: 0, width: this._offsetWidth || 300, height: this.offsetHeight || 150 };
    },
    getTotalLength() {
      const w = this._svgDim('width'), h = this._svgDim('height');
      if (w || h) return 2 * (w + h);
      return 100;
    },
    getPointAtLength(d) { return { x: Number(d) || 0, y: 0 }; },
    getScreenCTM() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    getCTM() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: 0, y: 0 }; } }; },
    isPointInFill(pt) {
      const b = this.getBBox();
      const x = Number(pt && pt.x) || 0, y = Number(pt && pt.y) || 0;
      return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    },
    isPointInStroke(pt) {
      const b = this.getBBox();
      const x = Number(pt && pt.x) || 0, y = Number(pt && pt.y) || 0;
      const w = Number(this.attributes && this.attributes['stroke-width']) || 1;
      const onEdge = (v, lo, hi) => Math.abs(v - lo) <= w || Math.abs(v - hi) <= w;
      const inX = x >= b.x - w && x <= b.x + b.width + w;
      const inY = y >= b.y - w && y <= b.y + b.height + w;
      return inX && inY && (onEdge(x, b.x, b.x + b.width) || onEdge(y, b.y, b.y + b.height));
    },
    canPlayType(type) { return canPlayType(type); },
    play() { return Promise.resolve(); }, pause() {}, load() {}, addTextTrack() { return {}; },
  };
  el.ownerDocument = null;
  {
    const t = el.tagName;
    const box = t === 'HTML' ? [1002, 814] : t === 'BODY' ? [1002, 442] : t === 'CANVAS' ? [0, 0]
      : t === 'BUTTON' ? [63, 40] : t === 'INPUT' ? [180, 24] : t === 'SPAN' || t === 'I' ? [16, 19]
      : t === 'P' ? [280, 19] : t === 'IFRAME' ? [0, 0] : [280, 40];
    el._offsetWidth = box[0]; el.offsetHeight = box[1];
    el.clientWidth = box[0]; el.clientHeight = box[1];
    el.scrollWidth = box[0]; el.scrollHeight = box[1];
  }
  nativizeAll(el);
  installEvents(el);
  try {
    Object.setPrototypeOf(el, htmlProtoFor(el.tagName));
    Object.defineProperty(el, Symbol.toStringTag, { value: htmlIfaceName(el.tagName), configurable: true });
  } catch (_) {}
  if (el.tagName === 'CANVAS') {
    let cw = 300, ch = 150;
    Object.defineProperty(el, 'width', {
      configurable: true, enumerable: true,
      get() { return cw; },
      set(v) {
        cw = Number(v) || 0;
        el._skiaCanvas = null;
        el._ctx2d = null;
        if (process.env.DD_DUMP_T) {
          try {
            const g = globalThis.__DD_CW || (globalThis.__DD_CW = []);
            if (g.length < 40) g.push(cw);
          } catch (_) {}
        }
      },
    });
    Object.defineProperty(el, 'height', {
      configurable: true, enumerable: true,
      get() { return ch; },
      set(v) { ch = Number(v) || 0; el._skiaCanvas = null; el._ctx2d = null; },
    });
  }
  if (el.tagName === 'IFRAME') {
    const childWin = makeChildWindow();
    Object.defineProperty(el, 'contentWindow', { configurable: true, get() { return childWin; } });
    Object.defineProperty(el, 'contentDocument', { configurable: true, get() { return childWin.document; } });
  }
  const styleDecl = makeStyleDecl((store) => applyStyleBox(el, store));
  Object.defineProperty(el, 'style', { configurable: true, enumerable: true, get() { return styleDecl; }, set(v) { styleDecl.cssText = String(v); } });
  return el;
}

function makeWorkerClass(state, fp) {
  return class MockWorker {
    constructor(_url, opts) {
      this.name = (opts && opts.name) || '';
      this.onmessage = null;
      this.onerror = null;
      const WORKER_LATENCY = Number(process.env.DD_WORKER_MS || 550);
      const deliver = (data) => state.enqueue(() => { if (this.onmessage) this.onmessage({ data }); }, WORKER_LATENCY, 'worker-msg');
      deliver([2, { pP: 'low-power', t: 3.2 + Math.random() * 9 }]);
      deliver([0, fp.nav]);
      deliver([1, fp.textHash]);
    }
    postMessage() {}
    terminate() {}
    addEventListener(t, fn) { if (t === 'message') this.onmessage = fn; }
    removeEventListener() {}
  };
}

function makeXHRClass(state) {
  return class MockXHR {
    constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.responseURL = ''; this._headers = {}; this.onload = null; this.onerror = null; this.onreadystatechange = null; this._listeners = { load: [], error: [], readystatechange: [] }; }
    open(method, url) { this._method = method; this._url = url; this.responseURL = url; this.readyState = 1; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    addEventListener(type, fn) { if (typeof fn === 'function') (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
    removeEventListener(type, fn) { const a = this._listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    send(body) {
      state.xhr.push({ method: this._method, url: this._url, headers: this._headers, body });
      this.status = 200; this.readyState = 4;
      this.responseText = JSON.stringify({ cookie: 'datadome=MOCK; Max-Age=1', view: 'redirect', url: 'https://www.paypal.com/ux/signin' });
      state.enqueue(() => {
        const ev = { type: 'load', target: this, currentTarget: this };
        if (this.onload) this.onload.call(this, ev);
        for (const fn of (this._listeners.load || []).slice()) { try { fn.call(this, ev); } catch (_) {} }
        if (this.onreadystatechange) this.onreadystatechange.call(this, ev);
        for (const fn of (this._listeners.readystatechange || []).slice()) { try { fn.call(this, ev); } catch (_) {} }
      }, 0, 'xhr-load');
    }
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    abort() {}
  };
}

export function adoptRealm(ctx, sandbox) {
  try { vm.runInContext('Error', ctx); } catch (_) {}
  installFilteredError(ctx);
  const vmObjProto = vm.runInContext('Object.prototype', ctx);
  const nodeObjProto = Object.prototype;
  if (vmObjProto === nodeObjProto) return 0;

  const vmFnProto = vm.runInContext('Function.prototype', ctx);
  VM_FN_PROTO = vmFnProto;
  try {
    Object.defineProperty(vmFnProto, 'toString', { value: SHARED_TOSTRING, writable: true, configurable: true });
  } catch (_) {}
  const rerootFn = (fn) => fn;
  const rerooted = new Set();
  let n = 0;
  const reroot = (o) => {
    let cur = o, depth = 0;
    while (cur && typeof cur === 'object' && depth++ < 24) {
      const p = Object.getPrototypeOf(cur);
      if (p === nodeObjProto) {
        if (!rerooted.has(cur)) { rerooted.add(cur); try { Object.setPrototypeOf(cur, vmObjProto); n++; } catch (_) {} }
        return;
      }
      if (!p) return;
      cur = p;
    }
  };
  try {
    const WindowProto = Object.create(DOM_CTORS.EventTarget.prototype);
    Object.defineProperty(WindowProto, Symbol.toStringTag, { value: 'Window', configurable: true });
    Object.defineProperty(WindowProto, 'constructor', { value: sandbox.Window || nativeCtor('Window'), writable: true, configurable: true });
    for (const m of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
      if (Object.prototype.hasOwnProperty.call(sandbox, m)) {
        const fn = sandbox[m];
        delete sandbox[m];
        Object.defineProperty(DOM_CTORS.EventTarget.prototype, m, { value: markNative(fn, m), writable: true, enumerable: false, configurable: true });
      }
    }
    Object.setPrototypeOf(sandbox, WindowProto);
    reroot(DOM_CTORS.EventTarget.prototype);
  } catch (_) {}
  try { vm.runInContext('delete globalThis.SharedArrayBuffer; delete globalThis.webkitAudioContext;', ctx); } catch (_) {}

  try {
    const done = new Set();
    const deep = (o, depth) => {
      if (!o || depth > 2 || done.has(o)) return;
      if (typeof o !== 'object' && typeof o !== 'function') return;
      done.add(o);
      nativizeAll(o);
      for (const k of Object.getOwnPropertyNames(o)) {
        let d;
        try { d = Object.getOwnPropertyDescriptor(o, k); } catch (_) { continue; }
        if (!d || d.get || d.set) continue;
        const v = d.value;
        if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
        if (v === globalThis || v === o) continue;
        deep(v, depth + 1);
      }
      const proto = Object.getPrototypeOf(o);
      if (proto && proto !== Object.prototype && proto !== Function.prototype) deep(proto, depth + 1);
    };
    for (const k of Object.getOwnPropertyNames(sandbox)) {
      if (k in globalThis) continue;
      let d; try { d = Object.getOwnPropertyDescriptor(sandbox, k); } catch (_) { continue; }
      if (!d || d.get || d.set) continue;
      deep(d.value, 0);
    }
    deep(sandbox.navigator, 0); deep(sandbox.document, 0); deep(sandbox.screen, 0);
    deep(sandbox.performance, 0); deep(sandbox.localStorage, 0); deep(sandbox.history, 0);
    for (const k of ['permissions', 'mediaDevices', 'storage', 'connection', 'clipboard', 'credentials',
      'serviceWorker', 'geolocation', 'locks', 'wakeLock', 'usb', 'xr', 'hid', 'serial', 'bluetooth',
      'mediaSession', 'presentation', 'scheduling', 'userActivation', 'virtualKeyboard', 'devicePosture',
      'ink', 'login', 'managed', 'storageBuckets', 'protectedAudience', 'windowControlsOverlay',
      'webkitTemporaryStorage', 'webkitPersistentStorage', 'userAgentData']) {
      try { deep(sandbox.navigator[k], 1); } catch (_) {}
    }
    try { deep(sandbox.document.fonts, 1); } catch (_) {}
    try { deep(sandbox.screen.orientation, 1); } catch (_) {}
    try { deep(sandbox.performance.memory, 1); deep(sandbox.performance.timing, 1); } catch (_) {}
  } catch (_) {}

  const seeds = [sandbox, sandbox.document, sandbox.navigator, sandbox.screen, sandbox.performance,
    sandbox.location, sandbox.history, sandbox.localStorage, sandbox.sessionStorage,
    sandbox.document && sandbox.document.body, sandbox.document && sandbox.document.documentElement,
    sandbox.document && sandbox.document.fonts, sandbox.crypto, sandbox.indexedDB,
    EVENT_CTORS.Event.prototype, EVENT_CTORS.UIEvent.prototype,
    EVENT_CTORS.MouseEvent.prototype, EVENT_CTORS.PointerEvent.prototype,
    DOM_CTORS.EventTarget.prototype, DOM_CTORS.Node.prototype,
    DOM_CTORS.Element.prototype, DOM_CTORS.HTMLElement.prototype,
    ...Object.values(DOM_CTORS.byTag || {}).map((C) => C && C.prototype),
  ].filter(Boolean);
  for (const s of seeds) reroot(s);
  try { reroot(sandbox.document.createElement('div')); } catch (_) {}
  try { vm.runInContext('Error', ctx); } catch (_) {}
  installFilteredError(ctx);
  return n;
}

export function makeSandbox({ ddm, prof = CHROME151_WIN10, fp = null, nowMs = Date.now(), pageSize = '0', webFonts = [], context = process.env.DD_CTX || 'top' } = {}) {
  const embedded = context === 'iframe';
  setPageFonts(webFonts);
  const state = {
    timers: [], seq: 0, xhr: [], logs: [], vnow: 0,
    enqueue(fn, delay = 0, tag = 'timer') {
      const d = Number(delay) || 0;
      const id = ++this.lastId;
      this.timers.push({ fn, id, at: this.seq++, delay: d, due: this.vnow + d, tag });
      return id;
    },
    cancel(id) {
      const i = this.timers.findIndex((t) => t.id === id);
      if (i >= 0) this.timers.splice(i, 1);
    },
    lastId: 0,
  };
  fp = fp || defaultFpResults(prof, ddm && ddm.seed);
  ACTIVE_PROF = prof;

  const CLOCK_MODE = process.env.DD_CLOCK || 'real';
  let clock = nowMs;
  const t0 = Date.now();
  const gpuBaseMs = GPU.gpuElapsedMs();
  const realElapsed = () => Date.now() - t0 - (GPU.gpuElapsedMs() - gpuBaseMs);
  const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
  let dateWindow = null;
  state.beginDateWindow = (budgetMs) => { dateWindow = { at: realElapsed(), hr: hrMs(), budget: Number(budgetMs) || 0 }; };
  state.endDateWindow = () => {
    if (!dateWindow) return;
    skew -= Math.max(0, (realElapsed() - dateWindow.at) - dateWindow.budget);
    dateWindow = null;
  };
  let skew = 0;
  let lastNowValue = 0;
  const monotonic = (v) => (v < lastNowValue ? lastNowValue : (lastNowValue = v));
  const nowFn = CLOCK_MODE === 'calls'
    ? () => (clock += 1)
    : () => monotonic((() => {
      const e = realElapsed();
      if (dateWindow) {
        if (dateWindow.anchored === undefined) { dateWindow.anchored = true; return nowMs + skew + dateWindow.at; }
        return nowMs + skew + dateWindow.at + dateWindow.budget;
      }
      return nowMs + skew + e;
    })());

  const RealDate = Date;
  function DateMock(...args) {
    if (!new.target) return RealDate();
    return args.length ? new RealDate(...args) : new RealDate(nowFn());
  }
  DateMock.prototype = RealDate.prototype;
  DateMock.now = markNative(function now() { return nowFn(); }, 'now');
  DateMock.parse = RealDate.parse;
  DateMock.UTC = RealDate.UTC;
  try { Object.defineProperty(DateMock, 'name', { value: 'Date', configurable: true }); } catch (_) {}
  markNative(DateMock, 'Date');
  let perfClock = 71.30000000000001;
  const perfNow = () => (perfClock += 0.10000000000000142 + drainRenderMs());

  const RealWA = globalThis.WebAssembly;
  let sandboxWA = RealWA;
  if (RealWA) {
    sandboxWA = Object.create(Object.getPrototypeOf(RealWA));
    for (const k of Object.getOwnPropertyNames(RealWA)) {
      try { Object.defineProperty(sandboxWA, k, Object.getOwnPropertyDescriptor(RealWA, k)); } catch (_) {}
    }
    for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) {
      const orig = RealWA[name];
      if (typeof orig !== 'function') continue;
      const f = function () { perfClock += 1.8000000000000114; return orig.apply(RealWA, arguments); };
      try { Object.defineProperty(f, 'name', { value: name, configurable: true }); } catch (_) {}
      try { Object.defineProperty(f, 'length', { value: orig.length, configurable: true }); } catch (_) {}
      markNative(f, name);
      try { Object.defineProperty(sandboxWA, name, { value: f, writable: true, enumerable: false, configurable: true }); } catch (_) {}
    }
    for (const name of ['Module', 'Instance']) {
      const Real = RealWA[name];
      if (typeof Real !== 'function') continue;
      const Wrap = function (a, b) {
        if (!new.target) throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
        const t0 = Number(process.hrtime.bigint() / 1000n) / 1000;
        const out = arguments.length > 1 ? new Real(a, b) : new Real(a);
        const spent = Number(process.hrtime.bigint() / 1000n) / 1000 - t0;
        perfClock += Math.max(spent, name === 'Module' ? 2.4 + Math.random() * 3.1 : 1.1 + Math.random() * 1.7);
        return out;
      };
      Wrap.prototype = Real.prototype;
      try { Object.setPrototypeOf(Wrap, Real); } catch (_) {}
      try { Object.defineProperty(Wrap, 'name', { value: name, configurable: true }); } catch (_) {}
      try { Object.defineProperty(Wrap, 'length', { value: Real.length, configurable: true }); } catch (_) {}
      markNative(Wrap, name);
      try { Object.defineProperty(sandboxWA, name, { value: Wrap, writable: true, enumerable: false, configurable: true }); } catch (_) {}
    }
    try { Object.defineProperty(sandboxWA, Symbol.toStringTag, { value: 'WebAssembly', configurable: true }); } catch (_) {}
  }

  const innerW = Number(prof && prof.innerWidth) || 1773;
  const innerH = Number(prof && prof.innerHeight) || 829;
  const documentEl = makeElement('html');
  documentEl.offsetWidth = 958; documentEl.offsetHeight = 442; documentEl.clientWidth = 958; documentEl.clientHeight = 937; documentEl.scrollWidth = 958; documentEl.scrollHeight = 937;
  const bodyEl = makeElement('body');
  bodyEl.offsetWidth = 958; bodyEl.offsetHeight = 442; bodyEl.clientWidth = 958; bodyEl.clientHeight = 442; bodyEl.scrollWidth = 958; bodyEl.scrollHeight = 442;
  const headEl = makeElement('head');
  const knownIds = {
    'device-check__ok': makeElement('div'),
    'device-check__ko': makeElement('div'),
    'device-check__loading': makeElement('div'),
  };
  const documentMock = {
    documentElement: documentEl, body: bodyEl, head: headEl, readyState: 'complete', cookie: '',
    scrollingElement: documentEl, activeElement: bodyEl, currentScript: makeElement('script'),
    createElement: (t) => makeElement(t),
    createElementNS: (ns, t) => {
      const el = makeElement(t);
      if (String(ns || '').indexOf('2000/svg') >= 0) {
        const tag = String(t || '').toLowerCase();
        const SVG_CLASS = {
          svg: 'SVGSVGElement', path: 'SVGPathElement', rect: 'SVGRectElement', circle: 'SVGCircleElement',
          ellipse: 'SVGEllipseElement', line: 'SVGLineElement', polygon: 'SVGPolygonElement',
          polyline: 'SVGPolylineElement', g: 'SVGGElement', text: 'SVGTextElement', defs: 'SVGDefsElement',
          use: 'SVGUseElement', image: 'SVGImageElement', filter: 'SVGFilterElement',
        };
        try { Object.defineProperty(el, Symbol.toStringTag, { value: SVG_CLASS[tag] || 'SVGElement', configurable: true }); } catch (_) {}
      }
      return el;
    },
    getElementById: markNative((id) => (knownIds[id] || (knownIds[id] = makeElement('div'))), 'getElementById'),
    getElementsByTagName: markNative((tag) => domPool(String(tag || '*')), 'getElementsByTagName'),
    getElementsByClassName: (cls) => {
      const c = String(cls);
      if (c === 'rdanmdd') { if (!SHARED_ANIMATED_EL) { SHARED_ANIMATED_EL = makeElement('div'); SHARED_ANIMATED_EL.className = 'rdanmdd'; } return [SHARED_ANIMATED_EL]; }
      return [makeElement('div')];
    },
    querySelector: markNative((sel) => {
      const s = typeof sel === 'string' ? sel : '';
      if (s.indexOf('dd-page-size') > -1) {
        const el = makeElement('meta'); el.setAttribute('content', String(pageSize)); return el;
      }
      if (/browserflow|genspark|pplx-agent|stagehand|fellou|puppeteer|playwright|selenium|webdriver|nightmare|phantom|automation/i.test(s)) return null;
      return makeElement('div');
    }, 'querySelector'), querySelectorAll: markNative((sel) => {
      const s = String(sel || '');
      if (/browserflow|genspark|pplx-agent|stagehand|fellou|puppeteer|playwright|selenium|webdriver|nightmare|phantom|automation/i.test(s)) return [];
      return /^[a-z*]+$/i.test(s) ? domPool(s) : [makeElement('div')];
    }, 'querySelectorAll'),
    evaluate: markNative(() => ({ snapshotLength: 0, snapshotItem: () => null, iterateNext: () => null, singleNodeValue: null }), 'evaluate'),
    forms: [makeElement('form')], images: [makeElement('img')], links: [makeElement('a')], scripts: [makeElement('script')],
    addEventListener: () => {}, removeEventListener: () => {},
    createEvent: () => ({ initEvent() {}, initCustomEvent() {} }),
    hasFocus: () => !embedded, hidden: false, visibilityState: 'visible',
    lastModified: (function(){var d=new Date(nowMs),p=n=>String(n).padStart(2,"0");return p(d.getMonth()+1)+"/"+p(d.getDate())+"/"+d.getFullYear()+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());})(),
    title: "", referrer: "",
    characterSet: 'UTF-8', charset: 'UTF-8', inputEncoding: 'UTF-8',
    contentType: 'text/html', compatMode: 'CSS1Compat', designMode: 'off',
    dir: '', domain: 'geo.captcha-delivery.com', doctype: { name: 'html', publicId: '', systemId: '' },
    fullscreenEnabled: true, fullscreenElement: null, pictureInPictureEnabled: true,
    pictureInPictureElement: null, pointerLockElement: null, scrollingElementTagName: 'HTML',
    childElementCount: 1, hidden_: false, wasDiscarded: false, prerendering: false,
    timeline: { currentTime: 0 }, adoptedStyleSheets: [],
    fonts: (() => {
      const faces = (webFonts || []).map((family) => ({
        family, style: 'normal', weight: '400', stretch: 'normal', unicodeRange: 'U+0-10FFFF',
        variant: 'normal', featureSettings: 'normal', display: 'auto', status: 'loaded',
        load() { return Promise.resolve(this); }, loaded: Promise.resolve(),
      }));
      const set = {
        size: faces.length, status: 'loaded', ready: Promise.resolve(),
        onloading: null, onloadingdone: null, onloadingerror: null,
        [Symbol.iterator]() { return faces[Symbol.iterator](); },
        values() { return faces[Symbol.iterator](); },
        keys() { return faces[Symbol.iterator](); },
        entries() { return faces.map((f) => [f, f])[Symbol.iterator](); },
        forEach(cb, thisArg) { faces.forEach((f) => cb.call(thisArg, f, f, set)); },
        check(font) { const s = String(font || '').toLowerCase(); return faces.some((f) => s.includes(String(f.family).toLowerCase())); },
        load(font) { return Promise.resolve(faces.filter((f) => String(font || '').includes(f.family))); },
        add() { return set; }, delete() { return false; }, clear() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      };
      return set;
    })(),
  };
  installEvents(documentMock);
  ACTIVE_DOCUMENT = documentMock;

  const navigatorMock = {
    userAgent: prof.userAgent, appVersion: prof.appVersion, appName: 'Netscape', appCodeName: 'Mozilla',
    platform: prof.platform, vendor: prof.vendor, vendorSub: '', product: 'Gecko', productSub: '20030107',
    language: prof.language, languages: prof.languages, onLine: prof.onLine, webdriver: prof.webdriver,
    hardwareConcurrency: prof.hardwareConcurrency, deviceMemory: prof.deviceMemory, maxTouchPoints: prof.maxTouchPoints,
    cookieEnabled: true, doNotTrack: null, pdfViewerEnabled: true,
    userAgentData: { mobile: false, platform: 'Windows', brands: CHROME_BRANDS,
      getHighEntropyValues: () => new Promise((resolve) => state.enqueue(() => resolve({ platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false, uaFullVersion: CHROME_FULL, fullVersionList: CHROME_FULL_VERSION_LIST }), ASYNC_LATENCY.highEntropy, 'ua-high-entropy')) },
    keyboard: {
      getLayoutMap: () => new Promise((_resolve, reject) => state.enqueue(

        () => reject(new Error('getLayoutMap() must be called from a top-level browsing context or allowed by the permission policy.')),
        ASYNC_LATENCY.keyboardLayout, 'keyboard-layout')),
    },
    javaEnabled: () => false, sendBeacon: () => true,
    permissions: {
      query: (d) => new Promise((resolve) => state.enqueue(() => resolve({
        state: 'denied',
        name: (d && d.name) || '', onchange: null,
      }), ASYNC_LATENCY.permissionsQuery, 'permissions-query')),
    },
    mediaDevices: {
      enumerateDevices: () => new Promise((resolve) => state.enqueue(() => resolve([
        { kind: 'audioinput', label: '', deviceId: '', groupId: '' },
        { kind: 'videoinput', label: '', deviceId: '', groupId: '' },
        { kind: 'audiooutput', label: '', deviceId: '', groupId: '' },
      ]), ASYNC_LATENCY.enumerateDevices, 'enumdev')),
      getUserMedia: () => Promise.reject(new Error('NotAllowedError')), ondevicechange: null,
    },

    connection: prof.connection,
    gpu: {
      getPreferredCanvasFormat: () => 'bgra8unorm',
      wgslLanguageFeatures: new Set(['packed_4x8_integer_dot_product', 'subgroup_uniformity', 'immediate_address_space', 'subgroup_id', 'linear_indexing', 'readonly_and_readwrite_storage_textures', 'unrestricted_pointer_parameters', 'texture_and_sampler_let', 'pointer_composite_access', 'uniform_buffer_standard_layout']),
      requestAdapter: () => new Promise((resolve) => state.enqueue(() => { perfClock += 234.9 + Math.random() * 0.3; resolve({
        features: new Set(['depth32float-stencil8', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'texture-formats-tier1', 'texture-compression-bc', 'dual-source-blending', 'core-features-and-limits', 'float32-filterable', 'indirect-first-instance', 'float32-blendable', 'depth-clip-control', 'texture-compression-bc-sliced-3d', 'timestamp-query', 'shader-f16', 'texture-formats-tier2', 'clip-distances', 'primitive-index', 'texture-component-swizzle', 'subgroups']),
        limits: { maxTextureDimension1D: 16384, maxTextureDimension2D: 16384, maxTextureDimension3D: 2048, maxBufferSize: 2147483648, maxStorageBufferBindingSize: 2147483644, maxBindGroups: 4 },
        isFallbackAdapter: false,
        info: { vendor: 'intel', architecture: 'gen-12lp', device: '', description: '', subgroupMinSize: 8, subgroupMaxSize: 16, isFallbackAdapter: false },
        requestAdapterInfo: () => Promise.resolve({ vendor: 'intel', architecture: 'gen-12lp', device: '', description: '', subgroupMinSize: 8, subgroupMaxSize: 16, isFallbackAdapter: false }),
        requestDevice: () => Promise.resolve({ features: new Set(), limits: {} }),
      }); }, ASYNC_LATENCY.gpuAdapter, 'gpu-adapter')),
    },
    mediaCapabilities: { decodingInfo: () => Promise.resolve({ supported: true, smooth: true, powerEfficient: true }) },
    getBattery: () => new Promise((resolve) => state.enqueue(() => resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 }), ASYNC_LATENCY.battery, 'get-battery')),
    storage: { estimate: () => new Promise((resolve) => state.enqueue(() => resolve({ quota: 10737418240, usage: 0, usageDetails: {} }), ASYNC_LATENCY.storageEstimate, 'storage-estimate')), persisted: () => Promise.resolve(false) },
  };
  const NavigatorCtor = nativeCtor('Navigator');
  const navProto = NavigatorCtor.prototype;
  for (const p of ['hardwareConcurrency', 'platform', 'userAgent', 'language', 'languages', 'vendor', 'deviceMemory', 'maxTouchPoints', 'webdriver', 'onLine', 'appVersion', 'product', 'productSub', 'vendorSub', 'cookieEnabled', 'doNotTrack']) {
    if (!(p in navigatorMock)) continue;
    const val = navigatorMock[p];
    delete navigatorMock[p];
    Object.defineProperty(navProto, p, { get: markNative(function () { return val; }, 'get ' + p), enumerable: true, configurable: true });
  }
  const pmt = makePluginsAndMimeTypes();
  Object.defineProperty(navProto, 'plugins', { get: markNative(function plugins() { return pmt.plugins; }, 'get plugins'), enumerable: true, configurable: true });
  Object.defineProperty(navProto, 'mimeTypes', { get: markNative(function mimeTypes() { return pmt.mimeTypes; }, 'get mimeTypes'), enumerable: true, configurable: true });
  Object.setPrototypeOf(navigatorMock, navProto);
  for (const p of Object.getOwnPropertyNames(navigatorMock)) {
    const d = Object.getOwnPropertyDescriptor(navigatorMock, p);
    if (!d || !d.configurable) continue;
    delete navigatorMock[p];
    if (typeof d.value === 'function') {
      Object.defineProperty(navProto, p, { value: markNative(d.value, p), writable: true, enumerable: true, configurable: true });
    } else {
      const val = d.value;
      Object.defineProperty(navProto, p, { get: markNative(function () { return val; }, 'get ' + p), enumerable: true, configurable: true });
    }
  }
  {
    const objs = {
      scheduling: { isInputPending: markNative(() => false, 'isInputPending') },
      userActivation: { hasBeenActive: true, isActive: false },
      geolocation: { getCurrentPosition: markNative(() => {}, 'getCurrentPosition'), watchPosition: markNative(() => 0, 'watchPosition'), clearWatch: markNative(() => {}, 'clearWatch') },
      clipboard: { read: markNative(() => Promise.reject(new Error('denied')), 'read'), readText: markNative(() => Promise.reject(new Error('denied')), 'readText'), write: markNative(() => Promise.resolve(), 'write'), writeText: markNative(() => Promise.resolve(), 'writeText') },
      credentials: { get: markNative(() => Promise.resolve(null), 'get'), store: markNative(() => Promise.resolve(), 'store'), create: markNative(() => Promise.resolve(null), 'create'), preventSilentAccess: markNative(() => Promise.resolve(), 'preventSilentAccess') },
      serviceWorker: { controller: null, ready: new Promise(() => {}), register: markNative(() => Promise.reject(new Error('n/a')), 'register'), getRegistration: markNative(() => Promise.resolve(undefined), 'getRegistration'), getRegistrations: markNative(() => Promise.resolve([]), 'getRegistrations'), addEventListener: markNative(() => {}, 'addEventListener') },
      locks: { request: markNative(() => Promise.resolve(), 'request'), query: markNative(() => Promise.resolve({ held: [], pending: [] }), 'query') },
      wakeLock: { request: markNative(() => Promise.reject(new Error('n/a')), 'request') },
      virtualKeyboard: { boundingRect: { x: 0, y: 0, width: 0, height: 0 }, overlaysContent: false, show: markNative(() => {}, 'show'), hide: markNative(() => {}, 'hide') },
      devicePosture: { type: 'continuous' },
      mediaSession: { metadata: null, playbackState: 'none', setActionHandler: markNative(() => {}, 'setActionHandler') },
      presentation: { defaultRequest: null, receiver: null },
      bluetooth: { getAvailability: markNative(() => Promise.resolve(false), 'getAvailability'), requestDevice: markNative(() => Promise.reject(new Error('n/a')), 'requestDevice') },
      hid: { getDevices: markNative(() => Promise.resolve([]), 'getDevices'), requestDevice: markNative(() => Promise.resolve([]), 'requestDevice') },
      serial: { getPorts: markNative(() => Promise.resolve([]), 'getPorts'), requestPort: markNative(() => Promise.reject(new Error('n/a')), 'requestPort') },
      usb: { getDevices: markNative(() => Promise.resolve([]), 'getDevices'), requestDevice: markNative(() => Promise.reject(new Error('n/a')), 'requestDevice') },
      xr: { isSessionSupported: markNative(() => Promise.resolve(false), 'isSessionSupported'), requestSession: markNative(() => Promise.reject(new Error('n/a')), 'requestSession') },
      ink: { requestPresenter: markNative(() => Promise.reject(new Error('n/a')), 'requestPresenter') },
      login: { setStatus: markNative(() => {}, 'setStatus') },
      managed: { getManagedConfiguration: markNative(() => Promise.reject(new Error('n/a')), 'getManagedConfiguration') },
      storageBuckets: { open: markNative(() => Promise.reject(new Error('n/a')), 'open'), keys: markNative(() => Promise.resolve([]), 'keys'), delete: markNative(() => Promise.resolve(), 'delete') },
      protectedAudience: { queryFeatureSupport: markNative(() => ({}), 'queryFeatureSupport') },
      windowControlsOverlay: { visible: false, getTitlebarAreaRect: markNative(() => ({ x: 0, y: 0, width: 0, height: 0 }), 'getTitlebarAreaRect') },
      webkitTemporaryStorage: { queryUsageAndQuota: markNative(() => {}, 'queryUsageAndQuota'), requestQuota: markNative(() => {}, 'requestQuota') },
      webkitPersistentStorage: { queryUsageAndQuota: markNative(() => {}, 'queryUsageAndQuota'), requestQuota: markNative(() => {}, 'requestQuota') },
    };
    const brands = { scheduling: 'Scheduling', userActivation: 'UserActivation', geolocation: 'Geolocation',
      clipboard: 'Clipboard', credentials: 'CredentialsContainer', serviceWorker: 'ServiceWorkerContainer',
      locks: 'LockManager', wakeLock: 'WakeLock', virtualKeyboard: 'VirtualKeyboard', devicePosture: 'DevicePosture',
      mediaSession: 'MediaSession', presentation: 'Presentation', bluetooth: 'Bluetooth', hid: 'HID',
      serial: 'Serial', usb: 'USB', xr: 'XRSystem', ink: 'Ink', login: 'NavigatorLogin', managed: 'NavigatorManagedData',
      storageBuckets: 'StorageBucketManager', protectedAudience: 'ProtectedAudience',
      windowControlsOverlay: 'WindowControlsOverlay', webkitTemporaryStorage: 'DeprecatedStorageQuota',
      webkitPersistentStorage: 'DeprecatedStorageQuota' };
    for (const [k, v] of Object.entries(objs)) {
      if (k in navProto) continue;
      if (brands[k]) brandObj(v, brands[k]);
      Object.defineProperty(navProto, k, { get: markNative(function () { return v; }, 'get ' + k), enumerable: true, configurable: true });
    }
    const fns = ['getGamepads', 'vibrate', 'canShare', 'share', 'clearAppBadge', 'setAppBadge', 'getUserMedia',
      'webkitGetUserMedia', 'requestMIDIAccess', 'requestMediaKeySystemAccess', 'sendBeacon',
      'registerProtocolHandler', 'unregisterProtocolHandler', 'getInstalledRelatedApps',
      'joinAdInterestGroup', 'leaveAdInterestGroup', 'updateAdInterestGroups', 'clearOriginJoinedAdInterestGroups',
      'runAdAuction', 'createAuctionNonce', 'adAuctionComponents', 'canLoadAdAuctionFencedFrame',
      'getInterestGroupAdAuctionData', 'deprecatedReplaceInURN', 'deprecatedURNToURL', 'deprecatedRunAdAuctionEnforcesKAnonymity'];
    for (const f of fns) {
      if (f in navProto) continue;
      const impl = f === 'getGamepads' ? () => [null, null, null, null] : f === 'vibrate' ? () => false
        : f === 'canShare' ? () => false : f === 'canLoadAdAuctionFencedFrame' ? () => false
        : f === 'deprecatedRunAdAuctionEnforcesKAnonymity' ? undefined
        : f === 'sendBeacon' ? () => true : () => Promise.reject(new Error('NotAllowedError'));
      if (impl === undefined) { Object.defineProperty(navProto, f, { value: false, enumerable: true, configurable: true }); continue; }
      Object.defineProperty(navProto, f, { value: markNative(impl, f), writable: true, enumerable: true, configurable: true });
    }
  }
  Object.defineProperty(navProto, Symbol.toStringTag, { value: 'Navigator', configurable: true });
  Object.defineProperty(navProto, 'constructor', { value: NavigatorCtor, writable: true, configurable: true });
  navProto.__NavigatorCtor = NavigatorCtor;

  const ScreenCtor = nativeCtor('Screen');
  const screenMock = Object.create(ScreenCtor.prototype);
  for (const [k, v] of Object.entries({ ...prof.screen, orientation: brandObj({ type: 'landscape-primary', angle: 0, onchange: null }, 'ScreenOrientation'), availLeft: 0, availTop: 0, isExtended: false })) {
    Object.defineProperty(ScreenCtor.prototype, k, { get: markNative(function () { return v; }, 'get ' + k), enumerable: true, configurable: true });
  }
  Object.defineProperty(ScreenCtor.prototype, Symbol.toStringTag, { value: 'Screen', configurable: true });

  let rafLast = 0;
  let navName = null;
  const navEntry = {
    entryType: 'navigation', type: 'navigate',

    nextHopProtocol: '', startTime: 0, duration: 130.5,
    redirectStart: 0, redirectEnd: 0,
    ...(() => {
      const fetchStart = 1.2 + Math.random() * 7;
      const domainLookupStart = fetchStart;
      const domainLookupEnd = fetchStart;
      const connectStart = fetchStart;
      const connectEnd = fetchStart;
      const secureConnectionStart = fetchStart;
      const requestStart = fetchStart;
      const ttfb = 590 + Math.random() * 130;
      const responseStart = requestStart + ttfb;
      return {
        fetchStart, domainLookupStart, domainLookupEnd,
        connectStart, secureConnectionStart, connectEnd, requestStart,
        firstInterimResponseStart: 0,
        responseStart,
        responseEnd: responseStart + 0.1 + Math.random() * 2.4,
      };
    })(),
    domInteractive: 0, domContentLoadedEventStart: 102.8, domContentLoadedEventEnd: 102.8, domComplete: 0,
    loadEventStart: 120.3, loadEventEnd: 120.3, transferSize: 1032, encodedBodySize: 974, decodedBodySize: 974,
    workerStart: 0, serverTiming: [], unloadEventStart: 0, unloadEventEnd: 0, redirectCount: 0,
    initiatorType: 'navigation',
    get name() { if (navName !== null) return navName; try { return String(sandbox.location.href); } catch (_) { return ''; } },
    set name(v) { navName = String(v); },
  };
  const resourceEntries = (() => {
    const base = 'https://static.captcha-delivery.com/captcha/assets/';
    const names = ['tpl/index.css', 'tpl/index.js', 'fonts/nyt-franklin.woff2', 'fonts/nyt-cheltenham.woff2',
      'img/logo.svg', 'img/slider-icon.svg', 'img/audio.svg', 'img/reload.svg', 'img/puzzle.svg',
      'img/check.svg', 'img/close.svg', 'img/spinner.svg', 'js/captcha.js', 'js/detection.js',
      'css/theme.css', 'img/bg.png', 'img/frag.png', 'img/target.svg', 'img/arrow.svg', 'img/help.svg',
      'i18n/en.json', 'img/pixel.png', 'img/tick.svg', 'img/warn.svg', 'css/slider.css', 'img/dot.svg',
      'img/grip.svg', 'js/audio.js', 'img/mask.png', 'css/rtl.css'];
    let t = 40;
    return names.map((n, i) => {
      const start = t; const dur = 8 + ((i * 7) % 55); t += 3 + ((i * 5) % 17);
      return { entryType: 'resource', name: base + n, startTime: start, duration: dur,
        initiatorType: /\.css$/.test(n) ? 'link' : /\.js$/.test(n) ? 'script' : /\.(png|svg|jpg)$/.test(n) ? 'img' : 'fetch',
        nextHopProtocol: 'h2', transferSize: 900 + i * 137, encodedBodySize: 700 + i * 121, decodedBodySize: 1500 + i * 260,
        responseStart: start + dur * 0.6, responseEnd: start + dur, fetchStart: start, domainLookupStart: start,
        domainLookupEnd: start, connectStart: start, connectEnd: start, requestStart: start + dur * 0.3,
        secureConnectionStart: start, redirectStart: 0, redirectEnd: 0, workerStart: 0, renderBlockingStatus: 'non-blocking' };
    });
  })();
  const performanceMock = {
    now: () => perfNow(),
    timeOrigin: nowMs,
    getEntriesByType: (t) => (t === 'navigation' ? [navEntry] : t === 'resource' ? resourceEntries : t === 'paint' ? [{ entryType: 'paint', name: 'first-paint', startTime: 90 }, { entryType: 'paint', name: 'first-contentful-paint', startTime: 95 }]
      : t === 'visibility-state' ? [{ entryType: 'visibility-state', name: 'visible', startTime: 0 }] : []),
    getEntriesByName: () => [], getEntries: () => [navEntry, ...resourceEntries], mark: () => {}, measure: () => {},
    navigation: brandObj({
      type: 0, redirectCount: 0,
      TYPE_NAVIGATE: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_RESERVED: 255,
    }, 'PerformanceNavigation'),
    timing: (function(){ var t = nowMs, o = { navigationStart: t, unloadEventStart: 0, unloadEventEnd: 0,
      redirectStart: 0, redirectEnd: 0, fetchStart: t + 2, domainLookupStart: t + 3, domainLookupEnd: t + 8,
      connectStart: t + 8, connectEnd: t + 30, secureConnectionStart: t + 15, requestStart: t + 31,
      responseStart: t + 88, responseEnd: t + 96, domLoading: t + 95, domInteractive: t + 260,
      domContentLoadedEventStart: t + 260, domContentLoadedEventEnd: t + 262, domComplete: t + 410,
      loadEventStart: 0, loadEventEnd: 0 }; return o; })(),

memory: (function () {
  const used = 3.4e6 + Math.random() * 1.4e6;
  const total = used + 3.0e6 + Math.random() * 1.2e6;
  return { usedJSHeapSize: Math.round(used), totalJSHeapSize: Math.round(total), jsHeapSizeLimit: 4395630592 };
})(),
  };

  const localStorageMock = (() => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
    _seed: (k, v) => m.set(k, v) }; })();
  if (ddm && ddm.hash) {
    const real = Date.now();
    const ets = [real - 30000, real - 4000000, real - 8000000, real - 15000000, real - 25000000];
    localStorageMock._seed('datadome_ets' + ddm.hash, JSON.stringify(ets));
  }

  const URLMock = { createObjectURL: () => 'blob:mock/' + (state.seq++), revokeObjectURL: () => {} };
  class BlobMock { constructor(parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; this.size = 0; } }
  class DOMParserMock { parseFromString(str) { return { documentElement: { textContent: str }, body: { textContent: str } }; } }
  const MediaSourceMock = Object.assign(function MediaSource() { return { addSourceBuffer: () => ({}), readyState: 'closed' }; }, { isTypeSupported });
  class AudioContextMock {
    constructor() { this.sampleRate = 48000; this.state = 'suspended'; this.baseLatency = 0.01; this.destination = { maxChannelCount: 2, channelCount: 2 }; this.currentTime = 0; }
    createOscillator() { return { frequency: { value: 440, setValueAtTime() {} }, type: 'sine', connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {} }; }
    createAnalyser() { return { frequencyBinCount: 1024, fftSize: 2048, getFloatFrequencyData() {}, connect() {} }; }
    createDynamicsCompressor() { return { threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 }, reduction: -20, attack: { value: 0.003 }, release: { value: 0.25 }, connect() {} }; }
    createScriptProcessor() { return { connect() {}, addEventListener() {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(0) }; }
    createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
    startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(0) }); }
    close() { return Promise.resolve(); } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); }
  }

  const sandboxConsole = {
    log: (...a) => emitLog('log', a),
    info: (...a) => emitLog('info', a),
    warn: (...a) => emitLog('warn', a),
    error: (...a) => emitLog('error', a),
    debug: (...a) => emitLog('debug', a),
    trace: (...a) => emitLog('trace', a),
    dir: (...a) => emitLog('dir', a),
    table: (...a) => emitLog('table', a),
    context() { return sandboxConsole; },
    createTask() { return { run(fn) { return typeof fn === 'function' ? fn() : undefined; } }; },
  };
  const emitLog = (level, args) => {
    let line;
    try {
      line = args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
    } catch {
      line = String(args);
    }
    if (line.length > 8000) line = line.slice(0, 8000) + '...';
    state.logs.push({ level, line });
    if (process.env.DD_VERBOSE) {
      const fn = console[level] || console.error;
      try { fn.apply(console, args); } catch { console.error(line); }
    }
  };

  const sandbox = {
    console: sandboxConsole, atob, btoa, TextEncoder, TextDecoder,
    setTimeout: (fn, delay) => state.enqueue(fn, delay, 'setTimeout'),
    clearTimeout: (id) => state.cancel(id), setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn) => state.enqueue(() => {
      const t = nowFn() - nowMs;
      rafLast = rafLast === 0 ? t : Math.max(t, rafLast + 1000 / 60);
      return fn(rafLast);
    }, 1000 / 60, 'raf'),
    cancelAnimationFrame: () => {}, requestIdleCallback: (fn) => state.enqueue(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0, 'ric'), cancelIdleCallback: () => {},
    queueMicrotask: (fn) => state.enqueue(fn, 0, 'microtask'),
    navigator: navigatorMock, screen: screenMock, performance: performanceMock, crypto: webcrypto,
    WebAssembly: sandboxWA,
    document: documentMock, location: { href: 'https://geo.ddc.paypal.com/interstitial/', origin: 'https://geo.ddc.paypal.com', protocol: 'https:', host: 'geo.ddc.paypal.com', hostname: 'geo.ddc.paypal.com', pathname: '/interstitial/', search: '', hash: '' },
    localStorage: localStorageMock, sessionStorage: localStorageMock,
    XMLHttpRequest: makeXHRClass(state), Worker: makeWorkerClass(state, fp), URL: URLMock, Blob: BlobMock, DOMParser: DOMParserMock,
    OffscreenCanvas: (() => {
      function OffscreenCanvas(w, h) {
        let cw = Number(w) || 0, ch = Number(h) || 0;
        Object.defineProperty(this, 'width', {
          configurable: true, enumerable: true,
          get() { return cw; },
          set(v) {
            cw = Number(v) || 0;
            this._skiaCanvas = null;
            this._ctx2d = null;
            if (process.env.DD_DUMP_T) {
              try {
                const g = globalThis.__DD_OCW || (globalThis.__DD_OCW = []);
                if (g.length < 40) g.push(cw);
              } catch (_) {}
            }
          },
        });
        Object.defineProperty(this, 'height', {
          configurable: true, enumerable: true,
          get() { return ch; },
          set(v) { ch = Number(v) || 0; },
        });
      }
      OffscreenCanvas.prototype.getContext = function (kind, attrs) {
        kind = String(kind || '');
        if (kind === '2d') return adoptFns(makeCanvasContext2D());
        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
          const gl = adoptFns(makeWebGLContext(ACTIVE_PROF, attrs, this));
          try { Object.defineProperty(gl, Symbol.toStringTag, { value: kind === 'webgl2' ? 'WebGL2RenderingContext' : 'WebGLRenderingContext', configurable: true }); } catch (_) {}
          return gl;
        }
        return null;
      };
      OffscreenCanvas.prototype.convertToBlob = function () { return Promise.resolve(new BlobMock()); };
      OffscreenCanvas.prototype.transferToImageBitmap = function () { return {}; };
      markNative(OffscreenCanvas, 'OffscreenCanvas');
      markNative(OffscreenCanvas.prototype.getContext, 'getContext');
      markNative(OffscreenCanvas.prototype.convertToBlob, 'convertToBlob');
      markNative(OffscreenCanvas.prototype.transferToImageBitmap, 'transferToImageBitmap');
      return OffscreenCanvas;
    })(),
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; this.bubbles = !!(init && init.bubbles); this.cancelable = !!(init && init.cancelable); this.defaultPrevented = false; this.timeStamp = 0; }
      initCustomEvent(type, bubbles, cancelable, detail) { this.type = type; this.bubbles = !!bubbles; this.cancelable = !!cancelable; this.detail = detail && detail.detail !== undefined ? detail.detail : detail; }
      preventDefault() { this.defaultPrevented = true; } stopPropagation() {} stopImmediatePropagation() {}
    },
    Event: class Event {
      constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); this.cancelable = !!(init && init.cancelable); this.defaultPrevented = false; this.timeStamp = 0; }
      preventDefault() { this.defaultPrevented = true; } stopPropagation() {} stopImmediatePropagation() {}
    },
    MediaSource: MediaSourceMock, AudioContext: AudioContextMock, webkitAudioContext: AudioContextMock,
    OfflineAudioContext: AudioContextMock, Audio: function Audio() { return makeElement('audio'); },
    XMLSerializer: (() => {
      function XMLSerializer() {}
      XMLSerializer.prototype.serializeToString = markNative(() => '<html></html>', 'serializeToString');
      return XMLSerializer;
    })(),
    XMLDocument: nativeCtor('XMLDocument'), Element: nativeCtor('Element'), HTMLElement: nativeCtor('HTMLElement'),
    Node: nativeCtor('Node'), SVGElement: nativeCtor('SVGElement'), HTMLIFrameElement: nativeCtor('HTMLIFrameElement'),
    Document: nativeCtor('Document'), Window: nativeCtor('Window'), EventTarget: nativeCtor('EventTarget'),
    CanvasRenderingContext2D: nativeCtor('CanvasRenderingContext2D'), HTMLCanvasElement: nativeCtor('HTMLCanvasElement'),
    Plugin: _PluginCtor, PluginArray: _PluginArrayCtor, MimeType: _MimeTypeCtor, MimeTypeArray: _MimeTypeArrayCtor,
    WebGLObject: nativeCtor('WebGLObject'), PressureObserver: nativeCtor('PressureObserver'),
    WebSocketStream: nativeCtor('WebSocketStream'), EyeDropper: nativeCtor('EyeDropper'),
    AudioData: nativeCtor('AudioData'), WritableStreamDefaultController: nativeCtor('WritableStreamDefaultController'),
    CSSCounterStyleRule: nativeCtor('CSSCounterStyleRule'), NavigatorUAData: nativeCtor('NavigatorUAData'),
    IdleDetector: nativeCtor('IdleDetector'),
    FontFaceSet: nativeCtor('FontFaceSet'),
    HTMLUserMediaElement: nativeCtor('HTMLUserMediaElement'),
    InteractionContentfulPaint: nativeCtor('InteractionContentfulPaint'),
    PerformanceSoftNavigation: nativeCtor('PerformanceSoftNavigation'),
    PermissionStatus: (() => { const c = nativeCtor('PermissionStatus'); Object.defineProperty(c.prototype, 'name', { get() { return ''; }, enumerable: true, configurable: true }); return c; })(),
    HTMLVideoElement: (() => { const c = nativeCtor('HTMLVideoElement'); c.prototype.getVideoPlaybackQuality = markNative(function getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0, creationTime: 0 }; }, 'getVideoPlaybackQuality'); return c; })(),
    Summarizer: (() => {
      const c = nativeCtor('Summarizer');
      let cached = null;
      c.availability = markNative(function availability() {
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve) => state.enqueue(() => {
          perfClock += 120 + Math.random() * 215;
          cached = 'unavailable';
          resolve(cached);
        }, ASYNC_LATENCY.aiAvailability, 'ai-availability'));
      }, 'availability');
      return c;
    })(),
    devicePixelRatio: prof.devicePixelRatio,
    VisualViewport: VisualViewportCtor,
    visualViewport: makeVisualViewport(prof),
    screenX: 0, screenY: 0, screenLeft: 0, screenTop: 0,
    length: 0,
    frameElement: null,
    innerWidth: (embedded ? (prof.embeddedInnerWidth ?? 550) : prof.innerWidth) ?? 958,
    innerHeight: prof.innerHeight ?? 937,
    outerWidth: prof.outerWidth ?? 974, outerHeight: prof.outerHeight ?? 1032,
    scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    matchMedia: (qs) => matchMediaFor(qs, prof),
    getComputedStyle: (el) => makeComputedStyle(el),
    chrome: { loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false, InstallState: {}, RunningState: {} } },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    postMessage(msg) {
      if (msg && typeof msg === 'object') {
        const iface = msg[Symbol.toStringTag] || (msg.constructor && msg.constructor.name);
        if (iface && iface !== 'Object' && iface !== 'Array') {
          const e = new Error("Failed to execute 'postMessage' on 'Window': " + iface + ' object could not be cloned.');
          e.name = 'DataCloneError';
          throw e;
        }
      }
    },
    CSS: { supports: markNative(function supports(prop, value) {
      const p = String(prop == null ? '' : prop).toLowerCase();
      if (p.indexOf(':') > -1 || arguments.length < 2) {
        if (/-moz-|-webkit-osx|osx-font-smoothing/.test(p)) return false;
      }
      if (/-moz-|osx-font-smoothing/.test(p)) return false;
      return false;
    }, 'supports'), escape: markNative(function escape(s) { return String(s); }, 'escape') },
    speechSynthesis: {
      getVoices: () => [
        { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true, default: true, voiceURI: 'Microsoft David - English (United States)' },
        { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true, default: false, voiceURI: 'Microsoft Zira - English (United States)' },
        { name: 'Microsoft Mark - English (United States)', lang: 'en-US', localService: true, default: false, voiceURI: 'Microsoft Mark - English (United States)' },
        { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB', localService: true, default: false, voiceURI: 'Microsoft Hazel - English (United Kingdom)' },
      ],
      speak() {}, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {}, pending: false, speaking: false, paused: false, onvoiceschanged: null,
    },
    ddm,
  };
  sandbox.Navigator = navigatorMock.__NavigatorCtor;
  delete Object.getPrototypeOf(navigatorMock).__NavigatorCtor;
  sandbox.Screen = Object.getPrototypeOf(screenMock).constructor;
  sandbox.Event = EVENT_CTORS.Event; sandbox.UIEvent = EVENT_CTORS.UIEvent;
  sandbox.MouseEvent = EVENT_CTORS.MouseEvent; sandbox.PointerEvent = EVENT_CTORS.PointerEvent;
  sandbox.EventTarget = DOM_CTORS.EventTarget; sandbox.Node = DOM_CTORS.Node;
  sandbox.Element = DOM_CTORS.Element; sandbox.HTMLElement = DOM_CTORS.HTMLElement;
  sandbox.HTMLUnknownElement = DOM_CTORS.HTMLUnknownElement;
  sandbox.HTMLMediaElement = DOM_CTORS.HTMLMediaElement;
  for (const [tag, iface] of Object.entries(DOM_CTORS.TAGMAP)) {
    if (iface === 'HTMLElement') continue;
    if (DOM_CTORS.byTag[tag]) sandbox[iface] = DOM_CTORS.byTag[tag];
  }
  const COOKIE_JAR = new Map();
  Object.defineProperty(documentMock, 'cookie', {
    get() { return Array.from(COOKIE_JAR, ([k, v]) => k + '=' + v).join('; '); },
    set(v) {
      if (embedded) return;
      const s = String(v);
      const semi = s.indexOf(';');
      const pair = (semi === -1 ? s : s.slice(0, semi)).trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) return;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      const attrs = semi === -1 ? '' : s.slice(semi + 1);
      const exp = /expires\s*=\s*([^;]+)/i.exec(attrs);
      const age = /max-age\s*=\s*(-?\d+)/i.exec(attrs);
      if ((exp && Date.parse(exp[1]) <= nowMs) || (age && Number(age[1]) <= 0)) { COOKIE_JAR.delete(name); return; }
      COOKIE_JAR.set(name, val);
    },
    enumerable: true, configurable: true,
  });

  markNative(documentMock.createElement, 'createElement');
  markNative(documentMock.createElementNS, 'createElementNS');
  for (const o of [sandbox, documentMock]) {
    markNative(o.addEventListener, 'addEventListener');
    markNative(o.removeEventListener, 'removeEventListener');
    markNative(o.dispatchEvent, 'dispatchEvent');
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.webkitRequestAnimationFrame = sandbox.requestAnimationFrame;
  sandbox.webkitCancelAnimationFrame = sandbox.cancelAnimationFrame;
  for (const k of ['Atomics', 'WeakRef', 'WeakSet', 'FinalizationRegistry', 'SharedArrayBuffer', 'Proxy', 'Reflect', 'AbortController', 'AbortSignal', 'structuredClone']) {
    try { if (typeof globalThis[k] !== 'undefined' && sandbox[k] == null) sandbox[k] = globalThis[k]; } catch (_) {}
  }
  sandbox.Date = DateMock;
  {
    const dprVal = Number(prof.devicePixelRatio) || 1;
    Object.defineProperty(sandbox, 'devicePixelRatio', {
      configurable: true, enumerable: true,
      get() {
        if (process.env.DD_DUMP_T) {
          try {
            const g = globalThis.__DD_DPR || (globalThis.__DD_DPR = []);
            if (g.length < 80) g.push('main');
          } catch (_) {}
        }
        return dprVal;
      },
    });
  }
  sandbox.frames = sandbox;
  if (!Object.prototype.hasOwnProperty.call(sandbox, '0')) {
    try {
      Object.defineProperty(sandbox, '0', {
        value: makeChildWindow(prof), writable: false, enumerable: true, configurable: false,
      });
    } catch (_) {}
  }

  installEvents(sandbox);
  ACTIVE_WINDOW = sandbox;

  if (typeof sandbox.createImageBitmap !== 'function') {
    sandbox.createImageBitmap = markNative(function createImageBitmap(src, sx, sy, sw, sh) {
      const w = (typeof sw === 'number' ? sw : (src && (src.width || src.videoWidth)) || 1);
      const h = (typeof sh === 'number' ? sh : (src && (src.height || src.videoHeight)) || 1);
      const bmp = { width: w, height: h, close: markNative(function close() {}, 'close') };
      try { Object.defineProperty(bmp, Symbol.toStringTag, { value: 'ImageBitmap', configurable: true }); } catch (_) {}
      return Promise.resolve(bmp);
    }, 'createImageBitmap');
    sandbox.ImageBitmap = nativeCtor('ImageBitmap');
  }
  if (typeof sandbox.PerformanceObserver !== 'function' || !sandbox.PerformanceObserver.supportedEntryTypes) {
    function PerformanceObserver(cb) { this._cb = cb; }
    PerformanceObserver.prototype.observe = markNative(function observe() {}, 'observe');
    PerformanceObserver.prototype.disconnect = markNative(function disconnect() {}, 'disconnect');
    PerformanceObserver.prototype.takeRecords = markNative(function takeRecords() { return []; }, 'takeRecords');
    Object.defineProperty(PerformanceObserver.prototype, Symbol.toStringTag, { value: 'PerformanceObserver', configurable: true });
    PerformanceObserver.supportedEntryTypes = ['element', 'event', 'first-input', 'interaction-contentful-paint',
      'largest-contentful-paint', 'layout-shift', 'long-animation-frame', 'longtask', 'mark', 'measure',
      'navigation', 'paint', 'resource', 'soft-navigation', 'visibility-state'];
    markNative(PerformanceObserver, 'PerformanceObserver');
    sandbox.PerformanceObserver = PerformanceObserver;
  }
  for (const [name, extra] of [['MutationObserver', null], ['ResizeObserver', null],
    ['IntersectionObserver', { root: null, rootMargin: '0px 0px 0px 0px', thresholds: [0] }]]) {
    const proto = sandbox[name] && sandbox[name].prototype;
    if (typeof sandbox[name] === 'function' && proto && typeof proto.observe === 'function') continue;
    const Ctor = function (cb) { this._cb = cb; if (extra) Object.assign(this, extra); };
    try { Object.defineProperty(Ctor, 'name', { value: name, configurable: true }); } catch (_) {}
    Ctor.prototype.observe = markNative(function observe() {}, 'observe');
    Ctor.prototype.unobserve = markNative(function unobserve() {}, 'unobserve');
    Ctor.prototype.disconnect = markNative(function disconnect() {}, 'disconnect');
    if (name === 'MutationObserver') Ctor.prototype.takeRecords = markNative(function takeRecords() { return []; }, 'takeRecords');
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', { value: Ctor, writable: true, configurable: true });
    markNative(Ctor, name);
    sandbox[name] = Ctor;
  }
  if (typeof sandbox.MessageChannel !== 'function') {
    function MessagePort() { this.onmessage = null; this.onmessageerror = null; }
    MessagePort.prototype.postMessage = markNative(function postMessage() {}, 'postMessage');
    MessagePort.prototype.start = markNative(function start() {}, 'start');
    MessagePort.prototype.close = markNative(function close() {}, 'close');
    MessagePort.prototype.addEventListener = markNative(function addEventListener() {}, 'addEventListener');
    MessagePort.prototype.removeEventListener = markNative(function removeEventListener() {}, 'removeEventListener');
    Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, { value: 'MessagePort', configurable: true });
    function MessageChannel() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); }
    Object.defineProperty(MessageChannel.prototype, Symbol.toStringTag, { value: 'MessageChannel', configurable: true });
    sandbox.MessageChannel = markNative(MessageChannel, 'MessageChannel');
    sandbox.MessagePort = markNative(MessagePort, 'MessagePort');
  }
  if (typeof sandbox.BroadcastChannel !== 'function') {
    function BroadcastChannel(name) { this.name = String(name); this.onmessage = null; this.onmessageerror = null; }
    BroadcastChannel.prototype.postMessage = markNative(function postMessage() {}, 'postMessage');
    BroadcastChannel.prototype.close = markNative(function close() {}, 'close');
    BroadcastChannel.prototype.addEventListener = markNative(function addEventListener() {}, 'addEventListener');
    BroadcastChannel.prototype.removeEventListener = markNative(function removeEventListener() {}, 'removeEventListener');
    Object.defineProperty(BroadcastChannel.prototype, Symbol.toStringTag, { value: 'BroadcastChannel', configurable: true });
    sandbox.BroadcastChannel = markNative(BroadcastChannel, 'BroadcastChannel');
  }

  {
    const g = globalThis;
    const need = {
      fetch: g.fetch, Response: g.Response, Request: g.Request, Headers: g.Headers, FormData: g.FormData,
      File: g.File, AbortController: g.AbortController, AbortSignal: g.AbortSignal, DOMException: g.DOMException,
      URLSearchParams: g.URLSearchParams, structuredClone: g.structuredClone, WebSocket: g.WebSocket,
      ReadableStream: g.ReadableStream, WritableStream: g.WritableStream, TransformStream: g.TransformStream,
      TextEncoderStream: g.TextEncoderStream, TextDecoderStream: g.TextDecoderStream,
      CompressionStream: g.CompressionStream, DecompressionStream: g.DecompressionStream,
      ByteLengthQueuingStrategy: g.ByteLengthQueuingStrategy, CountQueuingStrategy: g.CountQueuingStrategy,
      ReadableStreamDefaultReader: g.ReadableStreamDefaultReader,
      ReadableStreamDefaultController: g.ReadableStreamDefaultController,
      ReadableStreamBYOBReader: g.ReadableStreamBYOBReader, ReadableStreamBYOBRequest: g.ReadableStreamBYOBRequest,
      ReadableByteStreamController: g.ReadableByteStreamController,
      WritableStreamDefaultWriter: g.WritableStreamDefaultWriter,
      TransformStreamDefaultController: g.TransformStreamDefaultController,
      MessageEvent: g.MessageEvent, CloseEvent: g.CloseEvent, Crypto: g.Crypto, SubtleCrypto: g.SubtleCrypto,
      CryptoKey: g.CryptoKey, Performance: g.Performance, URLPattern: g.URLPattern,
    };
    for (const [k, v] of Object.entries(need)) if (!(k in sandbox)) sandbox[k] = v || nativeCtor(k);
    const RealFetch = sandbox.fetch;
    const RealResponse = sandbox.Response;
    if (typeof RealFetch === 'function' && typeof RealResponse === 'function') {
      sandbox.fetch = markNative(function fetch(input, init) {
        const raw = String((input && typeof input === 'object' && input.url) || input || '');
        if (!/^https?:\/\//i.test(raw)) {
          return Promise.resolve(new RealResponse('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return RealFetch.call(this, input, init);
      }, 'fetch');
    }
    for (const k of ['PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure',
      'PerformanceResourceTiming', 'PerformanceObserverEntryList', 'PerformanceNavigationTiming',
      'PerformancePaintTiming', 'PerformanceServerTiming', 'PerformanceLongTaskTiming',
      'PerformanceNavigation']) {
      if (k in sandbox) continue;
      if (k === 'PerformanceNavigation') {
        const C = nativeCtor('PerformanceNavigation');
        C.TYPE_NAVIGATE = 0; C.TYPE_RELOAD = 1; C.TYPE_BACK_FORWARD = 2; C.TYPE_RESERVED = 255;
        C.prototype.TYPE_NAVIGATE = 0; C.prototype.TYPE_RELOAD = 1;
        C.prototype.TYPE_BACK_FORWARD = 2; C.prototype.TYPE_RESERVED = 255;
        sandbox[k] = C;
      } else {
        sandbox[k] = nativeCtor(k);
      }
    }
  }

  if (typeof sandbox.isSecureContext === 'undefined') sandbox.isSecureContext = true;
  if (typeof sandbox.crossOriginIsolated === 'undefined') sandbox.crossOriginIsolated = false;
  if (typeof sandbox.originAgentCluster === 'undefined') sandbox.originAgentCluster = false;
  if (typeof sandbox.isSecureContext !== 'boolean') sandbox.isSecureContext = true;

  const brand = (obj, tag) => { try { Object.defineProperty(obj, Symbol.toStringTag, { value: tag, configurable: true }); } catch (_) {} };
  const ctorOf = (obj, name) => { try { Object.defineProperty(obj, 'constructor', { value: nativeCtor(name), writable: true, configurable: true }); } catch (_) {} };
  brand(sandbox, 'Window');
  brand(documentMock, 'HTMLDocument');
  brand(performanceMock, 'Performance');
  brand(localStorageMock, 'Storage');
  brand(sandbox.location, 'Location');
  if (!sandbox.history) {
    sandbox.history = { length: 1, scrollRestoration: 'auto', state: null,
      back: markNative(() => {}, 'back'), forward: markNative(() => {}, 'forward'),
      go: markNative(() => {}, 'go'), pushState: markNative(() => {}, 'pushState'),
      replaceState: markNative(() => {}, 'replaceState') };
  }
  brand(sandbox.history, 'History');
  ctorOf(sandbox.history, 'History');
  if (!sandbox.Notification || typeof sandbox.Notification.permission === 'undefined') {
    const N = nativeCtor('Notification');
    Object.defineProperty(N, 'permission', { get: markNative(function permission() { return 'default'; }, 'get permission'), configurable: true });
    N.requestPermission = markNative(() => Promise.resolve('default'), 'requestPermission');
    N.maxActions = 2;
    sandbox.Notification = N;
  }
  if (!sandbox.indexedDB || typeof sandbox.indexedDB.open !== 'function') {
    sandbox.indexedDB = {
      open: markNative(function open() { return { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, readyState: 'pending' }; }, 'open'),
      deleteDatabase: markNative(function deleteDatabase() { return { onsuccess: null, onerror: null }; }, 'deleteDatabase'),
      databases: markNative(() => Promise.resolve([]), 'databases'),
      cmp: markNative((a, b) => (a < b ? -1 : a > b ? 1 : 0), 'cmp'),
    };
    brand(sandbox.indexedDB, 'IDBFactory');
  }

  const protoGetter = (ctorName, prop, value) => {
    const C = sandbox[ctorName];
    if (!C || !C.prototype || prop in C.prototype) return;
    try {
      Object.defineProperty(C.prototype, prop, {
        get: markNative(function () { return value; }, 'get ' + prop), enumerable: true, configurable: true,
      });
    } catch (_) {}
  };
  const protoMethod = (ctorName, prop, impl) => {
    const C = sandbox[ctorName];
    if (!C || !C.prototype || prop in C.prototype) return;
    try {
      Object.defineProperty(C.prototype, prop, {
        value: markNative(impl, prop), writable: true, enumerable: true, configurable: true,
      });
    } catch (_) {}
  };

  ctorOf(documentMock, 'HTMLDocument');
  ctorOf(performanceMock, 'Performance');
  ctorOf(performanceMock.navigation, 'PerformanceNavigation');
  ctorOf(localStorageMock, 'Storage');

  if (Array.isArray(REAL_GLOBALS) && REAL_GLOBALS.length) {
    for (const name of REAL_GLOBALS) {
      if (typeof name !== 'string' || !name || Object.prototype.hasOwnProperty.call(sandbox, name)) continue;
      if (name in globalThis) continue;
      try {
        Object.defineProperty(sandbox, name, {
          value: /^[A-Z]/.test(name) ? nativeCtor(name) : undefined,
          writable: true, enumerable: true, configurable: true,
        });
      } catch (_) {}
    }
  }

  protoGetter('Notification', 'image', '');
  protoGetter('PerformanceResourceTiming', 'renderBlockingStatus', 'non-blocking');
  protoMethod('XMLDocument', 'hasStorageAccess', function hasStorageAccess() { return Promise.resolve(false); });
  protoMethod('RTCRtpTransceiver', 'stop', function stop() {});

  sandbox[Symbol.for('dd.dq')] = () => {
    if (!state.timers.length) return undefined;
    let mi = 0;
    for (let i = 1; i < state.timers.length; i++) {
      const a = state.timers[i], b = state.timers[mi];
      if (a.due < b.due || (a.due === b.due && a.at < b.at)) mi = i;
    }
    const t = state.timers.splice(mi, 1)[0];
    if (t.due > state.vnow) state.vnow = t.due;
    return t.fn;
  };

  for (const [obj, iface] of [[documentMock, 'HTMLDocument'], [performanceMock, 'Performance']]) {
    const proto = Object.create(Object.getPrototypeOf(obj) || Object.prototype);
    for (const p of Object.keys(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, p);
      if (!d || !d.configurable) continue;
      delete obj[p];
      if (typeof d.value === 'function') Object.defineProperty(proto, p, { value: markNative(d.value, p), writable: true, enumerable: true, configurable: true });
      else if (d.get) Object.defineProperty(proto, p, d);
      else { const v = d.value; Object.defineProperty(proto, p, { get: markNative(function () { return v; }, 'get ' + p), set: function (nv) { Object.defineProperty(obj, p, { value: nv, writable: true, enumerable: true, configurable: true }); }, enumerable: true, configurable: true }); }
    }
    Object.defineProperty(proto, Symbol.toStringTag, { value: iface, configurable: true });
    Object.defineProperty(proto, 'constructor', { value: nativeCtor(iface), writable: true, configurable: true });
    Object.setPrototypeOf(obj, proto);
  }
  for (const o of [sandbox, documentMock, documentMock.body, documentMock.documentElement]) {
    if (!o) continue;
    if (typeof o.addEventListener === 'function') markNative(o.addEventListener, 'addEventListener');
    if (typeof o.removeEventListener === 'function') markNative(o.removeEventListener, 'removeEventListener');
    if (typeof o.dispatchEvent === 'function') markNative(o.dispatchEvent, 'dispatchEvent');
  }

  for (const name of loadWindowGlobals()) {
    if (typeof name !== 'string' || !name || name in sandbox) continue;
    if (name in globalThis) continue;
    try {
      Object.defineProperty(sandbox, name, {
        value: /^[A-Z]/.test(name) ? nativeCtor(name) : undefined,
        writable: true, enumerable: false, configurable: true,
      });
    } catch (_) {}
  }

  for (const [ctor, members] of Object.entries({
    RTCRtpTransceiver: ['stop', 'direction', 'sender', 'receiver', 'mid', 'currentDirection'],
    RTCPeerConnection: ['addTransceiver', 'getTransceivers', 'restartIce'],
    VisualViewport: ['onresize', 'onscroll'],
  })) {
    const C = sandbox[ctor];
    if (typeof C !== 'function' || !C.prototype) continue;
    for (const m of members) {
      if (m in C.prototype) continue;
      try { Object.defineProperty(C.prototype, m, { value: markNative(function () {}, m), writable: true, enumerable: false, configurable: true }); } catch (_) {}
    }
  }

  return { sandbox, state, fp };
}

export async function drainTimersVM(state, ctx, filename, maxSteps = 200000) {
  const driver =
    '(async function __dd_drain(){' +
    'var t,n=0;' +
    'while(n++<' + maxSteps + '){' +
    't=globalThis[Symbol.for("dd.dq")]();' +
    'if(!t)break;' +
    'var r;var p=new Promise(function(res){r=res;});' +
    'Promise.resolve().then(t).then(r,r);' +
    'await p;' +
    'if(n%48===0){await new Promise(function(res){globalThis[Symbol.for("dd.my")](res);});}' +
    '}return n;})()';
  ctx[Symbol.for('dd.my')] = (res) => setImmediate(res);
  const p = vm.runInContext(driver, ctx, { filename, timeout: 30000 });
  return await p;
}
