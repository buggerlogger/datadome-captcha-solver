# datadome-captcha-solver

Solve a DataDome captcha ( dd.t = fe /check ) Give it the captcha URL, get the `datadome` cookie back.

It runs the site's **own challenge bundle** inside a `node:vm` against a synthetic browser. Nothing
drives the challenge UI — there is no automated clicking or dragging

It fetches `c.js`, the challenge document and its assets the way a browser would, then submits
`/captcha/check`. It never touches the protected site; verifying the cookie against it is your job

## Install

```sh
npm install github:buggerlogger/dd-403-solver-lib
```

## Use

```js
import { solveCaptcha } from 'dd-403-solver';

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

You get the captcha URL from the 403 the protected site served you: its body carries
`var dd = {cid, hsh, t, s, e, ...}`, and the iframe URL is built from those.

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
import { buildPayload } from 'dd-403-solver';
const { queryString, payload, plv3, checkUrl } = await buildPayload(html, captchaUrl);
```

For authorised security testing and research.
