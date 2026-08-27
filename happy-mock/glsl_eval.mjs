const BUILTINS = {
  max: Math.max, min: Math.min, floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
  sqrt: Math.sqrt, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  pow: Math.pow, sign: Math.sign,
  mod: (x, y) => x - y * Math.floor(x / y),
  fract: (x) => x - Math.floor(x),
  step: (edge, x) => (x < edge ? 0 : 1),
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); },
};

function tokenize(src) {
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?\.?|[A-Za-z_]\w*|[-+*/(),;={}]|./g;
  const out = [];
  for (const m of src.match(re) || []) {
    if (/^\s/.test(m) || m.startsWith('//') || m.startsWith('/*')) continue;
    out.push(m);
  }
  return out;
}

function parseExpr(toks, pos) {
  let i = pos;
  const peek = () => toks[i];
  const parsePrimary = () => {
    let t = toks[i];
    if (t === '(') { i++; const e = parseAdd(); if (toks[i] === ')') i++; return e; }
    if (t === '-') { i++; const e = parsePrimary(); return (env) => -e(env); }
    if (t === '+') { i++; return parsePrimary(); }
    if (/^[0-9.]/.test(t)) { i++; const v = parseFloat(t); return () => v; }
    if (/^[A-Za-z_]/.test(t)) {
      i++;
      if (toks[i] === '(') {
        i++;
        const args = [];
        if (toks[i] !== ')') {
          for (;;) { args.push(parseAdd()); if (toks[i] === ',') { i++; continue; } break; }
        }
        if (toks[i] === ')') i++;
        const fn = BUILTINS[t];
        if (!fn) return () => NaN;
        return (env) => fn(...args.map((a) => a(env)));
      }
      const name = t;
      return (env) => (name in env ? env[name] : NaN);
    }
    i++; return () => NaN;
  };
  const parseMul = () => {
    let left = parsePrimary();
    while (peek() === '*' || peek() === '/') {
      const op = toks[i++]; const right = parsePrimary(); const l = left;
      left = op === '*' ? (env) => l(env) * right(env) : (env) => l(env) / right(env);
    }
    return left;
  };
  const parseAdd = () => {
    let left = parseMul();
    while (peek() === '+' || peek() === '-') {
      const op = toks[i++]; const right = parseMul(); const l = left;
      left = op === '+' ? (env) => l(env) + right(env) : (env) => l(env) - right(env);
    }
    return left;
  };
  const e = parseAdd();
  return [e, i];
}

export function compileFragmentShader(src) {
  if (typeof src !== 'string' || src.indexOf('gl_FragColor') < 0) return null;
  const body = src.slice(src.indexOf('main'));
  const toks = tokenize(body);
  const steps = [];
  let color = null;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'float' || t === 'highp' || t === 'mediump' || t === 'lowp') { i++; continue; }
    if (t === 'gl_FragColor') {
      i++;
      if (toks[i] !== '=') { i++; continue; }
      i++;
      if (toks[i] === 'vec4') {
        i++;
        if (toks[i] === '(') i++;
        const parts = [];
        for (;;) {
          const [e, ni] = parseExpr(toks, i); i = ni; parts.push(e);
          if (toks[i] === ',') { i++; continue; }
          break;
        }
        if (toks[i] === ')') i++;
        color = parts;
      }
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(t) && toks[i + 1] === '=') {
      const name = t; i += 2;
      const [e, ni] = parseExpr(toks, i); i = ni;
      steps.push([name, e]);
      continue;
    }
    i++;
  }
  if (!color || color.length < 3) return null;
  return (uniforms) => {
    const env = Object.create(null);
    for (const k in uniforms) env[k] = uniforms[k];
    for (const [name, e] of steps) env[name] = e(env);
    const out = color.map((e) => e(env));
    while (out.length < 4) out.push(1);
    return out.slice(0, 4);
  };
}

export function toBytes(rgba) {
  return rgba.map((v) => {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(255, Math.round(Math.max(0, Math.min(1, v)) * 255)));
  });
}
