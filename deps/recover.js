'use strict';

const { G_CONST, hashCode, pureStream, b64dec, decode } = require('./codec');

const DEFAULT_PREFIX = '{"shHAe0":"';

const KNOWN_M = [2025364016, -1069129669];

function toByteArray(prefix) {
  return Array.from(Buffer.from(prefix, 'utf8'));
}

function looksJsonObject(raw) {
  return raw.length > 1 && raw.charCodeAt(0) === 0x7b && raw.charCodeAt(1) === 0x22;
}

function isJsonParseable(raw) {
  if (!looksJsonObject(raw)) return false;
  try { JSON.parse(raw); return true; } catch (e) { return false; }
}

function recoverM(enc, cid, rawPrefix = DEFAULT_PREFIX) {
  if (typeof rawPrefix === 'string') rawPrefix = toByteArray(rawPrefix);
  const cb = b64dec(enc);
  const n = Math.min(rawPrefix.length, cb.length);
  const gStream = pureStream((G_CONST ^ hashCode(cid)) | 0, n);
  const Cpure = new Array(n);
  for (let k = 0; k < n; k++) Cpure[k] = (rawPrefix[k] ^ cb[k] ^ gStream[k]) & 255;
  const lo24 = (Cpure[0] << 16) | (Cpure[1] << 8) | Cpure[2];
  for (let hi = 0; hi < 256; hi++) {
    const M = ((hi << 24) | lo24) | 0;
    const cand = pureStream(M, n);
    let ok = true;
    for (let k = 0; k < n; k++) if (cand[k] !== Cpure[k]) { ok = false; break; }
    if (ok) return { M, K: (M ^ hashCode(cid)) | 0, Cpure, gStream, cb, wcid: hashCode(cid) };
  }
  return { M: null, K: null, Cpure, gStream, cb, wcid: hashCode(cid) };
}

function recoverBruteFree(enc, cid) {
  const w = hashCode(cid);
  const cb = b64dec(enc);
  const g0 = pureStream((G_CONST ^ w) | 0, 2);
  const cs0 = (0x7b ^ cb[0] ^ g0[0]) & 255;
  const cs1 = (0x22 ^ cb[1] ^ g0[1]) & 255;
  const mid = (cs0 << 16) | (cs1 << 8);
  for (let b3 = 0; b3 < 256; b3++) {
    const top = b3 << 24;
    for (let b0 = 0; b0 < 256; b0++) {
      const M = (top | mid | b0) | 0;
      const K = (M ^ w) | 0;
      let raw;
      try { raw = decode(enc, cid, K); } catch (e) { continue; }
      if (isJsonParseable(raw)) return { K, M, wcid: w };
    }
  }
  return { K: null, M: null, wcid: w };
}

function recoverK(enc, cid, opts = {}) {
  let prefixes = [DEFAULT_PREFIX];
  let knownM = KNOWN_M;
  let brute = true;
  if (typeof opts === 'string') prefixes = [opts];
  else if (Array.isArray(opts)) prefixes = opts;
  else if (opts && typeof opts === 'object') {
    if (opts.prefixes) prefixes = [].concat(opts.prefixes);
    if (opts.knownM) knownM = [].concat(opts.knownM, KNOWN_M);
    if (opts.brute === false) brute = false;
  }
  const w = hashCode(cid);

  for (const M of knownM) {
    const K = (M ^ w) | 0;
    let raw;
    try { raw = decode(enc, cid, K); } catch (e) { continue; }
    if (isJsonParseable(raw)) return { K, M, wcid: w, prefix: null, method: 'known-M' };
  }

  for (const pfx of prefixes) {
    const rec = recoverM(enc, cid, pfx);
    if (rec.M != null) return { K: rec.K, M: rec.M, wcid: rec.wcid, prefix: pfx, method: 'prefix' };
  }

  if (brute) {
    const rec = recoverBruteFree(enc, cid);
    if (rec.K != null) return { K: rec.K, M: rec.M, wcid: rec.wcid, prefix: null, method: 'brute' };
  }

  return { K: null, M: null, wcid: w, prefix: null, method: null };
}

function decodeAuto(enc, cid, opts = {}) {
  const rec = recoverK(enc, cid, opts);
  if (rec.K == null) return { env: null, ...rec };
  let env;
  try { env = JSON.parse(decode(enc, cid, rec.K)); } catch (e) { return { env: null, ...rec }; }
  return { env, ...rec };
}

module.exports = { DEFAULT_PREFIX, KNOWN_M, recoverM, recoverK, recoverBruteFree, decodeAuto, toByteArray };
