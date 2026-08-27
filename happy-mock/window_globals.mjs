import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ZA = (s) => { let g = 0; for (let i = 0; i < s.length; i++) g = ((g << 5) - g + s.charCodeAt(i)) | 0; return (g + 2147483647 + 1) >>> 0; };

const FALLBACK = ['window', 'self', 'document', 'name', 'location', 'customElements', 'history', 'navigation',
  'locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar', 'status', 'closed', 'frames',
  'length', 'top', 'opener', 'parent', 'frameElement', 'navigator', 'origin', 'external', 'screen', 'innerWidth',
  'innerHeight', 'scrollX', 'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport', 'screenX', 'screenY',
  'outerWidth', 'outerHeight', 'devicePixelRatio', 'clientInformation', 'screenLeft', 'screenTop', 'styleMedia',
  'isSecureContext', 'trustedTypes', 'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage',
  'Math', 'JSON', 'Reflect', 'globalThis'];

let _cached = null;
export function loadWindowGlobals() {
  if (_cached) return _cached;
  const p = join(__dirname, '..', 'data', 'window_globals.json');
  if (existsSync(p)) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      const list = Array.isArray(d) ? d : (d.iframeGlobals || d.iframeGlobalNames);
      if (Array.isArray(list) && list.length > 100) { _cached = list; return list; }
    } catch (_) {}
  }
  _cached = FALLBACK;
  return FALLBACK;
}

export function withEnumeratedGlobals(backing, globals) {
  const nameSet = new Set(globals);
  return new Proxy(Object.create(null), {
    get(_, k) { if (typeof k === 'symbol') return backing[k]; return backing[k]; },
    set(_, k, v) { backing[k] = v; return true; },
    has(_, k) { return nameSet.has(k) || k in backing; },
    ownKeys() { return globals.slice(); },
    getOwnPropertyDescriptor(_, k) {
      if (typeof k === 'symbol') return undefined;
      if (nameSet.has(k)) return { value: backing[k], writable: true, enumerable: false, configurable: true };
      return undefined;
    },
  });
}
