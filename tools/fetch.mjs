#!/usr/bin/env node
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { httpGet, describeTransport, closeTransport } from '../lib/transport.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const CAPTCHA_HOST = 'https://geo.captcha-delivery.com';

const CHALLENGE_KIND = {
  fe: { path: '/captcha/', label: 'slider captcha', solvable: true },
  bv: { path: '/interstitial/', label: 'behaviour interstitial', solvable: false },
  cp: { path: '/captcha/', label: 'puzzle captcha', solvable: false },
};

function parseDdConfig(body) {
  const m = String(body).match(/var\s+dd\s*=\s*(\{[\s\S]*?\})\s*[;<]/);
  if (!m) return null;
  try {
    return vm.runInNewContext('(' + m[1].replace(/'/g, '"') + ')', Object.create(null));
  } catch {
    return null;
  }
}

function buildCaptchaUrl(dd, pageUrl, sessionCid) {
  const p = new URLSearchParams();
  p.set('initialCid', dd.cid);
  p.set('hash', dd.hsh);
  p.set('cid', sessionCid);
  p.set('t', dd.t || 'fe');
  p.set('referer', pageUrl);
  p.set('s', String(dd.s));
  if (dd.e) p.set('e', dd.e);
  p.set('dm', 'cd');
  return `${CAPTCHA_HOST}${(CHALLENGE_KIND[dd.t] || CHALLENGE_KIND.fe).path}?${p.toString()}`;
}

export async function challengeFor(pageUrl) {
  const res = await httpGet(pageUrl, {
    mode: 'navigate',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': UA,
    },
  });

  const blockedBy = res.header('x-dd-b');
  const dd = parseDdConfig(res.body);

  if (!dd) {
    return {
      ok: false,
      status: res.status,
      blockedBy,
      reason: res.status === 200
        ? 'the page was served normally — there is no challenge to solve'
        : `HTTP ${res.status} with no dd config in the body`,
    };
  }

  const jar = (res.setCookies || []).map(String).find((c) => c.startsWith('datadome='));
  const sessionCid = jar ? jar.split(';')[0].slice('datadome='.length) : '';
  const kind = CHALLENGE_KIND[dd.t] || { label: `unknown type "${dd.t}"`, solvable: false, path: '/captcha/' };

  return {
    ok: kind.solvable,
    status: res.status,
    blockedBy,
    type: dd.t,
    typeLabel: kind.label,
    solvable: kind.solvable,
    captchaUrl: buildCaptchaUrl(dd, pageUrl, sessionCid),
    sessionCookie: sessionCid,
    referer: pageUrl,
    dd,
  };
}

function report(r) {
  const line = (k, v) => console.log('  ' + String(k).padEnd(14) + v);
  console.log('transport      ' + describeTransport());
  line('status', `${r.status}${r.blockedBy ? `  x-dd-b=${r.blockedBy}` : '  (no x-dd-b)'}`);

  if (!r.type) {
    console.log('\n' + r.reason);
    return;
  }

  line('challenge', `t=${r.type}  (${r.typeLabel})`);

  if (!r.solvable) {
    console.log('\nThis is not the challenge solveCaptcha() handles — it needs t=fe.');
    if (r.type === 'bv') {
      console.log('DataDome chooses the challenge from the TLS ClientHello, before any JavaScript runs.');
      console.log("Node's TLS is answered with t=bv; a real Chrome ClientHello is answered with t=fe.");
      console.log('Point DD_GO at a uTLS fetch binary (or set PROXY) and try again.');
    } else {
      console.log('The site is serving a different challenge version; this solver has no answer for it.');
      console.log('  ' + r.captchaUrl);
    }
    return;
  }

  console.log('\ncaptcha url (pass this to solveCaptcha):\n');
  console.log(r.captchaUrl);
  console.log('\nOne-shot: cid/e/initialCid are spent by /captcha/check, not by fetching the document.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const pageUrl = args.find((a) => !a.startsWith('--'));

  if (!pageUrl) {
    console.error('usage: node tools/fetch.mjs <protected-page-url> [--json]');
    process.exit(2);
  }

  try {
    const r = await challengeFor(pageUrl);
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else report(r);
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    console.error('failed: ' + e.message);
    process.exitCode = 3;
  }
  await closeTransport();
}
