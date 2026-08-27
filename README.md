# datadome-captcha-solver

Solve a DataDome captcha ( dd.t = fe /check ) Give it the captcha URL, get the `datadome` cookie back.

It runs the site's **own challenge bundle** inside a `node:vm` against a synthetic browser. Nothing
drives the challenge UI — there is no automated clicking or dragging

It fetches `c.js`, the challenge document and its assets the way a browser would, then submits
`/captcha/check`. It never touches the protected site; verifying the cookie against it is your job

## Install

```sh
npm install github:buggerlogger/datadome-captcha-solver
```

## Use

```js
import { solveCaptcha } from 'datadome-captcha-solver';

const result = await solveCaptcha(
  'https://geo.captcha-delivery.com/captcha/?initialCid=...&hash=...&cid=...&t=fe&s=...&e=...&dm=cd'
);

result.cookie;      // "ABC~xyz..."  -> send as  Cookie: datadome=<cookie>
result.setCookie;   // the full Set-Cookie string, attributes included
result.payload;     // the encoded ddCaptchaEncodedPayload
result.plv3;        // the plv3 blob
result.queryString; // the full /captcha/check query
result.ok;          // a cookie came back
```

### Getting the captcha URL

The URL comes from the 403 the protected site served you — its body carries
`var dd = {cid, hsh, t, s, e, ...}` and the iframe URL is built from those. `tools/fetch.mjs` does
that for you:

```sh
node tools/fetch.mjs https://site.example/login
```

```
transport      uTLS chrome_win10 via fetch.exe  proxy=direct
  status        403  x-dd-b=1
  challenge     t=fe  (slider captcha)

captcha url (pass this to solveCaptcha):

https://geo.captcha-delivery.com/captcha/?initialCid=...&t=fe&...
```

Add `--json` for a machine-readable object; `challengeFor(pageUrl)` is exported for the same thing.
It exits non-zero and tells you when the page is not a captcha this solver handles:

```
  status        403  x-dd-b=2
  challenge     t=bv  (behaviour interstitial)
```

`solveCaptcha` makes the same check on the URL you hand it and refuses anything that is not `t=fe`.

The `cid`, `e` and `initialCid` in that URL are one-shot, but they are spent by `/captcha/check`,
not by fetching the document — you can look at the challenge without burning it.

### Which challenge you get is decided by TLS, not by this library

DataDome picks the challenge class from the **TLS ClientHello**, before a byte of JavaScript runs,
and stamps its choice into `dd.t`. Node's own TLS is answered with `t=bv`, the interstitial this
solver does not handle; a real Chrome ClientHello is answered with `t=fe`.

That decision is made at the protected origin. `geo.captcha-delivery.com` does not repeat it, so
**the library itself needs no special transport** — it solves a `t=fe` URL over plain Node TLS.
Only the two requests you make yourself need a Chrome fingerprint:

| step | who does it | transport |
| --- | --- | --- |
| provoke the 403, read `dd` | you | Chrome ClientHello |
| solve the captcha | this library | anything |
| replay `datadome=<cookie>` | you | Chrome ClientHello |

Nothing is bundled for that. Point `DD_GO` at a uTLS fetch binary or set `PROXY`, and both
`tools/fetch.mjs` and the library will use it; `TLS=node` forces Node's stack back on.

### Options

```js
await solveCaptcha(captchaUrl, {
  canvasFrames,          // seven "data:image/png;base64,..." frames (see below)
  device: generateDevice(),   // a random coherent device; omit for the base profile
  referer: 'https://site.example/login',
});
```

### Build a payload without sending anything

```js
import { buildPayload } from 'datadome-captcha-solver';
const { queryString, payload, plv3, checkUrl } = await buildPayload(html, captchaUrl);
```

For authorised security testing and research.
