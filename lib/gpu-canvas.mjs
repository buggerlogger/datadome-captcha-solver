
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.DD_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const findChrome = () => CHROME_CANDIDATES.find((p) => p && existsSync(p)) || null;

let state = null;
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const kill = () => { try { stopSync(); } catch (_) {} };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kill(); process.exit(1); });
}

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>gc</title><canvas id=c></canvas><script>
const canvas=document.getElementById('c');
window.__gc_replay=function(w,h,ops,mode,rect,type,quality){
  canvas.width=w; canvas.height=h;
  const ctx=canvas.getContext('2d');
  const G={};
  for(var i=0;i<ops.length;i++){
    var op=ops[i];
    try{
      if(op.t==='g'){
        var g = op.k==='r' ? ctx.createRadialGradient.apply(ctx,op.a)
              : op.k==='c' ? ctx.createConicGradient.apply(ctx,op.a)
              :              ctx.createLinearGradient.apply(ctx,op.a);
        for(var s=0;s<op.s.length;s++) g.addColorStop(op.s[s][0],op.s[s][1]);
        G[op.i]=g;
      } else if(op.t==='s'){
        ctx[op.p] = (op.g!=null) ? G[op.g] : op.v;
      } else {
        ctx[op.m].apply(ctx,op.a);
      }
    }catch(e){}
  }
  if(mode==='px'){
    var d=ctx.getImageData(rect[0],rect[1],rect[2],rect[3]).data;
    var out=new Array(d.length); for(var k=0;k<d.length;k++) out[k]=d[k];
    return {px:out};
  }
  return {url: (typeof type==='string' && type) ? canvas.toDataURL(type,quality) : canvas.toDataURL()};
};
window.__gc_workerhash=function(){
  var T="Quartz glyph job vexd cwm finks"+String.fromCharCode(55357,56898);
  function H(b){return crypto.subtle.digest("SHA-256",b).then(function(d){return Array.from(new Uint8Array(d))})}
  function X(a){return a.map(function(v){return v.toString(16).padStart(2,"0")}).join("")}
  var v=new OffscreenCanvas(1,1),x=v.getContext("2d"),q=[];
  v.width=380;v.height=55;
  x.textBaseline="alphabetic";x.fillStyle="#F0A";x.fillRect(49,1,73,25);
  x.fillStyle="#3A1";x.font='13pt "Times New Roman"';x.fillText(T,5,17);
  x.fillStyle="rgba(49, 40, 223, 0.33)";x.font="17pt Arial";x.fillText(T,7,25);
  q.push(H(x.getImageData(0,0,v.width,v.height).data));
  q.push(H(x.getImageData(0,0,v.width,v.height).data));
  v.width=131;v.height=115;x.globalCompositeOperation="multiply";
  var C=[["#E3E",55,55],["#3EE",95,55],["#EE3",70,90]];
  for(var i=0;i<C.length;i++){x.fillStyle=C[i][0];x.beginPath();x.arc(C[i][1],C[i][2],45,0,2*Math.PI,!0);x.closePath();x.fill()}
  x.fillStyle="#EA3";x.arc(65,65,65,0,2*Math.PI,!0);x.arc(65,65,30,0,2*Math.PI,!0);x.fill("evenodd");
  q.push(H(x.getImageData(0,0,v.width,v.height).data));
  return Promise.all(q).then(function(d){
    if(X(d[0])!==X(d[1]))return "UNST";
    return X(d[0].map(function(n,i){return n^d[2][i]}))
  })
};
window.__gc_renderer=(()=>{try{const gl=document.createElement('canvas').getContext('webgl');
  const d=gl&&gl.getExtension('WEBGL_debug_renderer_info');
  return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):(gl?'unknown':null);}catch(e){return null}})();
</script>`;

function send(ws, pending, idRef, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const n = idRef.v++;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 30000);
    pending.set(n, (r) => { clearTimeout(timer); resolve(r); });
    try { ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(n); reject(e); }
  });
}

export async function startGpuCanvas({ timeoutMs = 25000, log = () => {} } = {}) {
  if (state) return state;
  hookExit();
  const bin = findChrome();
  if (!bin) { log('[gpucanvas] no Chrome on this machine — using the rasteriser'); return null; }

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE_HTML);
  });
  const pagePort = await new Promise((r) => { server.listen(0, '127.0.0.1', () => r(server.address().port)); })
    .catch(() => null);
  if (!pagePort) { log('[gpucanvas] could not bind a loopback port'); return null; }

  const cdpPort = 9000 + Math.floor(Math.random() * 900);
  const profileDir = mkdtempSync(join(tmpdir(), 'ddgc-'));
  const chrome = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--use-angle=d3d11', '--hide-scrollbars', '--mute-audio',
    `http://127.0.0.1:${pagePort}/`,
  ], { stdio: 'ignore' });

  let info = null;
  const t0 = Date.now();
  while (!info && Date.now() - t0 < timeoutMs) {
    try { info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); }
    catch { await new Promise((r) => setTimeout(r, 120)); }
  }
  if (!info) {
    try { chrome.kill(); } catch (_) {} try { server.close(); } catch (_) {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    log('[gpucanvas] Chrome did not expose CDP in time'); return null;
  }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  const pending = new Map(); const idRef = { v: 1 };
  state = { chrome, ws, server, profileDir, cdpPort, pagePort, wsUrl: null, sessionId: null, renderer: null, calls: 0 };
  if (!opened) { await stopGpuCanvas(); log('[gpucanvas] CDP socket refused'); return null; }
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
  };

  try {
    const targets = await send(ws, pending, idRef, 'Target.getTargets');
    const page = (targets.targetInfos || []).find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const att = await send(ws, pending, idRef, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
    state.sessionId = att.sessionId;
    state.targetId = page.targetId;
    await send(ws, pending, idRef, 'Runtime.enable', {}, state.sessionId);

    let renderer = null;
    for (let i = 0; i < 80 && !renderer; i++) {
      const r = await send(ws, pending, idRef, 'Runtime.evaluate',
        { expression: 'window.__gc_renderer||null', returnByValue: true }, state.sessionId);
      renderer = r && r.result && r.result.value;
      if (!renderer) await new Promise((x) => setTimeout(x, 100));
    }
    if (!renderer) throw new Error('page never reported a renderer');
    state.renderer = renderer;

    if (/SwiftShader|llvmpipe|Software|Microsoft Basic|ANGLE \(Google/i.test(renderer)) {
      log(`[gpucanvas] REFUSED: headless answered with a SOFTWARE renderer (${renderer.slice(0, 52)})`);
      await stopGpuCanvas(); return null;
    }
    state.wsUrl = `ws://127.0.0.1:${state.cdpPort}/devtools/page/${page.targetId}`;
    log(`[gpucanvas] warm in ${Date.now() - t0} ms on ${renderer.slice(0, 62)}`);
    return state;
  } catch (e) { log(`[gpucanvas] handshake failed: ${e.message}`); await stopGpuCanvas(); return null; }
}

export const gpuAvailable = () => Boolean(state && state.wsUrl);
export const gpuRendererName = () => (state ? state.renderer : null);
export const gpuCallCount = () => (state ? state.calls : 0);

let gpuMs = 0;
export const gpuElapsedMs = () => gpuMs;

let workerHash;
export function gpuWorkerTextHash() {
  if (workerHash !== undefined) return workerHash;
  if (!gpuAvailable()) return null;
  const v = gpuRenderSync({ mode: 'workerhash' });
  workerHash = (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) ? v : null;
  return workerHash;
}

function stopSync() {
  if (!state) return;
  const s = state; state = null;
  try { s.ws.close(); } catch (_) {}
  try { s.chrome.kill(); } catch (_) {}
  try { s.server.close(); } catch (_) {}
  try { rmSync(s.profileDir, { recursive: true, force: true }); } catch (_) {}
}
export async function stopGpuCanvas() { stopSync(); }

export function gpuRenderSync(req) {
  if (!gpuAvailable()) return null;
  try {
    state.calls++;
    const t0 = Date.now();
    const out = execFileSync(process.execPath, [join(__dirname, 'gpu-canvas-client.mjs')], {
      input: JSON.stringify({ wsUrl: state.wsUrl, ...req }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 12000,
      windowsHide: true,
    });
    gpuMs += Date.now() - t0;
    const parsed = JSON.parse(out);
    if (process.env.DD_GPU_DEBUG) console.error(`[gpucanvas] call ${state.calls} ${req.mode} ops=${(req.ops||[]).length} ${Date.now()-t0}ms ${parsed && parsed.ok ? 'ok' : 'FAIL:' + (parsed && parsed.error)}`);
    return parsed && parsed.ok ? parsed.value : null;
  } catch (e) { gpuMs += Date.now() - t0; if (process.env.DD_GPU_DEBUG) console.error(`[gpucanvas] call ${state.calls} threw after ${Date.now()-t0}ms: ${String(e.message).slice(0,90)}`); return null; }
}
