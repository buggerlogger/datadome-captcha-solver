const RE_NUM = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*$/i;

export function parseNumber(v) {
  const m = RE_NUM.exec(String(v));
  return m ? parseFloat(m[1]) : NaN;
}
export function parseAngle(v) {
  const m = RE_NUM.exec(String(v));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'deg').toLowerCase()) {
    case 'rad': return n;
    case 'turn': return n * 2 * Math.PI;
    case 'grad': return (n * Math.PI) / 200;
    default: return (n * Math.PI) / 180;
  }
}

function splitTop(s, sep) {
  const out = []; let d = 0, cur = '';
  for (const ch of String(s)) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === sep && d === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function evalCalc(expr) {
  let s = String(expr).trim();
  const m = /^calc\((.*)\)$/is.exec(s);
  if (m) s = m[1];
  const toks = s.match(/\(|\)|[+\-*/]|[0-9.]+(?:[eE][+-]?\d+)?[a-z%]*|[a-z%]+/gi) || [];
  let i = 0;
  const peek = () => toks[i];
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = parseFactor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const parseFactor = () => {
    if (peek() === '(') { i++; const v = parseExpr(); if (peek() === ')') i++; return v; }
    if (peek() === '-') { i++; return -parseFactor(); }
    if (peek() === '+') { i++; return parseFactor(); }
    const t = toks[i++];
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : 0;
  };
  const v = parseExpr();
  return v;
}

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function perspective(d) {
  const m = ident();
  if (d > 0) m[2 * 4 + 3] = -1 / d;
  return m;
}
function rotate3d(x, y, z, angle) {
  const len = Math.hypot(x, y, z);
  if (len === 0) return ident();
  x /= len; y /= len; z /= len;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const m = ident();
  const R = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) m[col * 4 + r] = R[r][col];
  return m;
}
function scale3d(sx, sy, sz) { const m = ident(); m[0] = sx; m[5] = sy; m[10] = sz; return m; }
function translate3d(tx, ty, tz) { const m = ident(); m[12] = tx; m[13] = ty; m[14] = tz; return m; }
function skew(ax, ay) { const m = ident(); m[4] = Math.tan(ax); m[1] = Math.tan(ay); return m; }

function termMatrix(name, args) {
  const n = (i, dflt = 0) => { const v = evalCalc(args[i]); return Number.isFinite(v) ? v : dflt; };
  const a = (i) => (args[i] === undefined ? 0 : parseAngle(String(args[i]).trim().startsWith('calc(')
    ? evalCalc(args[i]) + 'rad' : args[i]));
  switch (name) {
    case 'matrix': {
      const m = ident();
      m[0] = n(0); m[1] = n(1); m[4] = n(2); m[5] = n(3); m[12] = n(4); m[13] = n(5);
      return m;
    }
    case 'matrix3d': { const m = ident(); for (let k = 0; k < 16; k++) m[k] = n(k); return m; }
    case 'perspective': return perspective(n(0));
    case 'rotate': case 'rotatez': return rotate3d(0, 0, 1, a(0));
    case 'rotatex': return rotate3d(1, 0, 0, a(0));
    case 'rotatey': return rotate3d(0, 1, 0, a(0));
    case 'rotate3d': return rotate3d(n(0), n(1), n(2), a(3));
    case 'scale': return scale3d(n(0, 1), args.length > 1 ? n(1, 1) : n(0, 1), 1);
    case 'scalex': return scale3d(n(0, 1), 1, 1);
    case 'scaley': return scale3d(1, n(0, 1), 1);
    case 'scalez': return scale3d(1, 1, n(0, 1));
    case 'scale3d': return scale3d(n(0, 1), n(1, 1), n(2, 1));
    case 'translate': return translate3d(n(0), args.length > 1 ? n(1) : 0, 0);
    case 'translatex': return translate3d(n(0), 0, 0);
    case 'translatey': return translate3d(0, n(0), 0);
    case 'translatez': return translate3d(0, 0, n(0));
    case 'translate3d': return translate3d(n(0), n(1), n(2));
    case 'skew': return skew(a(0), args.length > 1 ? a(1) : 0);
    case 'skewx': return skew(a(0), 0);
    case 'skewy': return skew(0, a(0));
    default: return ident();
  }
}

export function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  let s = n.toPrecision(6);
  if (s.indexOf('e') < 0) {
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  } else {
    const [mant, exp] = s.split('e');
    let mm = mant;
    if (mm.indexOf('.') >= 0) mm = mm.replace(/0+$/, '').replace(/\.$/, '');
    s = mm + 'e' + (exp[0] === '+' ? exp.slice(1) : exp);
  }
  return s === '-0' ? '0' : s;
}

const is2D = (m) => m[2] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0
  && m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0 && m[14] === 0 && m[15] === 1;

export function computeTransform(value) {
  const s = String(value || '').trim();
  if (!s || s === 'none') return 'none';
  const re = /([a-zA-Z0-9]+)\s*\(/g;
  let m, out = ident(), any = false;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    let d = 1, i = re.lastIndex;
    for (; i < s.length && d > 0; i++) { if (s[i] === '(') d++; else if (s[i] === ')') d--; }
    const args = splitTop(s.slice(re.lastIndex, i - 1), ',').map((t) => t.trim());
    out = mul(out, termMatrix(name, args));
    any = true;
    re.lastIndex = i;
  }
  if (!any) return 'none';
  if (is2D(out)) return 'matrix(' + [out[0], out[1], out[4], out[5], out[12], out[13]].map(fmt).join(', ') + ')';
  return 'matrix3d(' + out.map(fmt).join(', ') + ')';
}

export function computeColor(value) {
  const s = String(value || '').trim();
  const m = /^rgba?\((.*)\)$/is.exec(s);
  if (!m) return s;
  let parts = splitTop(m[1], ',').map((t) => t.trim());
  if (parts.length === 1) parts = splitTop(m[1], ' ').map((t) => t.trim()).filter(Boolean);
  const ch = parts.slice(0, 3).map((p) => {
    const v = evalCalc(p);
    if (!Number.isFinite(v)) return v > 0 ? 255 : 0;
    return Math.max(0, Math.min(255, Math.round(v)));
  });
  while (ch.length < 3) ch.push(0);
  const alpha = parts.length > 3 ? evalCalc(parts[3]) : 1;
  return alpha >= 1 || !Number.isFinite(alpha)
    ? 'rgb(' + ch.join(', ') + ')'
    : 'rgba(' + ch.join(', ') + ', ' + fmt(alpha) + ')';
}

export const _internals = { mul, ident, perspective, rotate3d, scale3d, translate3d, splitTop };
