'use strict';

const fs = require('fs');
const path = require('path');

const G_CONST = 1809053797;
const ALPHA = '-_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const REV = {}; for (let i = 0; i < ALPHA.length; i++) REV[ALPHA[i]] = i;

function loadDefaultK() {
  try {
    const ks = JSON.parse(fs.readFileSync(path.join(__dirname, 'keystore.json'), 'utf8'));
    return ks.K | 0;
  } catch (e) {
    return null;
  }
}
const DEFAULT_K = loadDefaultK();

function hashCode(str) {
  let I = 0;
  for (let M = 0; M < str.length; M++) I = ((I << 5) - I + str.charCodeAt(M)) | 0;
  return I;
}
function o(A) {
  A = (A ^ (A << 13)) | 0;
  A = (A ^ (A >> 17)) | 0;
  return (A ^ (A << 5)) | 0;
}
function pureStream(seed, n) {
  const out = new Array(n);
  let I = seed | 0, m = -1;
  for (let p = 0; p < n; p++) { m++; if (m > 2) { I = o(I); m = 0; } out[p] = (I >> (16 - 8 * m)) & 255; }
  return out;
}
function s(A) { return A > 37 ? 59 + A : A > 11 ? 53 + A : A > 1 ? 46 + A : 50 * A + 45; }

function b64pack(B) {
  const out = [];
  for (let i = 0; i < B.length; i += 3) {
    const b0 = B[i], b1 = B[i + 1] || 0, b2 = B[i + 2] || 0;
    const C = (b0 << 16) | (b1 << 8) | b2;
    out.push(String.fromCharCode(s((C >> 18) & 63)), String.fromCharCode(s((C >> 12) & 63)),
             String.fromCharCode(s((C >> 6) & 63)), String.fromCharCode(s(C & 63)));
  }
  const y = B.length % 3;
  let str = out.join('');
  if (y) str = str.slice(0, str.length - (3 - y));
  return str;
}
function b64dec(str) {
  str = str.replace(/[^-_0-9A-Za-z]/g, '');
  const out = []; let i = 0;
  while (i < str.length) {
    const have = Math.min(4, str.length - i);
    const c0 = REV[str[i]] || 0, c1 = REV[str[i + 1]] || 0, c2 = REV[str[i + 2]] || 0, c3 = REV[str[i + 3]] || 0;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 255);
    if (have > 2) out.push((n >> 8) & 255);
    if (have > 3) out.push(n & 255);
    i += 4;
  }
  return out;
}

function keystreams(cid, K, n) {
  const w = hashCode(cid);
  return {
    C: pureStream((K ^ w) | 0, n),
    g: pureStream((G_CONST ^ w) | 0, n),
  };
}

function decode(enc, cid, K = DEFAULT_K) {
  if (K == null) throw new Error('codec.decode: no K provided and keystore.json missing/unreadable');
  const cb = b64dec(enc);
  const { C, g } = keystreams(cid, K, cb.length);
  const raw = new Array(cb.length);
  for (let k = 0; k < cb.length; k++) raw[k] = (cb[k] ^ C[k] ^ g[k]) & 255;
  return Buffer.from(raw).toString('utf8');
}

function decodeObject(enc, cid, K = DEFAULT_K) {
  return JSON.parse(decode(enc, cid, K));
}

function encodeRaw(rawJSONfull, cid, K = DEFAULT_K) {
  if (K == null) throw new Error('codec.encodeRaw: no K provided and keystore.json missing/unreadable');
  const bytes = Buffer.from(rawJSONfull, 'utf8');
  const n = bytes.length;
  const { C, g } = keystreams(cid, K, n);
  const B = new Array(n);
  for (let k = 0; k < n; k++) B[k] = (bytes[k] ^ C[k] ^ g[k]) & 255;
  return b64pack(B);
}

function encode(orderedObj, cid, K = DEFAULT_K) {
  return encodeRaw(JSON.stringify(orderedObj), cid, K);
}

module.exports = {
  G_CONST, ALPHA, DEFAULT_K,
  hashCode, o, pureStream, b64pack, b64dec, keystreams,
  decode, decodeObject, encode, encodeRaw,
};
