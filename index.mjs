import { createRequire } from 'node:module';
import { buildQueryString, parseDdmFromHtml, setChallengeFetchedAt } from './lib/run_vmcheck.mjs';
import { httpGet, describeTransport } from './lib/transport.mjs';
import { setCanvasFeed } from './happy-mock/index.mjs';
import { generateDevice, describeDevice } from './lib/device_profile.mjs';
import { startGpuCanvas, stopGpuCanvas, gpuAvailable, gpuRendererName } from './lib/gpu-canvas.mjs';

const require = createRequire(import.meta.url);
const codec = require('./deps/codec.js');
const { recoverK } = require('./deps/recover.js');

function hasDtwSentinel(encoded, cid) {
  try {
    const obj = codec.decodeObject(encoded, cid, recoverK(encoded, cid).K);
    for (const v of Object.values(obj)) if (v === 1000000) return true;
  } catch {}
  return false;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const CH_UA = '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"';
const CAPTCHA_HOST = 'https://geo.captcha-delivery.com';

export { generateDevice, describeDevice, describeTransport, startGpuCanvas, stopGpuCanvas, gpuAvailable, gpuRendererName };

function refererOf(captchaUrl) {
  try { return new URL(captchaUrl).searchParams.get('referer') || ''; } catch { return ''; }
}

function assertSupported(captchaUrl) {
  let u;
  try { u = new URL(captchaUrl); } catch { u = null; }
  if (!u || !/(^|\.)captcha-delivery\.com$/.test(u.hostname)) {
    throw new TypeError('solveCaptcha(captchaUrl): expected a geo.captcha-delivery.com URL, got ' + captchaUrl);
  }
  const t = u.searchParams.get('t') || '';
  if (t === 'bv' || u.pathname.startsWith('/interstitial')) {
    throw new Error('this is a t=bv interstitial, not the t=fe slider captcha this solver handles. '
      + 'The challenge class is chosen from the TLS ClientHello: Node TLS is answered with t=bv, a real '
      + 'Chrome ClientHello with t=fe. Re-run tools/fetch.mjs over a Chrome-TLS transport (DD_GO or PROXY).');
  }
  if (!u.pathname.startsWith('/captcha/')) {
    throw new TypeError('solveCaptcha(captchaUrl): expected a /captcha/ URL, got ' + u.pathname);
  }
  if (t !== 'fe') {
    throw new Error('unsupported captcha version t=' + (t || '(missing)') + ' — this solver handles t=fe');
  }
}

async function fetchChallenge(captchaUrl, referer) {
  const res = await httpGet(captchaUrl, {
    referer,
    mode: 'iframe',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': UA,
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  if (res.status !== 200) throw new Error(`challenge document not served (HTTP ${res.status})`);
  if (res.body.length < 100000) {
    throw new Error(/You have been blocked|thinks you are a robot/i.test(res.body)
      ? 'an IP-reputation block page was served instead of a challenge'
      : 'the challenge document carries no JS bundle');
  }
  return res.body;
}

export async function buildPayload(html, captchaUrl, opts = {}) {
  if (opts.canvasFrames) setCanvasFeed(opts.canvasFrames);
  if (opts.device) {
    const { seed, ...prof } = opts.device;
    process.env.DD_PROF_OVERRIDE = JSON.stringify(prof);
  }
  if (process.env.DD_GPU_CANVAS !== '0') {
    try { await startGpuCanvas({ log: process.env.DD_GPU_DEBUG ? (m) => console.error(m) : () => {} }); } catch (_) {}
  }

  const ddm = parseDdmFromHtml(html);
  const tries = Number(process.env.DD_BUILD_TRIES || 8);
  let built = await buildQueryString(ddm, { html, captchaUrl });
  for (let attempt = 1; attempt < tries && hasDtwSentinel(built.captchaEncodedPayload, ddm.cid); attempt++) {
    built = await buildQueryString(ddm, { html, captchaUrl });
  }
  return {
    queryString: built.queryString,
    payload: built.captchaEncodedPayload,
    plv3: built.plv3 || '',
    checkUrl: `${CAPTCHA_HOST}/captcha/check?${built.queryString}`,
    cid: ddm.cid,
  };
}

async function warmAssets(html, captchaUrl) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:https:)?\/\/(?:static|ct)\.captcha-delivery\.com\/[^"'\s\\)]+/g)) {
    urls.add(m[0].startsWith('//') ? 'https:' + m[0] : m[0]);
  }
  const cssBodies = [];
  let ok = 0;
  for (const u of urls) {
    const dest = /\.css(\?|$)/.test(u) ? 'style'
      : /\.(png|jpe?g|gif|webp)(\?|$)/.test(u) ? 'image'
      : /\.(ttf|woff2?|otf)(\?|$)/.test(u) ? 'font'
      : /\.js(\?|$)/.test(u) ? 'script' : 'empty';
    try {
      const r = await httpGet(u, {
        referer: captchaUrl,
        headers: {
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9',
          accept: dest === 'image' ? 'image/avif,image/webp,image/apng,image/svg+xml,*/*;q=0.8'
            : dest === 'style' ? 'text/css,*/*;q=0.1' : '*/*',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': dest === 'font' ? 'cors' : 'no-cors',
          'sec-fetch-dest': dest,
        },
      });
      if (r.status === 200) ok++;
      if (r.status === 200 && dest === 'style') cssBodies.push(String(r.body || ''));
    } catch {}
  }

  const fontUrls = new Set();
  for (const css of cssBodies) {
    for (const m of css.matchAll(/url\(\s*['"]?((?:https:)?\/\/[^)'"\s]+|\/[^)'"\s]+)['"]?\s*\)/g)) {
      let u = m[1];
      if (u.startsWith('//')) u = 'https:' + u;
      else if (u.startsWith('/')) u = 'https://static.captcha-delivery.com' + u;
      if (!urls.has(u)) fontUrls.add(u);
    }
  }
  for (const u of fontUrls) {
    try {
      const r = await httpGet(u, {
        referer: captchaUrl,
        headers: {
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9',
          accept: '*/*',
          origin: 'https://geo.captcha-delivery.com',
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'font',
        },
      });
      if (r.status === 200) ok++;
    } catch {}
  }
  return { ok, total: urls.size + fontUrls.size };
}

export async function solveCaptcha(captchaUrl, opts = {}) {
  assertSupported(captchaUrl);
  const referer = opts.referer || refererOf(captchaUrl);

  if (!opts.skipAssets) {
    try {
      await httpGet('https://ct.captcha-delivery.com/c.js', {
        referer,
        headers: {
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9',
          accept: '*/*',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'script',
        },
      });
    } catch {}
  }

  const html = await fetchChallenge(captchaUrl, referer);
  setChallengeFetchedAt(Date.now());

  const assets = opts.skipAssets ? null : await warmAssets(html, captchaUrl);

  const built = await buildPayload(html, captchaUrl, opts);

  const check = await httpGet(built.checkUrl, {
    mode: 'check',
    referer: captchaUrl,
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: captchaUrl,
      'user-agent': UA,
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  let setCookie = null;
  let cookie = null;
  try {
    setCookie = JSON.parse(check.body).cookie || null;
    if (setCookie) cookie = setCookie.split(';')[0].replace(/^datadome=/, '') || null;
  } catch {}

  return {
    ok: Boolean(cookie),
    assets,
    cookie,
    setCookie,
    status: check.status,
    payload: built.payload,
    plv3: built.plv3,
    queryString: built.queryString,
    cid: built.cid,
    body: check.body,
  };
}

export default solveCaptcha;
