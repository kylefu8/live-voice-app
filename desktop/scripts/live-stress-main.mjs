import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  safeStorage,
} from 'electron';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {createServices} from '../services.mjs';
import {createStore} from '../store.mjs';
import {ErrorCode} from '../../native/src/protocol.ts';

const SCHEME = 'stress-live';
const APP_URL = `${SCHEME}://app/index.html`;
const MAX_ROUNDS = Number(process.env.LIVE_VOICE_STRESS_ROUNDS || 100);
if (!Number.isInteger(MAX_ROUNDS) || MAX_ROUNDS < 1 || MAX_ROUNDS > 100) throw new Error('stress_prompts_invalid');
const OVERALL_TIMEOUT_MS = 90 * 60 * 1000;
const SAFE_EXTRA_CODES = new Set([
  'backend_token_limit',
  'backend_content_filter',
  'stress_run_dir_missing',
  'stress_source_dir_missing',
  'stress_profile_not_ready',
  'stress_profile_request_mismatch',
  'stress_prompts_invalid',
  'stress_audio_missing',
  'stress_timeout',
  'stress_user_stop',
  'stress_renderer_gone',
  'stress_window_closed',
  'stress_ipc_denied',
  'stress_invalid_request',
  'stress_report_failed',
]);
const SAFE_CODES = new Set([...Object.values(ErrorCode), ...SAFE_EXTRA_CODES]);
const ROUND_STATUSES = new Set(['passed', 'failed', 'timeout', 'skipped']);

protocol.registerSchemesAsPrivileged([
  {scheme: SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}},
]);

class StressError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StressError';
    this.code = code;
  }
}

function fail(code) {
  throw new StressError(code);
}

function safeCode(error, fallback = 'stress_failed') {
  const candidate = error && typeof error.code === 'string'
    ? error.code
    : error && typeof error.message === 'string'
      ? error.message
      : '';
  if (SAFE_CODES.has(candidate)) return candidate;
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(candidate) && candidate.startsWith('stress_')) return candidate;
  return fallback;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pathFromEnv(name, code) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return resolve(value);
}

function boundedText(value, maximum = 80) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return null;
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) return null;
  return value;
}

function initialReport() {
  return {
    status: 'running',
    startedAt: Date.now(),
    completedRounds: 0,
    attemptedRounds: 0,
    preflightPassed: false,
    rounds: [],
    errors: [],
    firstError: '',
    confirmedClose: false,
    lifecycle: {
      rendererStarted: false,
      sessionStarted: false,
      closeRequested: false,
      closedCallback: false,
      localCleanup: false,
      confirmedClose: false,
      audioContextClosed: false,
    },
    heartbeat: {phase: 'boot', round: 0, updatedAt: Date.now()},
    metrics: {voiceRequests: 0, backendRequests: 0, backendConfigViolations: 0, backendCompleted: 0, backendCancelled: 0, backendFailed: 0, closeFallbackRequests: 0},
  };
}

const runDir = pathFromEnv('LIVE_VOICE_STRESS_RUN_DIR', 'stress_run_dir_missing');
const sourceDir = pathFromEnv('LIVE_VOICE_STRESS_SOURCE_DIR', 'stress_source_dir_missing');
const appRoot = join(runDir, 'app');
const audioRoot = join(runDir, 'audio');
const reportPath = join(runDir, 'report.json');
const promptsPath = join(runDir, 'prompts.json');

let report = initialReport();
let services = null;
let windowRef = null;
let manifest = null;
let closing = false;
let finalPrinted = false;
let overallTimer = null;
let stopPollTimer = null;
let stopSent = false;
let reportWriteTail = Promise.resolve();

app.setPath('userData', join(runDir, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function writeReport() {
  const snapshot = JSON.stringify(report, null, 2);
  const task = reportWriteTail.then(async () => {
    const temporary = `${reportPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, snapshot, {encoding: 'utf8', flag: 'w'});
      await rename(temporary, reportPath);
    } catch {
      try {
        await writeFile(reportPath, snapshot, 'utf8');
      } catch {
        throw new StressError('stress_report_failed');
      }
    }
  });
  reportWriteTail = task.catch(() => undefined);
  return task;
}

function recordError(code) {
  const safe = safeCode({code}, 'stress_failed');
  if (!report.errors.includes(safe) && report.errors.length < 64) report.errors.push(safe);
}

function sanitizeRound(value) {
  if (!isRecord(value)) fail('stress_invalid_request');
  const round = Number(value.round);
  const elapsedMs = Number(value.elapsedMs);
  const assistantFragments = Number(value.assistantFragments);
  const backendCalls = Number(value.backendCalls);
  const kind = boundedText(value.kind, 64);
  const status = typeof value.status === 'string' && ROUND_STATUSES.has(value.status) ? value.status : null;
  if (
    !Number.isInteger(round) ||
    round < 1 ||
    round > MAX_ROUNDS ||
    !kind ||
    !status ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 10 * 60 * 1000 ||
    !Number.isInteger(assistantFragments) ||
    assistantFragments < 0 ||
    assistantFragments > 10_000 ||
    !Number.isInteger(backendCalls) ||
    backendCalls < 0 ||
    backendCalls > 10_000 ||
    !Array.isArray(value.errorCodes) ||
    value.errorCodes.length > 32 ||
    ('expectedPhraseMatched' in value && typeof value.expectedPhraseMatched !== 'boolean')
  ) {
    fail('stress_invalid_request');
  }
  const errorCodes = [];
  for (const code of value.errorCodes) {
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(code)) fail('stress_invalid_request');
    if (!errorCodes.includes(code)) errorCodes.push(code);
  }
  return {
    round,
    kind,
    status,
    elapsedMs: Math.round(elapsedMs),
    assistantFragments,
    backendCalls,
    backendResults: Number.isInteger(value.backendResults) ? value.backendResults : 0,
    assistantAfterResultFragments: Number.isInteger(value.assistantAfterResultFragments) ? value.assistantAfterResultFragments : 0,
    expectedPhraseMatched: value.expectedPhraseMatched === true,
    completionPath: ['backend', 'voice_direct', 'voice_memory', 'none'].includes(value.completionPath) ? value.completionPath : 'none',
    errorCodes,
    timeline: Array.isArray(value.timeline) ? value.timeline.slice(0, 300).map(item => {
      const row = {kind: ['user', 'assistant', 'delegation'].includes(item?.kind) ? item.kind : 'unknown'};
      for (const key of ['receivedMs', 'start_ms', 'end_ms', 'offset_ms']) {
        if (typeof item?.[key] === 'number' && Number.isFinite(item[key])) row[key] = item[key];
      }
      return row;
    }) : [],
  };
}

function sanitizeLifecycle(value) {
  if (!isRecord(value)) fail('stress_invalid_request');
  const allowed = [
    'rendererStarted',
    'sessionStarted',
    'closeRequested',
    'closedCallback',
    'localCleanup',
    'confirmedClose',
    'audioContextClosed',
  ];
  const result = {};
  for (const key of allowed) {
    if (key in value && typeof value[key] !== 'boolean') fail('stress_invalid_request');
    if (key in value) result[key] = value[key];
  }
  return result;
}

function sanitizeProgress(value) {
  if (!isRecord(value)) fail('stress_invalid_request');
  const phase = boundedText(value.phase, 64);
  const round = Number(value.round ?? 0);
  if (!phase || !Number.isInteger(round) || round < 0 || round > MAX_ROUNDS) fail('stress_invalid_request');
  return {
    phase, round,
    backendStatus: ['idle', 'working', 'done', 'error'].includes(value.backendStatus) ? value.backendStatus : null,
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.max(0, Math.round(value.elapsedMs)) : null,
  };
}

function upsertRound(value) {
  const index = report.rounds.findIndex(item => item.round === value.round);
  if (index >= 0) report.rounds[index] = value;
  else report.rounds.push(value);
  report.rounds.sort((left, right) => left.round - right.round);
  report.attemptedRounds = report.rounds.length;
  report.completedRounds = report.rounds.filter(item => item.status !== 'skipped').length;
}

function mergeLifecycle(value) {
  for (const [key, item] of Object.entries(value)) report.lifecycle[key] = item;
  report.confirmedClose = report.lifecycle.confirmedClose === true;
}

async function readManifest(settings) {
  let value;
  try {
    value = JSON.parse(await readFile(promptsPath, 'utf8'));
  } catch {
    fail('stress_prompts_invalid');
  }
  if (!Array.isArray(value) || value.length !== MAX_ROUNDS) fail('stress_prompts_invalid');
  const rounds = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const round = Number(item?.round);
    const kind = boundedText(item?.kind, 64);
    const file = typeof item?.file === 'string' ? item.file : '';
    if (
      !Number.isInteger(round) ||
      round !== index + 1 ||
      !kind ||
      !file ||
      file !== file.split(/[\\/]/u).at(-1) ||
      !/^[A-Za-z0-9_.-]{1,128}\.wav$/u.test(file)
    ) {
      fail('stress_prompts_invalid');
    }
    try {
      const fileInfo = await stat(join(audioRoot, file));
      if (!fileInfo.isFile()) fail('stress_audio_missing');
    } catch {
      fail('stress_audio_missing');
    }
    const expectedPhrase = typeof item?.expectedPhrase === 'string' && item.expectedPhrase.length <= 128
      ? item.expectedPhrase
      : '';
    rounds.push({round, kind, file, expectedPhrase});
  }
  return {
    mode: settings.mode === 'general' ? 'general' : 'practice',
    locale: settings.locale === 'en' ? 'en' : 'zh',
    idleBeforeCloseMs: Math.min(120_000, Math.max(0, Number(process.env.LIVE_VOICE_STRESS_IDLE_BEFORE_CLOSE_MS) || 0)),
    suppressPrimaryClose: process.env.LIVE_VOICE_STRESS_SUPPRESS_PRIMARY_CLOSE === '1',
    rounds,
  };
}

function responseForError(error) {
  return {ok: false, code: safeCode(error, 'stress_failed')};
}

function validSender(event) {
  return Boolean(
    windowRef &&
    !windowRef.isDestroyed() &&
    event.sender === windowRef.webContents &&
    event.senderFrame === windowRef.webContents.mainFrame &&
    event.senderFrame.url === APP_URL,
  );
}

function wrapFetch(realFetch) {
  return async (url, init = {}) => {
    let nextInit = init;
    try {
      const parsed = new URL(String(url));
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'POST' && parsed.pathname.endsWith('/responses')) {
        report.metrics.backendRequests += 1;
        try {
          const body = JSON.parse(String(init.body || '{}'));
          if (body.max_output_tokens !== 32_768 || body.reasoning?.effort !== 'max') {
            report.metrics.backendConfigViolations += 1;
          }
        } catch {
          report.metrics.backendConfigViolations += 1;
        }
      }
      if (method === 'POST' && parsed.pathname.endsWith('/live/sessions') && typeof init.body === 'string') {
        report.metrics.voiceRequests += 1;
        const body = JSON.parse(init.body);
        if (isRecord(body) && isRecord(body.session) && typeof body.session.instructions === 'string') {
          body.session.instructions = `${body.session.instructions}\n\nThis is a controlled conversation test. For every user question delegate to the client reasoning backend; after result respond in 1-2 short sentences. Do not speak unsolicited before the first question.`;
          nextInit = {...init, body: JSON.stringify(body)};
        }
      }
    } catch {
      // Keep the provider request behavior unchanged if the request is not the
      // JSON session creation request we own.
    }
    return realFetch(url, nextInit);
  };
}

async function closeHarness() {
  if (closing) return;
  closing = true;
  if (overallTimer) clearTimeout(overallTimer);
  if (stopPollTimer) clearInterval(stopPollTimer);
  try {
    await services?.dispose?.();
  } catch {
    recordError('stress_report_failed');
  }
  if (!finalPrinted) {
    finalPrinted = true;
    process.stdout.write(
      `STRESS_DONE status=${report.status} completedRounds=${report.completedRounds} confirmedClose=${report.confirmedClose ? 'true' : 'false'}\n`,
    );
  }
  if (windowRef && !windowRef.isDestroyed()) windowRef.destroy();
  app.quit();
}

async function finishFromRenderer(value = {}) {
  report.closeDiagnostics = Array.isArray(value.closeDiagnostics) ? value.closeDiagnostics.slice(0, 40).map(item => ({
    type: typeof item?.type === 'string' && /^[a-z_.]{1,80}$/.test(item.type) ? item.type : 'unknown',
    elapsedMs: Number.isFinite(item?.elapsedMs) ? Math.round(item.elapsedMs) : null,
    bytes: Number.isFinite(item?.bytes) ? item.bytes : null,
    bufferedAmount: Number.isFinite(item?.bufferedAmount) ? item.bufferedAmount : null,
  })) : [];
  let status = value.status === 'completed' ? 'completed' : 'failed';
  for (const code of Array.isArray(value.errorCodes) ? value.errorCodes.slice(0, 64) : []) {
    if (typeof code === 'string') recordError(code);
  }
  if (typeof value.firstError === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value.firstError)) {
    report.firstError = value.firstError;
    recordError(value.firstError);
  }
  if (status === 'completed' && (report.metrics.backendRequests === 0 || report.metrics.backendConfigViolations > 0)) {
    recordError('stress_profile_request_mismatch');
    status = 'failed';
  }
  report.status = status;
  if (typeof value.confirmedClose === 'boolean') {
    report.confirmedClose = value.confirmedClose;
    report.lifecycle.confirmedClose = value.confirmedClose;
  }
  if (isRecord(value.lifecycle)) mergeLifecycle(sanitizeLifecycle(value.lifecycle));
  await writeReport();
  setImmediate(() => void closeHarness());
  return null;
}

async function initialize() {
  await mkdir(runDir, {recursive: true});
  await mkdir(appRoot, {recursive: true});
  const sourceInfo = await stat(sourceDir).catch(() => null);
  if (!sourceInfo?.isDirectory()) fail('stress_source_dir_missing');
  report = initialReport();
  await writeReport();

  const realFetch = globalThis.fetch.bind(globalThis);
  const preflightStore = await createStore({dataDir: sourceDir, safeStorage});
  const preflightSettings = await preflightStore.loadSettings();
  await preflightStore.dispose();
  if (
    !preflightSettings?.backend?.enabled ||
    preflightSettings.backend.maxOutputTokens !== 32_768 ||
    preflightSettings.backend.effort !== 'max'
  ) {
    fail('stress_profile_not_ready');
  }
  services = await createServices({
    dataDir: sourceDir,
    safeStorage,
    fetchImpl: wrapFetch(realFetch),
  });
  manifest = await readManifest(preflightSettings);

  await protocol.handle(SCHEME, async request => {
    const url = new URL(request.url);
    if (url.host !== 'app' || url.search || url.hash || request.method !== 'GET') {
      return new Response('', {status: 404});
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/index.html' || pathname === '/renderer.js') {
      const name = pathname.slice(1);
      const response = await net.fetch(pathToFileURL(join(appRoot, name)).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
      return new Response(response.body, {status: response.status, headers});
    }
    if (pathname.startsWith('/audio/')) {
      const file = pathname.slice('/audio/'.length);
      if (!manifest.rounds.some(item => item.file === file)) return new Response('', {status: 404});
      const audioPath = resolve(audioRoot, file);
      const rel = relative(audioRoot, audioPath);
      if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.includes('/') || rel.includes('\\')) {
        return new Response('', {status: 404});
      }
      const response = await net.fetch(pathToFileURL(audioPath).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'audio/wav');
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, {status: response.status, headers});
    }
    return new Response('', {status: 404});
  });

  const preload = join(appRoot, 'preload.cjs');
  windowRef = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  windowRef.removeMenu();
  windowRef.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  windowRef.webContents.on('will-navigate', event => event.preventDefault());
  windowRef.webContents.on('render-process-gone', () => {
    if (!closing) {
      report.status = 'failed';
      recordError('stress_renderer_gone');
      void writeReport().finally(() => void closeHarness());
    }
  });

  const handlers = {
    async getManifest() {
      return clone(manifest);
    },
    async createSession(args) {
      const value = await services.createSession(args);
      const result = clone(value);
      if (result?.settings?.voice) result.settings.voice.minutes = 0;
      return result;
    },
    cancelSession: args => services.cancelSession(args),
    finalizeSession: args => { report.metrics.closeFallbackRequests += 1; return services.finalizeSession(args); },
    async runBackend(args) {
      try {
        const result = await services.runBackend(args);
        report.metrics.backendCompleted += 1;
        return result;
      } catch (error) {
        if (safeCode(error) === 'backend_aborted') report.metrics.backendCancelled += 1;
        else report.metrics.backendFailed += 1;
        throw error;
      }
    },
    cancelBackend: args => services.cancelBackend(args),
    async recordProgress(args) {
      const progress = sanitizeProgress(args);
      report.heartbeat = {...progress, updatedAt: Date.now()};
      if (progress.phase === 'starting') report.preflightPassed = true;
      await writeReport();
      return null;
    },
    async recordRound(args) {
      const round = sanitizeRound(args);
      upsertRound(round);
      for (const code of round.errorCodes) recordError(code);
      report.heartbeat = {phase: 'round-recorded', round: round.round, updatedAt: Date.now()};
      await writeReport();
      return null;
    },
    async recordLifecycle(args) {
      mergeLifecycle(sanitizeLifecycle(args));
      await writeReport();
      return null;
    },
    finish: finishFromRenderer,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`stress-live:${name}`, async (event, args) => {
      if (!validSender(event)) return responseForError(new StressError('stress_ipc_denied'));
      try {
        return {ok: true, value: await handler(args)};
      } catch (error) {
        const code = safeCode(error);
        recordError(code);
        return {ok: false, code};
      }
    });
  }

  overallTimer = setTimeout(() => {
    if (closing || !windowRef || windowRef.isDestroyed() || stopSent) return;
    stopSent = true;
    recordError('stress_timeout');
    windowRef.webContents.send('stress-live:stop', {code: 'stress_timeout'});
  }, OVERALL_TIMEOUT_MS);

  stopPollTimer = setInterval(async () => {
    if (closing || stopSent || !windowRef || windowRef.isDestroyed()) return;
    try {
      const marker = await stat(join(runDir, 'stop.request'));
      if (marker.isFile()) {
        stopSent = true;
        recordError('stress_user_stop');
        windowRef.webContents.send('stress-live:stop', {code: 'stress_user_stop'});
      }
    } catch {
      // The marker is optional; absence is the normal state.
    }
  }, 2_000);

  await windowRef.loadURL(APP_URL);
  report.lifecycle.rendererStarted = true;
  await writeReport();
  process.stdout.write(`STRESS_READY rounds=${manifest.rounds.length}\n`);
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.whenReady()
    .then(initialize)
    .catch(async error => {
      report.status = 'failed';
      recordError(safeCode(error));
      try {
        await mkdir(runDir, {recursive: true});
        await writeReport();
      } catch {
        // Keep startup output fixed-code only.
      }
      if (!finalPrinted) {
        finalPrinted = true;
        process.stdout.write(`STRESS_FAILED code=${safeCode(error)}\n`);
      }
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (!closing) void closeHarness();
  });
  app.on('before-quit', () => {
    if (!closing) void closeHarness();
  });
}
