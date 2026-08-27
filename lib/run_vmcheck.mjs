const __log = process.env.DD_VERBOSE === '1'
  ? (m) => __log(m)
  : () => {};

import vm from 'node:vm';
import v8 from 'node:v8';
v8.setFlagsFromString('--no-async-stack-traces');
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function resolveHappyMock() {
  const candidates = [
    process.env.HAPPY_MOCK,
    join(__dirname, '../happy-mock/index.mjs'),
  ].filter(Boolean).map((p) => (p.endsWith('.mjs') ? p : join(p, 'index.mjs')));

  for (const p of candidates) if (existsSync(p)) return pathToFileURL(resolve(p)).href;

  throw new Error('happy-mock/index.mjs is missing from this checkout. It ships with the repo — '
    + 're-clone, or set HAPPY_MOCK=<path to happy-mock>.\nLooked in:\n  ' + candidates.join('\n  '));
}

const { makeSandbox, drainTimersVM, CHROME151_WIN10, adoptRealm, setVmScriptHash } = await import(resolveHappyMock());

export const CAPTCHA_PROF = {
  ...CHROME151_WIN10,

  innerWidth: 1556, innerHeight: 944,
  outerWidth: 1572, outerHeight: 1039,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1032, colorDepth: 24, pixelDepth: 24 },
};

const CAPTCHA_PAGE_FONTS = ['Roboto', 'Roboto-Bold'];
const SITE_FONTS = {
  'nytimes.com': null,
  'seatgeek.com': ['Roboto', 'Roboto-Bold', 'Roobert', 'RoobertBold'],
};
export function webFontsFor(refererOrUrl) {
  if (process.env.WEB_FONTS) return process.env.WEB_FONTS.split(',').map((s) => s.trim()).filter(Boolean);
  const h = String(refererOrUrl || '');
  for (const [host, list] of Object.entries(SITE_FONTS)) {
    if (h.includes(host)) return list || NYT_WEB_FONTS;
  }
  return CAPTCHA_PAGE_FONTS;
}

const NYT_WEB_FONTS = ['nyt-cheltenham', 'nyt-cheltenham-cond', 'nyt-cheltenham-scaps', 'nyt-cheltenham-small',
  'nyt-cheltenham-wide', 'nyt-cheltenham-xcond', 'nyt-fact', 'nyt-fact-deck', 'nyt-fact-deck-condensed',
  'nyt-fact-display', 'nyt-fact-display-condensed', 'nyt-franklin', 'nyt-franklin-cword', 'nyt-franklin-small',
  'nyt-franklin-tv', 'nyt-graphik', 'nyt-graphik-cond', 'nyt-graphik-xcond', 'nyt-imperial', 'nyt-karnak',
  'nyt-karnak-cond', 'nyt-karnak-small', 'nyt-kippenberger', 'nyt-kippenberger-condensed', 'nyt-kippenberger-poster',
  'nyt-magsans', 'nyt-magserif', 'nyt-magslab', 'nyt-schnyder-s', 'nyt-schnyder-scond', 'nyt-stymie', 'nyt-stymie-small'];

export function parseDdmFromHtml(html) {
  const ddmMatch = html.search(/(?:window\.)?ddm\s*=\s*\{/);
  if (ddmMatch < 0) throw new Error('no ddm in HTML');
  const open = html.indexOf('{', ddmMatch);
  let d = 0, i = open, s = false, q = '';
  for (; i < html.length; i++) {
    const c = html[i];
    if (s) { if (c === '\\') { i++; continue; } if (c === q) s = false; }
    else if (c === '"' || c === "'") { s = true; q = c; }
    else if (c === '{') d++;
    else if (c === '}') { d--; if (!d) { i++; break; } }
  }
  const ddm = vm.runInNewContext('(' + html.slice(open, i) + ')', Object.create(null));
  ddm.noPuzzle ??= true;
  ddm.sdkMsgFormat ??= '';
  ddm.s ??= '40009';
  for (const key of ['referer', 'url', 'captchaUrl']) {
    const m = html.match(new RegExp('ddm\\.' + key + "\\s*=\\s*htmlDecode\\(\\s*'([^']*)'"));
    if (m) ddm[key] = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return ddm;
}

export function dmFromChallenge(html, captchaUrl) {
  const fromHtml = String(html || '').match(/getRequest\s*\+=\s*'&dm='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (fromHtml) return fromHtml[1];
  try {
    if (captchaUrl) {
      const d = new URL(captchaUrl, 'https://geo.captcha-delivery.com').searchParams.get('dm');
      if (d) return d;
    }
  } catch (_) {}
  const fromAny = String(html || '').match(/[?&]dm=([^&"'#]+)/);
  if (fromAny) {
    try { return decodeURIComponent(fromAny[1]); } catch (_) { return fromAny[1]; }
  }

  return process.env.DD_DM || 'cd';
}

export function extractChallengeParams(html) {
  const params = {};
  let m = html.match(/getRequest\s*\+=\s*'&icid='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.icid = m[1];
  m = html.match(/getRequest\s*\+=\s*'&ccid='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.ccid = m[1];
  m = html.match(/getRequest\s*\+=\s*'&dm='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.dm = m[1];
  m = html.match(/ddCaptchaChallenge='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.ddCaptchaChallenge = m[1];
  m = html.match(/ddCaptchaEnv='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.ddCaptchaEnv = m[1];
  m = html.match(/ddCaptchaAudioChallenge='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.ddCaptchaAudioChallenge = m[1];
  m = html.match(/x-forwarded-for='\s*\+\s*encodeURIComponent\(\s*'([^']*)'/);
  if (m) params.xForwardedFor = m[1];
  return params;
}

export function extractBundle(html) {
  const lines = html.split('\n');
  const idx = lines.findIndex(l => l.length > 5000 && /^!function\s/.test(l.trim()));
  if (idx < 0) throw new Error('browserify bundle not found in HTML');
  return { bundle: lines[idx], lineNo: idx + 1 };
}

const LN5KPS_DELAY = Number(process.env.DD_LN5DELAY || 500);
export function extractCallerSrc(html) {
  const i = String(html || '').indexOf('function(A,w,D,C){var N=c[P(3)]');
  if (i < 0) return '';
  return html.slice(i, i + 150);
}
export function patchCallerTrap(html, meta = null) {
  let out = html;
  const applied = [];
  const suppress = [
    ['}else n=!0}catch(A){A', '}else{}}catch(A){A'],
    ['}else g=!0}catch(A){A',
      '}else{if(globalThis.__DD_CALLER_SRC__)w("0azB8G",p(String(globalThis.__DD_CALLER_SRC__).substring(0,150)))}}catch(A){A'],
  ];
  for (const [from, to] of suppress) if (out.includes(from)) { out = out.replace(from, to); applied.push('suppress:' + from.slice(0, 24)); }
  if (process.env.DD_HASH_TRACE === '1') {
    const mfrom = 'Q.exports=function(A,Q)';
    const mto = 'Q.exports=function(){var __r=__MMORIG.apply(this,arguments);'
      + 'try{(globalThis.__MM=globalThis.__MM||[]).push({seed:arguments[1]|0,'
      + 'len:String(arguments[0]).length,digest:__r,pre:String(arguments[0])})}catch(_){}'
      + 'return __r};var __MMORIG=function(A,Q)';
    if (out.split(mfrom).length - 1 === 1) { out = out.replace(mfrom, mto); applied.push('hash-trace'); }
  }
  if (process.env.DD_DUMP_LB === '1') {
    const f = 'function LB(A,Q){Q=Number(Q)>>>0,';
    const t = 'function LB(A,Q){try{(globalThis.__LB=globalThis.__LB||[]).push([String(A).slice(0,20),Q])}catch(_){}Q=Number(Q)>>>0,';
    if (out.includes(f)) { out = out.replace(f, t); applied.push('lb-trace'); }
  }
  if (process.env.DD_DUMP_TABLES === '1') {
    const pairs = [
      ['function g(A,Q){return Q=I[A],atob(Q)}',
        'function g(A,Q){try{globalThis.__TBL_I=I}catch(_){}return Q=I[A],atob(Q)}'],
      ['function C(A){var Q=e[A];',
        'function C(A){try{globalThis.__TBL_E=e}catch(_){}var Q=e[A];'],
    ];
    for (const [f, t] of pairs) if (out.includes(f)) { out = out.replace(f, t); applied.push('tbl'); }
  }
  if (process.env.DD_DUMP_T === '1') {
    const from = 'function P(A){var w=t[A];return';
    const to = 'function P(A){var w=t[A];try{globalThis.__DD_T=t;globalThis.__DD_TT=T;globalThis.__DD_P=P;}catch(e){}return';
    if (out.includes(from)) { out = out.replace(from, to); applied.push('dump-t'); }
  }
  const emit = [
    ['n||c("ln5KPS",l(i.substring(i.length-150)))',
      'n||function(v){setTimeout(function(){c("ln5KPS",v)},' + LN5KPS_DELAY + ')}(l(i.substring(i.length-150)))'],
    ['g||w("tgGNzP",p(P.substring(P.length-150)))',
      'g||function(v){setTimeout(function(){w("tgGNzP",v)},' + LN5KPS_DELAY + ')}(p(P.substring(P.length-150)))'],
  ];
  for (const [from, to] of emit) if (out.includes(from)) { out = out.replace(from, to); applied.push('delay:' + from.slice(0, 28)); }
  if (meta) meta.trap = applied;
  return out;
}

export function rewriteXorOpcodeSrc(src) {
  if (typeof src !== 'string' || src.length >= 800 || src.indexOf('^') === -1) return src;
  const fns = globalThis.__FN || (globalThis.__FN = []);
  if (fns.length < 48) fns.push(src.length + ':' + src.slice(0, 220));
  const log = (a, b, tag) =>
    '(function(){var A=' + a + ',B=' + b + ',R=A^B;var L=globalThis.__XOR||(globalThis.__XOR=[]);if(L.length<500000)L.push([A,B,R,"' + tag + '"]);return R;})()';
  src = src.replace(/(\w+)\[(\d+)\]\[(\w+)-1\]\^=\1\[\2\]\[\3\]/g, (_, o, stk, s) =>
    o + '[' + stk + '][' + s + '-1]=' + log(o + '[' + stk + '][' + s + '-1]', o + '[' + stk + '][' + s + ']', 'stk'));
  src = src.replace(/(\w+)\[(\d+)\]\[(\w+)-1\]\^=(\w+)/g, (_, o, stk, t, imm) =>
    o + '[' + stk + '][' + t + '-1]=' + log(o + '[' + stk + '][' + t + '-1]', imm, 'imm'));
  src = src.replace(/(\w+)\[(\d+)\]\[(\w+)-1\]=\1\[\2\]\[\3-1\]\^\1\[\2\]\[\3\]/g, (_, o, stk, s) =>
    o + '[' + stk + '][' + s + '-1]=' + log(o + '[' + stk + '][' + s + '-1]', o + '[' + stk + '][' + s + ']', 'asg'));
  src = src.replace(/(\w+)\[(\d+)\]\[(\w+)-1\]=\1\[\2\]\[\3-1\]\^\1\[\2\]\[((?:[^[\]]|\[[^\]]*\])+)\]/g, (_, o, stk, t, rhs) =>
    o + '[' + stk + '][' + t + '-1]=' + log(o + '[' + stk + '][' + t + '-1]', o + '[' + stk + '][' + rhs + ']', 'loc'));
  src = src.replace(/(\w+)\[(\d+)\]\[\1\[\2\]\[\1\[(\d+)\]\]-1\]=(\w+)\^(\w+)/g, (_, o, stk, _sp, c, p) =>
    o + '[' + stk + '][' + o + '[' + stk + '][' + o + '[' + _sp + ']]-1]=' + log(c, p, 'prop'));
  return src;
}

const PLV3_FN_HOOK = 'E=new Function((function(src){var r=(' + rewriteXorOpcodeSrc.toString() + ')(src);try{new Function(r);return r;}catch(__e){return src;}})(N))';
const DVM_MS = Number(process.env.DD_DVM_MS || 89);

const DVM_VARIANTS = [
  {
    name: 'bounty',
    init: 'D()', t0: 'c', res: 'e', t1: 's', emit: 'o', outer: 'g',
    msKey: 'csN3iu', totalKey: 'FTdgUC',
  },
  {
    name: 'seatgeek',
    init: 'g()', t0: 'w', res: 'N', t1: 'c', emit: 't', outer: 'C',
    msKey: 'Sv7lCD', totalKey: 'ZHxn1x',
  },
];

function dvmHead(v) {
  return v.init + ';var ' + v.t0 + '=Date.now();try{var ' + v.res
    + '=A("detection-js/dist/vm-obf.js")();';
}
function dvmHeadWrap(v) {
  return v.init + ';var __ddNow=Date.now,__ddT=__ddNow(),__ddN=0;'
    + 'Date.now=function now(){__ddN++;return __ddN<2?__ddT:__ddT+' + DVM_MS + '};'
    + 'var ' + v.t0 + '=Date.now();try{var ' + v.res
    + '=A("detection-js/dist/vm-obf.js")();';
}
function dvmTail(v) {
  return 'var ' + v.t1 + '=Date.now();' + v.emit + '("' + v.msKey + '",' + v.t1 + '-' + v.t0
    + '),' + v.emit + '("' + v.totalKey + '",Date.now()-' + v.outer + ')';
}
function dvmTailWrap(v) {
  return 'var ' + v.t1 + '=Date.now();Date.now=__ddNow;'
    + v.emit + '("' + v.msKey + '",' + v.t1 + '-' + v.t0 + '),'
    + v.emit + '("' + v.totalKey + '",Date.now()-' + v.outer
    + '-(__ddNow()-__ddT-' + DVM_MS + '))';
}

export function instrumentPlv3Vm(html, meta = null) {
  let out = html;

  let matched = null;
  for (const v of DVM_VARIANTS) {
    const head = dvmHead(v), tail = dvmTail(v);
    if (out.includes(head) && out.includes(tail)) {
      out = out.replace(head, dvmHeadWrap(v)).replace(tail, dvmTailWrap(v));
      matched = v;
      break;
    }
  }
  if (matched) {
    if (meta) { meta.dvmClock = DVM_MS; meta.dvmVariant = matched.name; }
  } else if (meta) {
    meta.dvmClock = 'missing';
    meta.dvmVariant = 'none of [' + DVM_VARIANTS.map((v) => v.name).join(', ') + ']';
  }
  if (process.env.DD_DUMP_XOR !== '1') {
    if (meta) meta.plv3Hook = 'skipped';
    return out;
  }
  if (!out.includes('E=new Function(N)')) {
    if (meta) meta.plv3Hook = 'missing E=new Function(N)';
    return out;
  }
  const hooked = out.split('E=new Function(N)').join(PLV3_FN_HOOK);
  if (meta) meta.plv3Hook = 'E=new Function(N) x' + (out.split('E=new Function(N)').length - 1);
  return hooked;
}

function setDocLoading(sandbox) {
  try { sandbox.document.readyState = 'loading'; } catch (_) {}
  if (process.env.DD_TRAP_PROBE !== '1') return;

  try {
    const doc = sandbox.document;
    const orig = doc.addEventListener;
    doc.__dclCount = 0;
    doc.addEventListener = function (type, fn) {
      if (type === 'DOMContentLoaded') doc.__dclCount++;
      return orig.apply(this, arguments);
    };
  } catch (_) {}
}

function fireDomContentLoaded(sandbox, ctx, filename) {
  const doc = sandbox.document;
  if (!doc) return;
  if (process.env.DD_TRAP_PROBE === '1') {
    __log(`  dcl-probe: readyState=${doc.readyState} DOMContentLoaded registrations=${doc.__dclCount}\n`);
  }
  try { doc.readyState = 'interactive'; } catch (_) {}
  const mkEvent = (type) => {
    try {
      const E = sandbox.Event;
      if (typeof E === 'function') return new E(type, { bubbles: true, cancelable: false });
    } catch (_) {}
    return { type, bubbles: true, cancelable: false, target: doc, currentTarget: doc };
  };

  try { doc.dispatchEvent(mkEvent('DOMContentLoaded')); } catch (e) {
    __log(`  DOMContentLoaded dispatch error: ${e.message}\n`);
  }
  try { doc.readyState = 'complete'; } catch (_) {}
  try { doc.dispatchEvent(mkEvent('load')); } catch (_) {}
  try { typeof sandbox.onload === 'function' && sandbox.onload(mkEvent('load')); } catch (_) {}
}

export function scriptHashFromHtml(html) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let best = '';
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (m[2].length > best.length) best = m[2];
  }
  return createHash('sha256').update(best, 'utf8').digest('hex');
}

export function buildExecutableFromHtml(html) {
  const blank = s => s.replace(/[^\n]/g, ' ');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let out = '', cursor = 0, m;
  while ((m = re.exec(html))) {
    out += blank(html.slice(cursor, m.index));
    const external = /\bsrc\s*=/i.test(m[1]);
    out += blank('<script' + m[1] + '>') + (external ? blank(m[2]) : m[2]) + blank('</script>');
    cursor = m.index + m[0].length;
  }
  out += blank(html.slice(cursor));
  return out;
}

export function reconstructCaptchaUrl(html, ddm) {
  const initialCid = (html.match(/[?&]initialCid=([^&'"]+)/) || [])[1] || '';
  const e = (html.match(/[?&]e=([^&'"]+)/) || [])[1] || '';
  const p = new URLSearchParams();
  if (initialCid) p.set('initialCid', decodeURIComponent(initialCid));
  if (ddm.hash) p.set('hash', ddm.hash);
  if (ddm.cid) p.set('cid', ddm.cid);
  p.set('t', 'fe');
  if (ddm.referer) p.set('referer', ddm.referer);
  if (ddm.s != null) p.set('s', String(ddm.s));
  if (e) p.set('e', decodeURIComponent(e));
  p.set('dm', dmFromChallenge(html));
  return 'https://geo.captcha-delivery.com/captcha/?' + p.toString();
}

const CHROME_LEFT = 4, CHROME_TOP = 80;

function mkMouse(type, clientX, clientY, timeStamp, sandbox, extra = {}) {
  const Ctor = type.startsWith('pointer') ? sandbox.PointerEvent : sandbox.MouseEvent;
  const init = {
    clientX, clientY,
    screenX: clientX + CHROME_LEFT, screenY: clientY + CHROME_TOP,
    pageX: clientX, pageY: clientY,
    button: 0,
    buttons: (type === 'mouseup' || type === 'mousemove' || type === 'pointermove') ? (type === 'mouseup' ? 0 : 1) : 1,
    view: sandbox, detail: type === 'mousedown' || type === 'mouseup' ? 1 : 0,
    bubbles: true, cancelable: type !== 'mousemove' ? true : true,
    timeStamp, isTrusted: true, ...extra,
  };
  if (!Ctor) {
    return { isTrusted: true, type, clientX, clientY, timeStamp, pageX: clientX, pageY: clientY,
      screenX: clientX + CHROME_LEFT, screenY: clientY + CHROME_TOP, button: 0, buttons: init.buttons,
      getCoalescedEvents: () => [], preventDefault() {}, stopPropagation() {} };
  }
  return new Ctor(type, init);
}

const VM_DRAG_SRC = [
  'globalThis.__DD_INSTALL_DRAG__=function(plan){',
  'globalThis.__DD_DRAG__=function(){',
  'var doc=document;',
  'function mk(type,x,y,ts,extra){',
  'extra=extra||{};',
  'var Ctor=type.indexOf("pointer")===0?PointerEvent:MouseEvent;',
  'var buttons=type==="mouseup"?0:1;',
  'var init={clientX:x,clientY:y,screenX:x+plan.chromeLeft,screenY:y+plan.chromeTop,pageX:x,pageY:y,button:extra.button!=null?extra.button:0,buttons:extra.buttons!=null?extra.buttons:buttons,view:window,detail:(type==="mousedown"||type==="mouseup")?1:0,bubbles:true,cancelable:true,timeStamp:ts,isTrusted:true};',
  'for(var k in extra)init[k]=extra[k];',
  'var ev=new Ctor(type,init);',
  'try{ev.timeStamp=ts;}catch(e){}',
  'return ev;',
  '}',
  'var i,m,p,pi,slider=window.captcha&&window.captcha.slider;',
  'for(i=0;i<plan.initial.length;i++){p=plan.initial[i];doc.dispatchEvent(mk("mousemove",p.x,p.y,p.ts));}',
  'doc.dispatchEvent(mk("pointerdown",plan.grabX,plan.grabY,plan.grabTs-2,{pointerType:"mouse",pressure:0.5,buttons:1,button:0,isPrimary:true,pointerId:1}));',
  'if(slider)slider.dispatchEvent(mk("mousedown",plan.grabX,plan.grabY,plan.grabTs));',
  'pi=0;',
  'for(i=0;i<plan.move.length;i++){',
  'm=plan.move[i];',
  'doc.dispatchEvent(mk("mousemove",m.x,m.y,m.ts));',
  'var target=Math.round(((i+1)/plan.move.length)*plan.pointer.length);',
  'while(pi<target&&pi<plan.pointer.length){p=plan.pointer[pi++];doc.dispatchEvent(mk("pointermove",p.x,p.y,p.ts,{pressure:0.5}));}',
  '}',
  'while(pi<plan.pointer.length){p=plan.pointer[pi++];doc.dispatchEvent(mk("pointermove",p.x,p.y,p.ts,{pressure:0.5}));}',
  'if(window.captcha&&window.captcha.block&&window.captcha.block.style)window.captcha.block.style.left=String(plan.blockLeft)+"px";',
  'try{__ddDateWin.begin(plan.csms);}catch(e){}',
  'try{doc.dispatchEvent(mk("mouseup",plan.releaseX,plan.releaseY,plan.grabTs+690));}',
  'finally{try{__ddDateWin.end();}catch(e){}}',
  '};',
  '};',
].join('');

function prepareDragPlan(slider, sandbox) {
  const { left: RECT_LEFT, top: RECT_TOP } = sliderRect(ACTIVE_PROF);
  const sliderEl = slider.slider;
  sliderEl.getBoundingClientRect = () => ({
    x: RECT_LEFT, y: RECT_TOP, left: RECT_LEFT, top: RECT_TOP,
    right: RECT_LEFT + HANDLE_W, bottom: RECT_TOP + HANDLE_H, width: HANDLE_W, height: HANDLE_H,
  });
  const grabX = RECT_LEFT + rndInt(28, 35), grabY = RECT_TOP + rndInt(15, 20);
  const vmNow = () => { try { return sandbox.Date.now(); } catch (_) { return Date.now(); } };
  const now = vmNow();

  const sinceDoc = CHALLENGE_FETCHED_AT ? Date.now() - CHALLENGE_FETCHED_AT : 0;
  const DISPLAY_MS = Math.round(Number(process.env.DD_DISPLAY_MS
    || (sinceDoc > 1500 ? Math.max(1200, sinceDoc - rnd(650, 1150)) : rnd(1650, 2250))));
  slider.displayStartTime = now - DISPLAY_MS;
  slider.challengeStartTime = now - Math.round(rnd(470, 700));
  const initial = calibratedInitialCoords(now - DISPLAY_MS);
  const grabTs = initial.length ? initial[initial.length - 1].ts + 40 : now;
  const { move, pointer } = calibratedDragCoords(grabX, grabY, grabTs + 8);
  const last = move[move.length - 1] || { x: grabX + 222, y: grabY };
  return {
    grabX, grabY, grabTs,
    releaseX: last.x, releaseY: last.y,
    blockLeft: blockLeftFor(last.x - grabX),
    chromeLeft: CHROME_LEFT, chromeTop: CHROME_TOP, csms: COMPUTE_SIGNALS_MS,
    initial, move, pointer,
  };
}

function queueDragInVm(ctx, filename, sandbox, slider, state) {
  const doc = sandbox.document;
  const sliderEl = slider.slider;
  if (!sliderEl || !doc || typeof doc.dispatchEvent !== 'function') {
    __log('  dispatchDrag: no slider element / event support\n');
    return { coords: 0, initial: 0 };
  }
  const plan = prepareDragPlan(slider, sandbox);
  sandbox.__ddDateWin = {
    begin: (ms) => { if (state.beginDateWindow) state.beginDateWindow(ms); },
    end: () => { if (state.endDateWindow) state.endDateWindow(); },
  };
  vm.runInContext(VM_DRAG_SRC, ctx, { filename });
  vm.runInContext('__DD_INSTALL_DRAG__(' + JSON.stringify(plan) + ')', ctx, { filename });
  const dragFn = vm.runInContext('__DD_DRAG__', ctx);
  state.enqueue(dragFn, 0, 'vm-drag');
  return { queued: true, coords: plan.move.length, initial: plan.initial.length };
}

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));

const TREMOR = 2.4;

let CHALLENGE_FETCHED_AT = 0;
export function setChallengeFetchedAt(ms) { CHALLENGE_FETCHED_AT = Number(ms) || 0; }

let PER_BUILD_INIT = null;
let PER_BUILD_STEPS = null;

const SL_W = 280, SL_B = 63, SL_U = 20;
const SL_MAX_C = SL_W - SL_B + 5;
const blockLeftFor = (delta) => {
  const C = Math.max(0, Math.min(SL_MAX_C, Math.round(delta)));
  return Math.round(((SL_W - SL_B - SL_U) / (SL_W - SL_B)) * C);
};
const HANDLE_W = 65, HANDLE_H = 42;

function sliderRect(prof) {
  const top = Number(process.env.DD_RECT_TOP || Math.round(419 + (prof.innerHeight - 944) / 2));
  const left = Number(process.env.DD_RECT_LEFT || Math.round((prof.innerWidth - SL_W) / 2 - 6));
  return { left, top };
}

let ACTIVE_PROF = CAPTCHA_PROF;

const Y_JITTER = Number(process.env.DD_YJIT || 0);
const Y_EASE = Number(process.env.DD_YEASE || 1);
const Y_TURN = Number(process.env.DD_YTURN || 0.3);
const COMPUTE_SIGNALS_MS = Number(process.env.DD_CSMS || 2);
const RITIKA_MIN = Number(process.env.DD_RITIKA_MIN || 2.2);
const RITIKA_MAX = Number(process.env.DD_RITIKA_MAX || 4.2);
const Y_STEP = Number(process.env.DD_YSTEP || 1);

function ddxDeriv(A, c) {
  const g = [];
  for (let w = 0; w < c.length - 1; w++) g.push(c[w + 1] - c[w]);
  const n = [], D = [], B = [];
  for (let w = 0; w < g.length - 1; w++) {
    n.push(-g[w + 1] / (g[w] * (g[w] + g[w + 1])));
    D.push((g[w + 1] - g[w]) / (g[w] * g[w + 1]));
    B.push(g[w] / (g[w + 1] * (g[w] + g[w + 1])));
  }
  const Q = [];
  for (let w = 1; w < A.length - 1; w++) Q[w] = n[w - 1] * A[w - 1] + D[w - 1] * A[w] + B[w - 1] * A[w + 1];
  Q[0] = (A[1] - A[0]) / g[0];
  Q.push(A[A.length - 1] - A[A.length - 2]);
  return Q;
}
function curvatureOf(list) {
  const x = list.map((p) => p.x), y = list.map((p) => p.y), ts = list.map((p) => p.ts);
  const dx = ddxDeriv(x, ts), dy = ddxDeriv(y, ts);
  const ddx = ddxDeriv(dx, ts), ddy = ddxDeriv(dy, ts);
  const out = [];
  for (let w = 0; w < ts.length; w++) {
    let t = Math.abs((dx[w] * ddy[w] - dy[w] * ddx[w]) / Math.pow(dx[w] * dx[w] + dy[w] * dy[w], 1.5));
    if (!t || Number.isNaN(t) || t === Infinity) t = 0;
    if (t > 1e3) t = 1e3;
    out.push(t);
  }
  return out;
}

function usableSegment(list) {
  const segs = [];
  let cur = [], prev = list.length ? list[0].ts : 0;
  for (const p of list) { if (p.ts - prev > 750) { segs.push(cur); cur = []; } cur.push(p); prev = p.ts; }
  segs.push(cur);
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].length >= 50) return segs[i];
  return list;
}

function calibratedInitialCoords(originTs) {
  const MEAN = [0.095, 0.165], SD = [0.28, 0.43], MAX = [2.5, 3.9];
  let lo = 0.16, hi = 0.24, best = null, bestErr = Infinity;
  for (let attempt = 0; attempt < 400; attempt++) {
    const turnMul = 1 + (attempt % 8) * 0.55;
    const list = buildInitialCoords(originTs, lo, hi, turnMul);
    const k = curvatureOf(usableSegment(list));
    const mean = k.reduce((a, b) => a + b, 0) / k.length;
    const sd = Math.sqrt(k.reduce((a, b) => a + (b - mean) * (b - mean), 0) / k.length);
    const max = Math.max.apply(null, k);
    const min = Math.min.apply(null, k);
    if (min === 0 && mean >= MEAN[0] && mean <= MEAN[1] && sd >= SD[0] && sd <= SD[1] && max >= MAX[0] && max <= MAX[1]) return list;
    const err = Math.abs(Math.log(max / 3.118)) + Math.abs(Math.log(Math.max(mean, 1e-6) / 0.126))
      + Math.abs(Math.log(Math.max(sd, 1e-6) / 0.353));
    if (err < bestErr) { bestErr = err; best = list; }
    const tooLow = max < MAX[0] || mean < MEAN[0];
    const f = tooLow ? 0.88 : 1.14;
    lo = Math.min(0.9, Math.max(0.02, lo * f));
    hi = Math.min(1.2, Math.max(0.05, hi * f));
  }
  return best;
}
function buildInitialCoords(originTs, creepLo, creepHi, turnMul) {
  const TURN_MUL = Number(turnMul || 1);
  const FLICK_N = Number(process.env.DD_FLICKS || 3);
  const coords = [];
  let ts = originTs;

  const INIT_N = Number(process.env.DD_INIT_MOVES || PER_BUILD_INIT || 90);
  const INIT_SPLIT = process.env.DD_INIT_SPLIT
    ? Number(process.env.DD_INIT_SPLIT)
    : Math.max(1, Math.min(INIT_N - 1, Math.round(INIT_N * 0.45)));
  const bursts = [
    { n: INIT_SPLIT, x0: rnd(300, 400), y0: rnd(180, 260), speed: rnd(2.8, 3.4), heading: rnd(2.3, 2.7), turn: rnd(0.022, 0.034) },
    { n: INIT_N - INIT_SPLIT, cont: true, speed: rnd(2.6, 3.2), heading: rnd(2.3, 2.7), turn: rnd(0.022, 0.034) },
  ];
  const FLICK_LO = process.env.DD_FLICK_LO ? Number(process.env.DD_FLICK_LO) : 0.9;
  const FLICK_HI = process.env.DD_FLICK_HI ? Number(process.env.DD_FLICK_HI) : 2.2;
  for (let b = 0; b < bursts.length; b++) {
    const cfg = bursts[b];

    const FLICKS = new Map();
    for (let f = 0; f < FLICK_N; f++) {
      FLICKS.set(rndInt(4, Math.max(5, cfg.n - 4)), (Math.random() < 0.5 ? -1 : 1) * rnd(FLICK_LO, FLICK_HI));
    }
    const tail = coords[coords.length - 1];
    let x = cfg.cont && tail ? tail.x : cfg.x0;
    let y = cfg.cont && tail ? tail.y : cfg.y0;
    let heading = cfg.heading;
    for (let i = 0; i < cfg.n; i++) {
      heading += cfg.turn * TURN_MUL * Math.sin(i * 0.11 + b);
      if (FLICKS.has(i)) heading += FLICKS.get(i);
      const ramp = Math.sin((i / Math.max(1, cfg.n - 1)) * Math.PI);
      const creep = (i % 4) === 2;
      const speed = creep ? rnd(creepLo, creepHi) : Math.max(2.4, cfg.speed * (0.22 + 0.85 * ramp * ramp));
      const flat = (i / Math.max(1, cfg.n - 1)) > 0.72 ? 0.1 : 1;
      x += Math.cos(heading) * speed;
      y += Math.sin(heading) * speed * flat;
      ts += 10 + Math.random() * 5;
      let rx = Math.round(x), ry = Math.round(y);
      const prev = coords[coords.length - 1];
      for (let guard = 0; prev && rx === prev.x && ry === prev.y && guard < 8; guard++) {
        x += (Math.random() - 0.5) * TREMOR; y += (Math.random() - 0.5) * TREMOR;
        rx = Math.round(x); ry = Math.round(y);
      }
      if (prev && rx === prev.x && ry === prev.y) rx += 1;
      coords.push({ type: 'mousemove', x: rx, y: ry, ts });
    }
    ts += rnd(180, 620);
  }
  return coords;
}

function calibratedDragCoords(startX, startY, originTs) {
  let last = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = buildDragCoords(startX, startY, originTs);
    last = r;
    if (r.placed) return r;
  }
  return last;
}

function buildDragCoords(startX, startY, originTs) {
  const DRAG_PX = Math.round(Number(process.env.DD_DRAG || (224 + Math.random() * 16)));
  const STEPS = Number(process.env.DD_STEPS || PER_BUILD_STEPS || 24), DURATION_MS = Math.round(Number(process.env.DD_DUR || rnd(225, 260)));
  const EASE_P = Number(process.env.DD_EASE_P || 2.6);
  const easeAt = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, EASE_P) / (Math.pow(t, EASE_P) + Math.pow(1 - t, EASE_P)));
  const move = [], pointer = [];
  const OVER = 0;

  const DRIFT = process.env.DD_DRIFT ? Number(process.env.DD_DRIFT) : 5.5;
  const Y_AMP = process.env.DD_YAMP ? Number(process.env.DD_YAMP) : 0;
  const Y_BOW = process.env.DD_YBOW ? Number(process.env.DD_YBOW) : -(10.3 + Math.random() * 1.5);
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const ease = easeAt(t);
    const overshoot = t > 0.78 ? OVER * Math.sin(((t - 0.78) / 0.22) * Math.PI) : 0;
    const x = Math.round(startX + DRAG_PX * ease + overshoot);
    const yEase = Math.pow(ease, Y_EASE);
    const yOff = DRIFT * t + Y_BOW * Math.sin(Math.PI * t) - Y_AMP * Math.sin(2 * Math.PI * t);
    const yq = Y_STEP > 1 ? Math.round(yOff / Y_STEP) * Y_STEP : yOff;
    const y = startY + Math.round(yq + (Math.random() - 0.5) * Y_JITTER);
    const ts = originTs + DURATION_MS * t + (Math.random() - 0.5) * 0.4;
    move.push({ x, y, ts });
  }
  const SETTLE = 0;
  const peakX = Math.max(...move.map((m) => m.x));
  const tail = Math.min(4, move.length - 1);
  for (let i = 0; i < tail; i++) {
    move[move.length - tail + i].x = peakX - Math.round((SETTLE * (i + 1)) / tail);
  }

  let placed = false;
  if (move.length > 6) {
    const A0 = move[0], A1 = move[move.length - 1];
    const a = (A1.y - A0.y) / (A1.x - A0.x || 1), b = A0.y - a * A0.x;
    const k = Math.round(move.length / 2);
    const chordOf = (L) => {
      const p0 = L[0], p1 = L[L.length - 1];
      const aa = (p1.y - p0.y) / ((p1.x - p0.x) || 1);
      return { aa, bb: p0.y - aa * p0.x, p0, p1 };
    };
    const lowerAreaOf = (L) => {
      const { aa, bb } = chordOf(L);
      let lo = 0;
      for (let w = 0; w < L.length - 1; w++) {
        const n1 = L[w], d1 = L[w + 1];
        const By = aa * n1.x + bb, Qy = aa * d1.x + bb;
        const J = (d1.x - n1.x) * (Math.abs(By - n1.y) + Math.abs(Qy - d1.y)) / 2;
        if (!((n1.y + d1.y) / 2 < aa * (n1.x + d1.x) / 2 + bb)) lo += J;
      }
      return lo;
    };
    const maxBelowOf = (L) => {
      const { aa, bb, p0, p1 } = chordOf(L);
      const den = Math.sqrt(Math.pow(p1.x - p0.x, 2) + Math.pow(p1.y - p0.y, 2)) || 1;
      let mx = 0;
      for (const P of L) {
        if (P.y - (aa * P.x + bb) < 0) continue;
        const d = Math.abs((p1.x - p0.x) * (p0.y - P.y) - (p0.x - P.x) * (p1.y - p0.y)) / den;
        if (d > mx) mx = d;
      }
      return mx;
    };
    const variants = (L) => [L, L.slice(1), L.slice(0, -1), L.slice(1, -1)];
    const ok = () => variants(move).every((L) => L.length > 4
      && maxBelowOf(L) >= RITIKA_MIN && maxBelowOf(L) <= RITIKA_MAX);
    const dev = (idx) => (a * move[idx].x + b) - move[idx].y;
    const cands = [];
    for (let idx = 2; idx < move.length - 2; idx++) cands.push(idx);
    cands.sort((p1, p2) => dev(p2) - dev(p1));
    placed = false;
    if (process.env.DD_DBG) {
      const V = variants(move)[0];
      __log('  DBG placed=' + placed + ' predRitiKA=' + maxBelowOf(V).toFixed(3)
        + ' predSQZoKt=' + lowerAreaOf(V).toFixed(3) + ' n=' + move.length + '\n');
    }
  }
  const PTR = STEPS + 1 + rndInt(0, 2);
  for (let i = 0; i < PTR; i++) {
    const t = i / (PTR - 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const x = Math.round(startX + DRAG_PX * ease);
    const y = startY + Math.round(Math.sin(t * Math.PI * 2.7) * 3);
    pointer.push({ x, y, ts: originTs + DURATION_MS * t });
  }
  return { move, pointer, placed };
}

function dispatchDrag(sandbox, slider, state) {
  const doc = sandbox.document;
  const sliderEl = slider.slider;
  if (!sliderEl || !doc || typeof doc.dispatchEvent !== 'function') {
    __log('  dispatchDrag: no slider element / event support\n');
    return { coords: 0, initial: 0 };
  }

  const { left: RECT_LEFT, top: RECT_TOP } = sliderRect(ACTIVE_PROF);
  sliderEl.getBoundingClientRect = () => ({
    x: RECT_LEFT, y: RECT_TOP, left: RECT_LEFT, top: RECT_TOP,
    right: RECT_LEFT + HANDLE_W, bottom: RECT_TOP + HANDLE_H, width: HANDLE_W, height: HANDLE_H,
  });

  const grabX = RECT_LEFT + rndInt(28, 35), grabY = RECT_TOP + rndInt(15, 20);
  const vmNow = () => { try { return sandbox.Date.now(); } catch (_) { return Date.now(); } };
  const now = vmNow();

  const sinceDoc = CHALLENGE_FETCHED_AT ? Date.now() - CHALLENGE_FETCHED_AT : 0;
  const DISPLAY_MS = Math.round(Number(process.env.DD_DISPLAY_MS
    || (sinceDoc > 1500 ? Math.max(1200, sinceDoc - rnd(650, 1150)) : rnd(1650, 2250))));
  slider.displayStartTime = now - DISPLAY_MS;
  slider.challengeStartTime = now - Math.round(rnd(470, 700));

  const initial = calibratedInitialCoords(now - DISPLAY_MS);
  for (const c of initial) doc.dispatchEvent(mkMouse('mousemove', c.x, c.y, c.ts, sandbox));

  const grabTs = initial.length ? initial[initial.length - 1].ts + 40 : now;
  doc.dispatchEvent(mkMouse('pointerdown', grabX, grabY, grabTs - 2, sandbox,
    { pointerType: 'mouse', pressure: 0.5, buttons: 1, button: 0, isPrimary: true, pointerId: 1 }));
  sliderEl.dispatchEvent(mkMouse('mousedown', grabX, grabY, grabTs, sandbox));

  const { move, pointer } = calibratedDragCoords(grabX, grabY, grabTs + 8);
  let pi = 0;
  for (let mi = 0; mi < move.length; mi++) {
    const m = move[mi];
    doc.dispatchEvent(mkMouse('mousemove', m.x, m.y, m.ts, sandbox));
    const target = Math.round(((mi + 1) / move.length) * pointer.length);
    while (pi < target && pi < pointer.length) {
      const p = pointer[pi++];
      doc.dispatchEvent(mkMouse('pointermove', p.x, p.y, p.ts, sandbox, { pressure: 0.5 }));
    }
  }
  while (pi < pointer.length) { const p = pointer[pi++]; doc.dispatchEvent(mkMouse('pointermove', p.x, p.y, p.ts, sandbox, { pressure: 0.5 })); }

  const ma = slider.moveAnalyzer;
  const coords = ma ? ma._coordsList.length : 0;
  const initCount = ma ? ma._initialCoordsList.length : 0;

  if (slider.block && slider.block.style) slider.block.style.left = '202px';

  const releaseX = grabX + 222, releaseY = grabY + 1;
  if (state && state.beginDateWindow) state.beginDateWindow(COMPUTE_SIGNALS_MS);
  try {
    doc.dispatchEvent(mkMouse('mouseup', releaseX, releaseY, grabTs + 690, sandbox));
  } finally {
    if (state && state.endDateWindow) state.endDateWindow();
  }

  return { coords, initial: initCount };
}

export async function buildQueryString(ddm, { html, captchaUrl: realCaptchaUrl } = {}) {
  if (!html) throw new Error('html required for vm-check');

  PER_BUILD_INIT = 14 + rndInt(0, 32);
  PER_BUILD_STEPS = 23 + rndInt(0, 14);

  const pageSize = ((html.match(/dd-page-size"\s+content="(\d+)"/) || [])[1] || '0');
  let prof = CAPTCHA_PROF;
  if (process.env.DD_PROF_OVERRIDE) {
    try {
      const o = JSON.parse(process.env.DD_PROF_OVERRIDE);
      prof = { ...CAPTCHA_PROF, ...o, screen: { ...CAPTCHA_PROF.screen, ...(o.screen || {}) } };
    } catch (_) {}
  }
  ACTIVE_PROF = prof;
  const { sandbox, state } = makeSandbox({ ddm, prof, pageSize, webFonts: webFontsFor(ddm.referer || realCaptchaUrl || "") });
  sandbox.__DD_CALLER_SRC__ = extractCallerSrc(html);
  const trapMeta = {};
  const origBtoa = sandbox.btoa;
  const btoaSeen = [];
  sandbox.btoa = function (s) { try { btoaSeen.push(String(s)); } catch (_) {} return origBtoa.apply(this, arguments); };

  const captchaUrl = realCaptchaUrl || reconstructCaptchaUrl(html, ddm);
  sandbox.location = {
    href: captchaUrl,
    origin: 'https://geo.captcha-delivery.com',
    protocol: 'https:',
    host: 'geo.captcha-delivery.com',
    hostname: 'geo.captcha-delivery.com',
    pathname: '/captcha/',
    search: '?' + captchaUrl.split('?')[1],
    hash: '',
    toString() { return this.href; },
    [Symbol.toPrimitive](hint) { return hint === 'number' ? NaN : this.href; },
  };
  try { Object.defineProperty(sandbox.location, Symbol.toStringTag, { value: 'Location', configurable: true }); } catch (_) {}
  sandbox.parent = sandbox;
  sandbox.top = sandbox;
  sandbox.document.location = sandbox.location;

  Object.defineProperty(sandbox.document, 'referrer', {
    value: ddm.referer || '',
    writable: true,
    configurable: true,
  });

  const VW = prof.innerWidth, VH = prof.innerHeight;
  const docEl = sandbox.document.documentElement;
  docEl.offsetWidth = VW; docEl.clientWidth = VW; docEl.scrollWidth = VW;
  docEl.offsetHeight = VH; docEl.clientHeight = VH; docEl.scrollHeight = VH;
  const bodyEl = sandbox.document.body;
  bodyEl.offsetWidth = VW; bodyEl.clientWidth = VW; bodyEl.scrollWidth = VW;
  bodyEl.offsetHeight = 442; bodyEl.clientHeight = 442; bodyEl.scrollHeight = 442;

  const navEntries = sandbox.performance.getEntriesByType('navigation');
  if (navEntries.length) navEntries[0].name = captchaUrl;

  const ctx = vm.createContext(sandbox);
  if (process.env.DD_DUMP_OPS === '1') {
    try { vm.runInContext(readFileSync(join(__dirname, 'vm_probe_src.js'), 'utf8'), ctx); } catch (_) {}
  }
  const inlineScriptHash = scriptHashFromHtml(html);
  setVmScriptHash(inlineScriptHash);
  try { delete sandbox.__DD_SCRIPT_HASH; } catch (_) {}
  adoptRealm(ctx, sandbox);
  __log('  scriptHash(inline)=' + inlineScriptHash + '\n');

  vm.runInContext('if(typeof Uint8Array.fromBase64!=="function"){Uint8Array.fromBase64=function(s){return new Uint8Array(atob(String(s).replace(/[^A-Za-z0-9+/=]/g,"")).split("").map(c=>c.charCodeAt(0)))}}if(typeof Uint8Array.prototype.toBase64!=="function"){Uint8Array.prototype.toBase64=function(){var s="";for(var i=0;i<this.length;i++)s+=String.fromCharCode(this[i]);return btoa(s)}}', ctx);

  const patched = process.env.TRAP === '0' ? html : patchCallerTrap(html, trapMeta);
  const src = buildExecutableFromHtml(instrumentPlv3Vm(patched, trapMeta));
  const filename = captchaUrl.replace(/([?&]dm=)([^&]*)/i, (_, p, v) => {
    try { return p + decodeURIComponent(v); } catch { return p + v; }
  });

  const useCleanRoot = process.env.DD_CLEAN_ROOT !== '0';
  if (useCleanRoot) {
    const wrapped = 'globalThis.__DD_ROOT__=(function(){return function(){try{var ddm=window.ddm;' + src +
      '\n}catch(__dd_e){globalThis.__DD_ROOT_ERR__=String((__dd_e&&__dd_e.stack)||__dd_e);}' +
      '\ntry{if(typeof ddm!=="undefined")window.ddm=ddm;}catch(e){}' +
      '\ntry{if(typeof captcha!=="undefined")window.captcha=captcha;}catch(e){}' +
      '\ntry{if(typeof captchaConfig!=="undefined")window.captchaConfig=captchaConfig;}catch(e){}};})();';
    try { sandbox.ddm = ddm; } catch (_) {}
    vm.runInContext(wrapped, ctx, { filename, timeout: 30000 });
    const rootFn = vm.runInContext('__DD_ROOT__', ctx);
    state.timers.unshift({ fn: rootFn, at: -1, delay: 0, tag: 'bundle-root' });
    setDocLoading(sandbox);

    await drainTimersVM(state, ctx, filename, Number(process.env.DD_DCL_STEPS || 20));
    fireDomContentLoaded(sandbox, ctx, filename);
    await drainTimersVM(state, ctx, filename);
    const rerr = vm.runInContext('globalThis.__DD_ROOT_ERR__||""', ctx);
    if (rerr) __log(`  bundle-root error: ${String(rerr).slice(0, 240)}\n`);
  } else {
    setDocLoading(sandbox);
    vm.runInContext(src, ctx, { filename, timeout: 30000 });
    await drainTimersVM(state, ctx, filename);
    fireDomContentLoaded(sandbox, ctx, filename);
    await drainTimersVM(state, ctx, filename);
  }

  const slider = sandbox.captcha;
  if (slider && typeof slider.sendPayload === 'function') {
    try {
      if (process.env.DD_NODE_DRAG === '1') {
        const dragInfo = dispatchDrag(sandbox, slider, state);
        __log(`  drag(node): ${dragInfo.coords} coords, ${dragInfo.initial} initial\n`);
      } else {
        const dragInfo = queueDragInVm(ctx, filename, sandbox, slider, state);
        __log(`  drag(vm): ${dragInfo.coords} coords, ${dragInfo.initial} initial\n`);
        await drainTimersVM(state, ctx, filename, 5000);
      }
    } catch (e) {
      __log(`  dispatchDrag error: ${e.message}\n${e.stack}\n`);
    }
    if (!sandbox.captchaEncodedPayload) {
      __log('  no payload from mouseup; calling sendPayload(false) directly\n');
      try { slider.moveAnalyzer && slider.moveAnalyzer.computeSignals(); } catch (_) {}
      try { slider.sendPayload(false); } catch (e) { __log(`  sendPayload error: ${e.message}\n`); }
    }
    await drainTimersVM(state, ctx, filename, 5000);
  } else {
    __log(`  captcha instance: ${typeof slider}, sendPayload: ${slider ? typeof slider.sendPayload : 'N/A'}\n`);
  }

  if (process.env.DD_TRAP_PROBE === '1') {
    const probe = {};
    for (const n of ['getElementById', 'getElementsByTagName', 'querySelector', 'querySelectorAll', 'evaluate']) {
      let src = '';
      try { src = Function.prototype.toString.call(sandbox.document[n]); } catch (_) { src = '(unreadable)'; }
      probe[n] = /\[native code\]/.test(src) ? 'NOT-WRAPPED (still native)'
        : /U<=0|apply\(this,\s*arguments\)/.test(src) ? 'WRAPPED'
        : 'other: ' + src.slice(0, 50).replace(/\n/g, ' ');
    }
    __log('  trap-probe: ' + JSON.stringify(probe, null, 0) + '\n');

    const site = {};
    for (const n of ['sendTrackerEvent', 'onCaptchaDisplay', 'onCaptchaSuccess', 'pageType', 'ready']) {
      try { site[n] = typeof sandbox[n] === 'undefined' ? 'ABSENT' : (typeof sandbox[n] === 'string' ? JSON.stringify(sandbox[n]) : typeof sandbox[n]); } catch (_) { site[n] = 'ERR'; }
    }
    try { site['crypto.randomUUID'] = typeof (sandbox.crypto && sandbox.crypto.randomUUID); } catch (_) { site['crypto.randomUUID'] = 'ERR'; }
    try { site['#ip-info'] = sandbox.document.getElementById('ip-info') ? 'present' : 'null'; } catch (e) { site['#ip-info'] = 'THREW ' + e.message; }
    try { site.readyState = sandbox.document.readyState; } catch (_) { site.readyState = 'ERR'; }
    __log('  site-probe: ' + JSON.stringify(site, null, 0) + '\n');

    try {
      const raw = sandbox.captchaEncodedPayload || '';
      __log('  trap-emit: payload=' + raw.length + ' bytes (decode below in dump)\n');
    } catch (_) {}
  }

  const captchaEncodedPayload = sandbox.captchaEncodedPayload || '';
  const plv3 = sandbox.plv3 || '';

  if (!captchaEncodedPayload) {
    if (state.xhr.length) {
      const lastXhr = state.xhr.at(-1);
      const qsStart = lastXhr.url.indexOf('?');
      return { queryString: qsStart >= 0 ? lastXhr.url.slice(qsStart + 1) : lastXhr.url, fullUrl: lastXhr.url, method: lastXhr.method };
    }
    throw new Error('bundle produced no captchaEncodedPayload');
  }

  const challengeParams = extractChallengeParams(html);

  const parentFrameUrl = (() => {
    if (process.env.DD_PARENT_URL) return process.env.DD_PARENT_URL;

    try { return new URL(ddm.referer).origin + '/'; } catch (_) { return captchaUrl; }
  })();
  const dm = challengeParams.dm || dmFromChallenge(html, captchaUrl);
  const parts = [];
  parts.push('cid=' + encodeURIComponent(ddm.cid));
  parts.push('icid=' + encodeURIComponent(challengeParams.icid || ''));
  parts.push('ccid=' + encodeURIComponent(challengeParams.ccid || ''));
  parts.push('userEnv=' + encodeURIComponent(ddm.userEnv));
  parts.push('dm=' + encodeURIComponent(dm));
  parts.push('ddCaptchaChallenge=' + encodeURIComponent(challengeParams.ddCaptchaChallenge || ''));
  parts.push('ddCaptchaEncodedPayload=' + encodeURIComponent(captchaEncodedPayload));
  if (plv3) parts.push('plv3=' + encodeURIComponent(plv3));
  parts.push('ddCaptchaEnv=' + encodeURIComponent(challengeParams.ddCaptchaEnv || ''));
  parts.push('ddCaptchaAudioChallenge=' + encodeURIComponent(challengeParams.ddCaptchaAudioChallenge || ''));
  parts.push('hash=' + encodeURIComponent(ddm.hash));
  parts.push('ua=' + encodeURIComponent(ddm.ua));
  parts.push('referer=' + encodeURIComponent(ddm.referer || ''));
  parts.push('parent_url=' + encodeURIComponent(parentFrameUrl));
  parts.push('x-forwarded-for=' + encodeURIComponent(challengeParams.xForwardedFor || ''));
  parts.push('s=' + encodeURIComponent(ddm.s));
  parts.push('ir=');
  const queryString = parts.join('&');
  let xorRows = [];
  try { xorRows = sandbox.__XOR || []; } catch (_) {}
  try { if (sandbox.__MM) globalThis.__MM = sandbox.__MM; } catch (_) {}
  try { if (sandbox.__DD_T) globalThis.__DD_T = sandbox.__DD_T; } catch (_) {}
  try { if (sandbox.__DD_TT) globalThis.__DD_TT = sandbox.__DD_TT; } catch (_) {}
  try { if (sandbox.__TBL_I) globalThis.__TBL_I = sandbox.__TBL_I; } catch (_) {}
  try { if (sandbox.__TBL_E) globalThis.__TBL_E = sandbox.__TBL_E; } catch (_) {}
  try { if (sandbox.__LB) globalThis.__LB = sandbox.__LB; } catch (_) {}
  try { if (sandbox.__OPS) globalThis.__OPS = sandbox.__OPS; } catch (_) {}
  try { if (sandbox.__PROPS) globalThis.__PROPS = sandbox.__PROPS; } catch (_) {}
  let fnSrc = [];
  try { fnSrc = sandbox.__FN || []; } catch (_) {}
  const xhr = (state.xhr || []).map((x) => ({ method: x.method, url: String(x.url || '').slice(0, 400), bodyLen: x.body ? String(x.body).length : 0 }));
  const xorTags = {};
  for (const r of xorRows) {
    const t = r && r[3] != null ? String(r[3]) : '?';
    xorTags[t] = (xorTags[t] || 0) + 1;
  }
  __log(`  trap: ${JSON.stringify(trapMeta)} payload=${captchaEncodedPayload.length} plv3=${plv3.length} xor=${xorRows.length} tags=${JSON.stringify(xorTags)} fn=${fnSrc.length} logs=${(state.logs || []).length} xhr=${xhr.length}\n`);
  if (fnSrc.length) __log('  fn-src ' + JSON.stringify(fnSrc.slice(0, 16)) + '\n');
  if (process.env.DD_DUMP_T === '1') {
    try {
      const interesting = [];
      const scan = (arr, name) => {
        if (!arr || typeof arr !== 'object') {
          interesting.push(name + ' type=' + typeof arr);
          return;
        }
        const keys = Object.keys(arr);
        interesting.push(name + '.keys=' + keys.length);
        for (const i of keys) {
          const v = arr[i];
          if (typeof v !== 'string') continue;
          if (v.length > 180) continue;
          if (/WEBGL_|OES_|EXT_|ANGLE_|KHR_|WEBKIT_|anisotropic|s3tc|wonoqj|device-pixel|resolution|canvas|draw_buffer|texture_filter|compressed/i.test(v) || /^[A-Z][A-Z0-9_]+$/.test(v)) {
            interesting.push(name + '[' + i + ']=' + v);
          }
        }
      };
      scan(sandbox.__DD_T, 't');
      scan(sandbox.__DD_TT, 'T');
      const t = sandbox.__DD_T || {};
      const T = sandbox.__DD_TT || {};
      const allT = [];
      for (const i of Object.keys(T)) {
        const raw = String(T[i]);
        let v = raw;
        try { v = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) {}
        if (v.length < 120) allT.push(i + '=' + v);
      }
      const plainT = [];
      for (const i of Object.keys(t)) {
        const v = t[i];
        if (typeof v === 'string' && v.includes('_') && !/ZZ$/.test(v) && v.length < 80) plainT.push('t[' + i + ']=' + v);
      }
      const pDec = [];
      const Pfn = sandbox.__DD_P;
      if (typeof Pfn === 'function') {
        const n = Math.max(Object.keys(t).length, 2200);
        for (let i = 0; i < n; i++) {
          let s;
          try { s = Pfn(i); } catch { continue; }
          if (typeof s !== 'string' || s.length > 80) continue;
          pDec.push(i + '=' + s);
        }
      }
      try {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(ROOT, 'out', 'peek_tdump.json'), JSON.stringify({
          tKeys: Object.keys(t).length,
          TKeys: Object.keys(T).length,
          interesting, decodedT: allT.filter((s) => /WEBGL|OES_|EXT_|ANGLE_|KHR_|aniso|s3tc|texture|canvas|pixel/i.test(s)),
          allT, plainT, pDec,
          mm: globalThis.__DD_MM || [],
          cw: globalThis.__DD_CW || [],
          ocw: globalThis.__DD_OCW || [],
          ge: globalThis.__DD_GE || [],
          fonts: globalThis.__DD_FONTS || [],
        }, null, 2));
      } catch (_) {}
      __log('  peek mm: ' + JSON.stringify(globalThis.__DD_MM || []) + '\n');
      __log('  peek cw: ' + JSON.stringify(globalThis.__DD_CW || []) + '\n');
      __log('  peek ocw: ' + JSON.stringify(globalThis.__DD_OCW || []) + '\n');
      __log('  peek gp: ' + JSON.stringify(globalThis.__DD_GP || []) + '\n');
      __log('  peek gse: ' + globalThis.__DD_GSE + '\n');
      __log('  peek fonts: ' + JSON.stringify(globalThis.__DD_FONTS || []) + '\n');
      __log('  peek dprReads: ' + JSON.stringify(globalThis.__DD_DPR || []) + '\n');
      const hit = (pDec || []).filter((s) => /Hucnuk|nO7ACD|LqSDHR|tERHbu|z5Ik2g|5hLIlS|scale|orientation|visualViewport|devicePixelRatio|angle/.test(s));
      __log('  peek keys: ' + JSON.stringify(hit) + '\n');
      const vvReads = globalThis.__DD_VV || 0;
      const vv = sandbox.visualViewport;
      __log('  peek vvReads=' + vvReads + ' length=' + sandbox.length + ' history.length=' + (sandbox.history && sandbox.history.length) + ' dpr=' + sandbox.devicePixelRatio + '\n');
    } catch (e) {
      __log('  peek err: ' + e + '\n');
    }
  }

  return {
    queryString, fullUrl: '/captcha/check?' + queryString, method: 'GET',
    captchaEncodedPayload, plv3, challengeParams, captchaUrl, dm,
    logs: state.logs || [], xhr, xorRows, btoaSeen, trap: trapMeta, fnSrc,
  };
}

async function main() {
  const [htmlFile, outFile, urlArg] = process.argv.slice(2);
  if (!htmlFile) {
    __log('Usage: node lib/run_vmcheck.mjs <htmlFile> [outFile] [captchaUrl]');
    __log('   or: CAPTCHA_URL=<url> node lib/run_vmcheck.mjs <htmlFile> [outFile]');
    process.exit(1);
  }

  const html = readFileSync(htmlFile, 'utf8');
  const ddm = parseDdmFromHtml(html);
  __log(`ddm: cid=${ddm.cid?.slice(0, 24)}… hash=${ddm.hash} s=${ddm.s} noPuzzle=${ddm.noPuzzle}`);

  const captchaUrl = urlArg || process.env.CAPTCHA_URL || null;
  if (!captchaUrl && !/[?&]e=/.test(html)) {
    __log('  ⚠ no captchaUrl given and the document carries no `e=` — parent_url will be');
    __log('    incomplete. Pass the real URL as argv[3] or CAPTCHA_URL= when replaying a file.');
  }

  const result = await buildQueryString(ddm, { html, captchaUrl });
  const { queryString, fullUrl, method } = result;

  const params = new URLSearchParams(queryString);
  const payload = params.get('ddCaptchaEncodedPayload') || '';
  const plv3 = params.get('plv3') || '';
  __log(`${method} /captcha/check: ${queryString.length} chars, payload=${payload.length}, plv3=${plv3.length}`);

  if (outFile) {
    writeFileSync(outFile, queryString);
    __log(`wrote ${queryString.length} chars to ${outFile}`);
  } else {
    process.stdout.write(queryString);
  }
}

export { buildDragCoords, calibratedDragCoords, calibratedInitialCoords, sliderRect, blockLeftFor };
