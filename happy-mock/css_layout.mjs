export function substituteVars(value, props, depth = 0) {
  if (depth > 16 || typeof value !== 'string' || value.indexOf('var(') < 0) return value;
  let out = '';
  for (let i = 0; i < value.length;) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let d = 0, j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === '(') d++;
      else if (value[j] === ')') { d--; if (d === 0) break; }
    }
    const inner = value.slice(at + 4, j);
    const comma = splitTop(inner, ',');
    const name = comma[0].trim();
    const fallback = comma.length > 1 ? comma.slice(1).join(',').trim() : null;
    const have = Object.prototype.hasOwnProperty.call(props, name) ? String(props[name]).trim() : null;
    const chosen = have !== null && have !== '' ? have : (fallback !== null ? fallback : '');
    out += substituteVars(chosen, props, depth + 1);
    i = j + 1;
  }
  return out;
}

function splitTop(s, sep) {
  const parts = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === sep && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function evalLength(expr) {
  if (typeof expr !== 'string') return null;
  let s = expr.trim();
  if (!s) return null;
  for (let guard = 0; guard < 32; guard++) {
    const m = /(calc|min|max|clamp)\(([^()]*)\)/i.exec(s);
    if (!m) break;
    const fn = m[1].toLowerCase();
    const args = splitTop(m[2], ',').map((a) => a.trim());
    let v;
    if (fn === 'calc') v = arith(args[0]);
    else {
      const nums = args.map(arith);
      if (nums.some((n) => n === null)) return null;
      if (fn === 'min') v = Math.min(...nums);
      else if (fn === 'max') v = Math.max(...nums);
      else v = Math.max(nums[0], Math.min(nums[1], nums[2]));
    }
    if (v === null || v === undefined || Number.isNaN(v)) return null;
    s = s.slice(0, m.index) + v + 'px' + s.slice(m.index + m[0].length);
  }
  return arith(s);
}

function arith(expr) {
  if (typeof expr !== 'string') return null;
  const toks = String(expr).trim().match(/(\d*\.?\d+)\s*(px)?|[-+*/()]/gi);
  if (!toks) return null;
  const out = [], ops = [];
  const prec = (o) => (o === '+' || o === '-' ? 1 : o === '*' || o === '/' ? 2 : 0);
  const apply = () => {
    const o = ops.pop(), b = out.pop(), a = out.pop();
    if (a === undefined || b === undefined) return false;
    out.push(o === '+' ? a + b : o === '-' ? a - b : o === '*' ? a * b : b === 0 ? NaN : a / b);
    return true;
  };
  let prevWasVal = false;
  for (let raw of toks) {
    const t = raw.trim();
    if (!t) continue;
    if (/^[-+]$/.test(t) && !prevWasVal) { out.push(0); ops.push(t); prevWasVal = false; continue; }
    if (/^[-+*/]$/.test(t)) {
      while (ops.length && prec(ops[ops.length - 1]) >= prec(t)) if (!apply()) return null;
      ops.push(t); prevWasVal = false; continue;
    }
    if (t === '(') { ops.push(t); prevWasVal = false; continue; }
    if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') if (!apply()) return null;
      ops.pop(); prevWasVal = true; continue;
    }
    const n = parseFloat(t);
    if (Number.isNaN(n)) return null;
    out.push(n); prevWasVal = true;
  }
  while (ops.length) if (!apply()) return null;
  const v = out.pop();
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseStyleRules(html) {
  const rules = [];
  for (const block of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = block[1];
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = parseDecls(r[2]);
      for (const sel of r[1].split(',')) {
        const s = sel.trim();
        if (s) rules.push({ sel: s, decls });
      }
    }
  }
  return rules;
}

export function parseDecls(text) {
  const d = {};
  for (const part of splitTop(String(text || ''), ';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) d[k] = v;
  }
  return d;
}

function matchCompound(el, term) {
  if (!el || el.nodeType !== 1) return false;
  const parts = term.match(/[#.]?[\w-]+/g) || [];
  for (const p of parts) {
    if (p[0] === '#') { if (el.id !== p.slice(1)) return false; }
    else if (p[0] === '.') { if (!String(el.className || '').split(/\s+/).includes(p.slice(1))) return false; }
    else if (p !== '*') { if (String(el.tagName || '').toLowerCase() !== p.toLowerCase()) return false; }
  }
  return true;
}

export function matchSelector(el, sel) {
  const toks = sel.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  let i = toks.length - 1, cur = el;
  if (!matchCompound(cur, toks[i])) return false;
  i--;
  while (i >= 0) {
    const combinator = toks[i] === '>' ? (i--, '>') : ' ';
    const term = toks[i]; i--;
    if (combinator === '>') {
      cur = cur._cssParent;
      if (!matchCompound(cur, term)) return false;
    } else {
      let p = cur._cssParent, ok = false;
      while (p) { if (matchCompound(p, term)) { ok = true; break; } p = p._cssParent; }
      if (!ok) return false;
      cur = p;
    }
  }
  return true;
}

export function parseElements(html, makeElement, rootEl) {
  const root = rootEl || makeElement('div');
  if (!rootEl) root._cssParent = null;
  const stack = [root];
  const tagRe = /<(\/)?([a-zA-Z][\w-]*)([^>]*?)(\/)?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const closing = !!m[1], tag = m[2].toLowerCase(), attrs = m[3] || '', selfClose = !!m[4];
    if (tag === 'style') {
      const end = html.indexOf('</style>', m.index);
      if (end >= 0) tagRe.lastIndex = end + 8;
      continue;
    }
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const el = makeElement(tag);
    const id = /\bid\s*=\s*"([^"]*)"|\bid\s*=\s*'([^']*)'/.exec(attrs);
    const cls = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/.exec(attrs);
    const sty = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/.exec(attrs);
    if (id) el.id = id[1] ?? id[2];
    if (cls) { el.className = cls[1] ?? cls[2]; if (el.classList && el.classList.add) for (const c of String(el.className).split(/\s+/)) if (c) el.classList.add(c); }
    if (sty) { el._inlineCss = sty[1] ?? sty[2]; if (el.style) el.style.cssText = el._inlineCss; }
    const parent = stack[stack.length - 1];
    el._cssParent = parent;
    parent.children.push(el);
    if (parent.childNodes) parent.childNodes.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

export function layout(root, rules) {
  const cascade = (el, inherited) => {
    const props = Object.create(null);
    for (const k in inherited) props[k] = inherited[k];
    const own = {};
    for (const r of rules) {
      let ok = false;
      try { ok = matchSelector(el, r.sel); } catch (_) { ok = false; }
      if (ok) Object.assign(own, r.decls);
    }
    if (el._inlineCss) Object.assign(own, parseDecls(el._inlineCss));
    for (const k in own) if (k.startsWith('--')) props[k] = own[k];
    el._cssProps = props;
    el._cssOwn = own;
    for (const c of el.children || []) if (c && c.nodeType === 1) cascade(c, props);
  };
  cascade(root, Object.create(null));

  const len = (el, decl) => {
    const raw = el._cssOwn && el._cssOwn[decl];
    if (raw === undefined) return null;
    return evalLength(substituteVars(raw, el._cssProps));
  };
  const padOf = (el) => {
    const own = el._cssOwn || {};
    const shorthand = own.padding !== undefined ? evalLength(substituteVars(own.padding, el._cssProps)) : null;
    const pl = own['padding-left'] !== undefined ? evalLength(substituteVars(own['padding-left'], el._cssProps))
      : own.paddingLeft !== undefined ? evalLength(substituteVars(own.paddingLeft, el._cssProps)) : null;
    const pr = own['padding-right'] !== undefined ? evalLength(substituteVars(own['padding-right'], el._cssProps))
      : own.paddingRight !== undefined ? evalLength(substituteVars(own.paddingRight, el._cssProps)) : null;
    const base = shorthand === null ? 0 : shorthand;
    return { l: pl === null ? base : pl, r: pr === null ? base : pr };
  };

  const measure = (el) => {
    for (const c of el.children || []) if (c && c.nodeType === 1) measure(c);
    const own = el._cssOwn || {};
    const pad = padOf(el);
    const explicit = len(el, 'width');
    let content;
    if (explicit !== null) {
      content = explicit;
    } else {
      let widest = 0;
      for (const c of el.children || []) if (c && c.nodeType === 1) widest = Math.max(widest, c._borderBox || 0);
      content = widest;
    }
    const maxW = len(el, 'max-width');
    if (maxW !== null) content = Math.min(content, maxW);
    const minW = len(el, 'min-width');
    if (minW !== null) content = Math.max(content, minW);
    if (String(own['box-sizing'] || own.boxSizing || '').trim() === 'border-box' && explicit !== null) {
      content = Math.max(0, content - pad.l - pad.r);
    }
    const padded = Math.round(content + pad.l + pad.r);
    el._borderBox = padded;
    el._offsetWidth = padded;
    el.clientWidth = padded;
    el.scrollWidth = padded;
    el._cssWidth = Math.round(content);
  };
  measure(root);
  return root;
}

export function buildFragment(html, makeElement, rootEl) {
  const rules = parseStyleRules(html);
  const root = parseElements(html, makeElement, rootEl);
  if (rootEl && !rootEl._inlineCss) {
    try {
      const ct = rootEl.style && rootEl.style.cssText;
      if (ct) rootEl._inlineCss = String(ct);
    } catch (_) {}
  }
  root._cssRules = (root._cssRules || []).concat(rules);
  layout(root, root._cssRules);
  return root;
}

export function findInTree(root, sel) {
  const stack = [...(root.children || [])];
  while (stack.length) {
    const el = stack.shift();
    if (!el || el.nodeType !== 1) continue;
    try { if (matchSelector(el, sel)) return el; } catch (_) {}
    if (el.children && el.children.length) stack.unshift(...el.children);
  }
  return null;
}
