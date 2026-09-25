import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { probeConnection } from './probes.mjs';

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/crypto.mjs', ['crypto.mjs', 'text/javascript; charset=utf-8']],
  ['/qr.mjs', ['qr.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/qrcode.mjs', ['vendor/qrcode.mjs', 'text/javascript; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
]);
const safeProbeCodes = new Set(['voice_ok','backend_ok','auth_failed','access_denied','model_unavailable','endpoint_not_found','request_rejected','rate_limited','service_unavailable','network_error','timeout','cancelled','invalid_response','response_incomplete','close_unconfirmed','redirect_refused','invalid_config','invalid_endpoint','invalid_model','invalid_key']);
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function readProbeBody(req) {
  return new Promise((resolve,reject) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData); req.removeListener('end', onEnd);
      req.removeListener('aborted', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const onAbort = () => finish(new Error('cancelled'));
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > 20000) finish(new Error('request_too_large'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(null,parsed); }
      catch { finish(new Error('invalid_config')); }
    };
    const timer = setTimeout(() => finish(new Error('timeout')),5000);
    req.on('data',onData); req.once('end',onEnd); req.once('aborted',onAbort); req.once('error',onAbort);
  });
}
export function createServer({probe = probeConnection} = {}) {
  let activeProbes = 0;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Live-Voice-Tool', 'pc-config-v2');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Only loopback requests; the explicit probe route never persists inputs.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) {
      res.writeHead(403); res.end(); return;
    }
    if (req.url === '/api/test-connection' && req.method === 'POST') {
      if (req.headers.origin !== `http://${req.headers.host}` ||
          req.headers['x-live-voice-probe'] !== '1' ||
          !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        json(res,403,{ok:false,code:'request_rejected'}); return;
      }
      if (activeProbes >= 2) { json(res,429,{ok:false,code:'busy'}); return; }
      activeProbes++;
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close',abort);
      try {
        const body = await readProbeBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 2 || !Object.hasOwn(body,'credential') ||
            !['voice','backend'].includes(body.kind)) throw new Error('invalid_config');
        if (controller.signal.aborted) throw new Error('cancelled');
        const result = await probe(body.kind,body.credential,{signal:controller.signal});
        if (result?.ok !== true || result.code !== `${body.kind}_ok`) throw new Error('invalid_response');
        json(res,200,{ok:true,code:result.code,durationMs:Math.max(0,Math.min(120000,Math.round(Number(result.durationMs)||0)))});
      } catch (error) {
        const code = error?.code || error?.message;
        json(res,code === 'request_too_large' ? 413 : 200,{ok:false,code:safeProbeCodes.has(code) ? code : 'request_rejected'});
      } finally { activeProbes--; res.removeListener('close',abort); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const entry = files.get(req.url);
    if (!entry) { res.writeHead(404); res.end(); return; }
    try {
      const data = await readFile(new URL(entry[0], root));
      res.writeHead(200, { 'Content-Type': entry[1] });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404); res.end(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8792);
  const server = createServer();
  server.on('error', () => { console.error('Cannot start local page. Check the port.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Live Voice configuration: http://127.0.0.1:${port}/`));
}
