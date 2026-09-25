import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createServer } from '../server.mjs';

test('loopback server rejects general uploads and unlisted files, and only allows same-origin browser requests', async t => {
  const server = createServer().listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  assert.match(page.headers.get('content-security-policy'),/form-action 'none'/);
  assert.equal(page.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(`${base}/crypto.mjs`)).status,200);
  for (const path of ['/package.json','/tests/crypto.test.mjs','/.env','/?key=demo']) {
    assert.equal((await fetch(base + path)).status,404);
  }
  assert.equal((await fetch(base,{method:'POST',body:'synthetic-only'})).status,405);
  const status = await new Promise((resolve,reject) => {
    http.get(base,{headers:{Host:'untrusted.invalid'}}, res => {res.resume();resolve(res.statusCode);}).on('error',reject);
  });
  assert.equal(status,403);
});

async function start(t, probe) {
  const server = createServer({probe}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {Origin:base,'Content-Type':'application/json','X-Live-Voice-Probe':'1','Sec-Fetch-Site':'same-origin'};
  return {base,headers,post:(body,overrides={})=>fetch(`${base}/api/test-connection`,{method:'POST',headers,body:JSON.stringify(body),...overrides})};
}
const synthetic = {kind:'backend',credential:{endpoint:'https://example.invalid/v1',model:'test-model',auth:'bearer',apiKey:'demo-not-a-real-key'}};

test('probe route requires same-origin JSON plus explicit header, without invoking providers for rejected requests', async t => {
  let calls = 0;
  const {base,headers,post} = await start(t,async () => {calls++; return {ok:true,code:'backend_ok',durationMs:123};});
  for (const extra of [{Origin:'https://untrusted.invalid'},{Origin:''},{'X-Live-Voice-Probe':''},{'Content-Type':'text/plain'},{'Sec-Fetch-Site':'cross-site'}]) {
    assert.equal((await post(synthetic,{headers:{...headers,...extra}})).status,403);
  }
  assert.equal((await fetch(`${base}/api/test-connection`,{method:'OPTIONS',headers})).status,405);
  assert.equal(calls,0);
  assert.deepEqual(await (await post(synthetic)).json(),{ok:true,code:'backend_ok',durationMs:123});
  assert.equal(calls,1);
});

test('probe route bounds payload and strips all provider/error details', async t => {
  let calls = 0;
  const {post} = await start(t,async () => {calls++; throw new Error('provider echoed demo-not-a-real-key');});
  assert.equal((await post({...synthetic,extra:'unexpected'})).status,200);
  assert.equal(calls,0);
  assert.equal((await post({...synthetic,credential:{...synthetic.credential,apiKey:'a'.repeat(21000)}})).status,413);
  assert.equal(calls,0);
  const response = await (await post(synthetic)).json();
  assert.deepEqual(response,{ok:false,code:'request_rejected'});
  assert.equal(JSON.stringify(response).includes(synthetic.credential.apiKey),false);
});

test('two probes may run independently; a disconnected request aborts its upstream work', async t => {
  const starts = [];
  const signals = [];
  const {post} = await start(t, (_kind,_credential,{signal}) => new Promise((resolve,reject) => {
    signals.push(signal); starts.shift()?.();
    signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
  }));
  const controllers = [new AbortController(),new AbortController()];
  const pending = [];
  for (const controller of controllers) {
    const started = new Promise(resolve=>starts.push(resolve));
    pending.push(post(synthetic,{signal:controller.signal}).catch(()=>null));
    await started;
  }
  assert.equal((await post(synthetic)).status,429);
  for (const controller of controllers) controller.abort();
  await Promise.all(pending);
  await Promise.all(signals.map(signal => signal.aborted ? Promise.resolve() : new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))));
  assert.ok(signals.every(signal=>signal.aborted));
});
