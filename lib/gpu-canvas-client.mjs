
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const done = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
  let req;
  try { req = JSON.parse(raw); } catch (e) { return done({ ok: false, error: 'bad request' }); }

  const ws = new WebSocket(req.wsUrl);
  const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 25000);

  const fail = (e) => { clearTimeout(timer); done({ ok: false, error: String(e && e.message || e) }); };
  ws.onerror = () => fail('socket error');

  ws.onopen = () => {
    const expr = req.mode === 'workerhash' ? 'window.__gc_workerhash()' : 'window.__gc_replay('
      + JSON.stringify(req.w) + ',' + JSON.stringify(req.h) + ','
      + JSON.stringify(req.ops || []) + ',' + JSON.stringify(req.mode || 'url') + ','
      + JSON.stringify(req.rect || [0, 0, 1, 1]) + ',' + JSON.stringify(req.type ?? null) + ','
      + JSON.stringify(req.quality ?? null) + ')';
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id !== 1) return;
    clearTimeout(timer);
    const v = m.result && m.result.result && m.result.result.value;
    if (!v) return done({ ok: false, error: 'no value' });
    done({ ok: true, value: v });
  };
});
