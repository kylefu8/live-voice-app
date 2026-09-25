import assert from 'node:assert/strict';
import {createHash, createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {createServices} from '../services.mjs';

const key = createHash('sha256').update('desktop-services-test-key').digest();

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const iv = value.subarray(0, 12);
      const tag = value.subarray(-16);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

const settings = {
  locale: 'en',
  theme: 'system',
  mode: 'practice',
  voice: {voice: 'marin', tone: 'natural', intonation: 'natural', pace: 'normal', minutes: 0, instructions: ''},
  backend: {enabled: true, effort: 'max', maxOutputTokens: 256, webSearch: true, timeoutSeconds: 20, instructions: ''},
};

function messageResponse(text = 'Backend answer') {
  return {
    status: 'completed',
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}],
  };
}

function titleResponse(text = 'A useful conversation title') {
  return {
    status: 'completed',
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}],
  };
}

function voiceResponse() {
  return {session: {id: 'session-1'}, transport: {type: 'webrtc', sdp: 'answer-sdp'}};
}

function record() {
  return {
    id: 'session-record',
    mode: 'practice',
    startedAt: 1_700_000_000_000,
    durationSeconds: 2,
    confirmedClose: true,
    fragments: [{role: 'user', text: 'How do I sound?', startMs: 0, endMs: 400}],
  };
}

async function withServices(options, callback) {
  const dataDir = await mkdtemp(join(tmpdir(), 'live-voice-services-'));
  let services;
  try {
    services = await createServices({dataDir, safeStorage: secureStorage(), ...options});
    return await callback(services, dataDir);
  } finally {
    await services?.dispose();
    await rm(dataDir, {recursive: true, force: true});
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test_wait_timeout');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('connection tests use draft credentials, cancellation is scoped, and keys never return', async () => {
  await withServices({
    probeImpl: async (kind, credential, {signal}) => {
      assert.equal(kind, 'voice');
      assert.equal(credential.apiKey, 'voice-secret');
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) throw Object.assign(new Error('cancelled'), {code: 'cancelled'});
      return {ok: true, code: 'voice_ok', durationMs: 4};
    },
  }, async (services) => {
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    const pending = services.testConnection({
      requestId: 'voice-test',
      kind: 'voice',
      credential: {endpoint: 'https://voice.example.test/v1/', model: 'gpt-live-1', auth: 'bearer', apiKey: ''},
    });
    await services.cancelTest({requestId: 'voice-test'});
    await assert.rejects(pending, (error) => error.code === 'test_cancelled');
    const result = await services.testConnection({
      requestId: 'voice-test-2',
      kind: 'voice',
      credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'},
    });
    assert.deepEqual(result, {ok: true, code: 'voice_ok', durationMs: 4});
    assert.equal(JSON.stringify(result).includes('voice-secret'), false);
  });
});

test('session snapshot and backend delegation stay in main-side services', async () => {
  await withServices({}, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    const requests = [];
    // Replace the fetch implementation at construction in a separate test;
    // the default path is covered by the cancellation case below.
    assert.equal((await services.bootstrap()).connections.voice.keyMask, 'voic••••••cret');
    assert.equal((await services.bootstrap()).connections.backend.keyMask, 'back••••••cret');
    assert.equal(JSON.stringify(await services.bootstrap()).includes('voice-secret'), false);
    assert.equal(requests.length, 0);
  });
});

test('session creation cancels late responses and a fresh attempt can start', async () => {
  let resolveFetch;
  const fetchImpl = async (url) => {
    if (url.endsWith('/live/sessions')) {
      return new Promise((resolve) => {
        resolveFetch = () => resolve({status: 200, text: async () => JSON.stringify(voiceResponse())});
      });
    }
    return {status: 200, text: async () => JSON.stringify(messageResponse())};
  };
  await withServices({fetchImpl}, async (services) => {
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    const pending = services.createSession({attemptId: 'attempt-1', sdp: 'offer-sdp', mode: 'practice'});
    await services.cancelSession({attemptId: 'attempt-1'});
    await assert.rejects(pending, (error) => error.code === 'session_cancelled');
    // A legacy renderer may still send practice; the new session snapshot is
    // always the single general conversation mode.
    const next = services.createSession({attemptId: 'attempt-2', sdp: 'offer-sdp', mode: 'practice'});
    await waitFor(() => typeof resolveFetch === 'function');
    resolveFetch();
    const result = await next;
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.settings.mode, 'general');
    assert.equal(JSON.stringify(result).includes('voice-secret'), false);
    await services.cancelSession({attemptId: 'attempt-2'});
  });
});

test('backend delegation sends bounded Responses settings and extracts text and sources', async () => {
  let captured;
  await withServices({
    fetchImpl: async (url, init) => {
      captured = {url, init};
      if (url.endsWith('/live/sessions')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      return {
        status: 200,
        text: async () => JSON.stringify({
          ...messageResponse('Here is the answer.'),
          output: [
            ...messageResponse('Here is the answer.').output,
            {type: 'web_search_call', status: 'completed', action: {sources: [{title: 'Example', url: 'https://example.test/page'}]}},
          ],
        }),
      };
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.createSession({attemptId: 'attempt-backend', sdp: 'offer-sdp', mode: 'practice'});
    const result = await services.runBackend({attemptId: 'attempt-backend', delegationId: 'delegation-1', history: [
      {role: 'user', text: 'Find an example.', startMs: 0, endMs: 200},
    ]});
    assert.equal(result.text, 'Here is the answer.');
    assert.deepEqual(result.sources, [{title: 'Example', url: 'https://example.test/page'}]);
    const request = JSON.parse(captured.init.body);
    assert.equal(request.store, false);
    assert.equal(request.reasoning.effort, 'max');
    assert.equal(request.tools[0].type, 'web_search');
    assert.equal(captured.init.headers['api-key'], 'backend-secret');
    await services.cancelSession({attemptId: 'attempt-backend'});
  });
});

test('backend history keeps a long conversation instead of silently dropping older turns', async () => {
  let captured;
  await withServices({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/live/sessions')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      captured = JSON.parse(init.body);
      return {status: 200, text: async () => JSON.stringify(messageResponse())};
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.createSession({attemptId: 'long-history', sdp: 'offer-sdp', mode: 'practice'});
    const history = [];
    for (let turn = 1; turn <= 120; turn += 1) {
      history.push({role: 'user', text: `Question ${turn}`});
      history.push({role: 'assistant', text: `Answer ${turn}`});
    }
    await services.runBackend({attemptId: 'long-history', delegationId: 'long-history-delegation', history});
    assert.equal(captured.input.length, 240);
    assert.equal(captured.input[0].content, 'Question 1');
    assert.equal(captured.input.at(-1).content, 'Answer 120');
    assert.equal(captured.input.find((item) => item.content === 'Question 120')?.role, 'user');
    await services.cancelSession({attemptId: 'long-history'});
  });
});

test('backend history trims by UTF-8 bytes while preserving the first anchor and latest question', async () => {
  let captured;
  await withServices({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/live/sessions')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      captured = JSON.parse(init.body);
      return {status: 200, text: async () => JSON.stringify(messageResponse())};
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.createSession({attemptId: 'utf8-history', sdp: 'offer-sdp', mode: 'practice'});
    const history = [];
    for (let index = 0; index < 499; index += 1) {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      const label = index === 0 ? '最早的锚点' : index === 498 ? '最后的问题' : `第${index}条`;
      history.push({role, text: `${label}：${'汉'.repeat(1_000)}`});
    }
    await services.runBackend({attemptId: 'utf8-history', delegationId: 'utf8-history-delegation', history});
    const inputBytes = Buffer.byteLength(JSON.stringify(captured.input), 'utf8');
    assert.ok(inputBytes <= 256 * 1024);
    assert.ok(captured.input.length < history.length);
    assert.equal(captured.input[0].content.startsWith('最早的锚点：'), true);
    assert.equal(captured.input.at(-1).content.startsWith('最后的问题：'), true);
    await services.cancelSession({attemptId: 'utf8-history'});
  });
});

test('backend history rejects malformed input and arrays beyond the bounded history limit', async () => {
  let backendRequests = 0;
  await withServices({
    fetchImpl: async (url) => {
      if (url.endsWith('/live/sessions')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      backendRequests += 1;
      return {status: 200, text: async () => JSON.stringify(messageResponse())};
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.createSession({attemptId: 'invalid-history', sdp: 'offer-sdp', mode: 'practice'});
    await assert.rejects(
      services.runBackend({attemptId: 'invalid-history', delegationId: 'malformed-history', history: [null, {role: 'system', text: 'ignored'}, {role: 'assistant', text: ''}]}),
      (error) => error.code === 'backend_no_input',
    );
    await assert.rejects(
      services.runBackend({attemptId: 'invalid-history', delegationId: 'oversized-history', history: Array.from({length: 501}, () => ({role: 'user', text: 'ignored'}))}),
      (error) => error.code === 'backend_no_input',
    );
    assert.equal(backendRequests, 0);
    await services.cancelSession({attemptId: 'invalid-history'});
  });
});

test('close fallback is attempt-scoped, single-flight, and uses the original main-process credential snapshot', async () => {
  const calls = [];
  let finish;
  await withServices({
    fetchImpl: async () => ({status: 200, text: async () => JSON.stringify(voiceResponse())}),
    confirmCloseImpl: args => { calls.push(args); return new Promise(resolve => { finish = resolve; }); },
  }, async services => {
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    await services.createSession({attemptId: 'owned-session', sdp: 'offer', mode: 'general'});
    await assert.rejects(services.finalizeSession({attemptId: 'other-session'}), error => error.code === 'session_cancelled');
    const first = services.finalizeSession({attemptId: 'owned-session', endpoint: 'https://untrusted.invalid', sessionId: 'untrusted'});
    const second = services.finalizeSession({attemptId: 'owned-session'});
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].endpoint, 'https://voice.example.test/v1');
    assert.equal(calls[0].sessionId, 'session-1');
    assert.equal(calls[0].apiKey, 'voice-secret');
    finish({confirmed: true});
    assert.deepEqual(await first, {confirmed: true});
    assert.deepEqual(await second, {confirmed: true});
    await services.cancelSession({attemptId: 'owned-session'});
    assert.equal(calls[0].signal.aborted, true);
  });
});

test('exportQr reads secure credentials without returning them', async () => {
  await withServices({}, async (services) => {
    await services.saveConnection({kind: 'voice', credential: {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', apiKey: 'voice-secret'}});
    const result = await services.exportQr({kinds: ['voice'], passphrase: '1234'});
    assert.equal(result.kinds[0], 'voice');
    assert.match(result.payload, /^LV1\./u);
    assert.equal(JSON.stringify(result).includes('voice-secret'), false);
  });
});

test('backend incomplete reasons become fixed actionable errors without exposing response details', async () => {
  for(const [reason,code] of [['max_output_tokens','backend_token_limit'],['content_filter','backend_content_filter'],['unrecognized-private-detail','backend_incomplete']]) {
    await withServices({fetchImpl:async url=>({status:200,text:async()=>JSON.stringify(url.endsWith('/live/sessions')?voiceResponse():{status:'incomplete',incomplete_details:{reason},output:[]})})},async services=>{
      for(const kind of ['voice','backend'])await services.saveConnection({kind,credential:{endpoint:`https://${kind}.example.test/v1`,model:'test-model',auth:'bearer',apiKey:'synthetic-key'}});
      await services.saveSettings({settings});
      await services.createSession({attemptId:'incomplete-test',sdp:'offer-sdp',mode:'general'});
      await assert.rejects(services.runBackend({attemptId:'incomplete-test',delegationId:'delegation-test',history:record().fragments}),error=>error.code===code&&error.message===code);
      await services.cancelSession({attemptId:'incomplete-test'});
    });
  }
});

test('history is saved before optional auto-naming and a manual rename wins a late result', async () => {
  let titleRequest = false;
  let resolveTitle;
  await withServices({
    fetchImpl: async (url) => {
      if (!url.endsWith('/responses')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      titleRequest = true;
      return new Promise(resolve => { resolveTitle = () => resolve({status: 200, text: async () => JSON.stringify(titleResponse())}); });
    },
  }, async (services) => {
    await services.saveSettings({settings: {...settings, backend: {...settings.backend, webSearch: false}}});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    const saved = await services.saveHistory({record: record()});
    assert.equal(saved[0].title, undefined);
    await waitFor(() => titleRequest);
    await services.renameHistory({id: 'session-record', title: '用户命名'});
    resolveTitle();
    await new Promise(resolve => setTimeout(resolve, 30));
    const history = await services.loadHistory();
    assert.equal(history[0].title, '用户命名');
    assert.equal(history[0].titleSource, 'manual');
  });
});

test('auto-naming is skipped for disabled or missing backend and failures do not block saving', async () => {
  let requests = 0;
  await withServices({
    fetchImpl: async () => {
      requests += 1;
      throw new Error('title_transport_failed');
    },
  }, async (services) => {
    const disabled = await services.saveHistory({record: record()});
    assert.equal(disabled.length, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests, 0);
    await services.saveSettings({settings});
    const missing = await services.saveHistory({record: {...record(), id: 'missing-backend'}});
    assert.equal(missing.length, 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests, 0);
  });
});

test('deleting a record cancels title work and cannot be undone by its late response', async () => {
  let resolveTitle;
  let titleRequest = false;
  await withServices({
    fetchImpl: async (url) => {
      if (!url.endsWith('/responses')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      titleRequest = true;
      return new Promise(resolve => { resolveTitle = () => resolve({status: 200, text: async () => JSON.stringify(titleResponse('late title'))}); });
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.saveHistory({record: record()});
    await waitFor(() => titleRequest);
    await services.deleteHistory({id: 'session-record'});
    resolveTitle();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await services.loadHistory(), []);
  });
});

test('duplicate saves do not schedule a second title request', async () => {
  let requests = 0;
  let rejectTitle;
  await withServices({
    fetchImpl: async (url) => {
      if (!url.endsWith('/responses')) return {status: 200, text: async () => JSON.stringify(voiceResponse())};
      requests += 1;
      return new Promise((_resolve, reject) => { rejectTitle = reject; });
    },
  }, async (services) => {
    await services.saveSettings({settings});
    await services.saveConnection({kind: 'backend', credential: {endpoint: 'https://backend.example.test/v1', model: 'reasoning-mini', auth: 'api-key', apiKey: 'backend-secret'}});
    await services.saveHistory({record: record()});
    await services.saveHistory({record: record()});
    await waitFor(() => requests === 1);
    rejectTitle(new Error('cancelled_by_test'));
  });
});

test('explicit backend hot save affects next request and preserves in-flight snapshot', async () => {
  const bodies=[];let release;
  await withServices({fetchImpl:async(url,init)=>{
    if(url.endsWith('/live/sessions'))return {status:200,text:async()=>JSON.stringify(voiceResponse())};
    bodies.push(JSON.parse(init.body));
    if(bodies.length===1)await new Promise(resolve=>{release=resolve;});
    return {status:200,text:async()=>JSON.stringify(messageResponse())};
  }},async services=>{
    await services.saveSettings({settings});
    for(const kind of ['voice','backend'])await services.saveConnection({kind,credential:{endpoint:`https://${kind}.example.test/v1`,model:kind==='voice'?'gpt-live-1':'reasoning-mini',auth:'bearer',apiKey:'synthetic-secret'}});
    await services.createSession({attemptId:'hot',sdp:'offer-sdp',mode:'general'});
    const args={attemptId:'hot',history:[{role:'user',text:'Hello'}]};
    const first=services.runBackend({...args,delegationId:'one'});await waitFor(()=>release);
    const next={...settings,backend:{...settings.backend,effort:'low',maxOutputTokens:32768,webSearch:false}};
    await services.saveSettings({settings:next,applyBackendToSession:true});
    release();await first;
    assert.equal(bodies[0].reasoning.effort,'max');assert.equal(bodies[0].max_output_tokens,256);
    await services.runBackend({...args,delegationId:'two'});
    assert.equal(bodies[1].reasoning.effort,'low');assert.equal(bodies[1].max_output_tokens,32768);assert.equal(bodies[1].tools,undefined);
    await services.saveSettings({settings});
    await services.runBackend({...args,delegationId:'three'});
    assert.equal(bodies[2].reasoning.effort,'low');
  });
});
