import { encryptConfig, validateConfig } from './crypto.mjs';
import { drawQr } from './qr.mjs';

const $ = id => document.getElementById(id);
let locale = 'zh';
let revision = 0;
let busy = false;
let resultKinds = [];
let statusKey = '';
let statusError = false;
let downloadUrl;
const tests = {voice:{request:null,code:'',state:'',durationMs:null},backend:{request:null,code:'',state:'',durationMs:null}};
const strings = {
  brandNote:['设备配置','DEVICE SETUP'],appearance:['外观','Appearance'],system:['跟随系统','System'],light:['浅色','Light'],dark:['深色','Dark'],eyebrow:['从电脑到手机','FROM DESKTOP TO PHONE'],title:['扫码，让对话开始。','A scan away from conversation.'],intro:['填好连接信息，用一段口令加密，再交给你的手机。','Add your connections, encrypt them with a passphrase, then take them to your phone.'],
  milestone:['Android 0.2.0 及以上版本：打开“设置 → 扫码导入连接”，扫描后输入口令。','Android 0.2.0 or later: open Settings → Import connections from QR, scan, then enter your passphrase.'],connections:['选择连接配置','Choose your connections'],connectionHint:['可单独配置，也可一次带上两组。','Include either connection, or bring both together.'],voice:['语音模型','Voice model'],backend:['后端模型','Backend model'],endpoint:['服务地址 · Endpoint','Service endpoint'],model:['模型 / 部署名称','Model / deployment name'],auth:['鉴权方式','Authentication'],endpointHint:['填写完整 HTTPS API 基础地址；鉴权方式按服务商要求选择。生成二维码不会测试或访问这些地址。','Enter the complete HTTPS API base URL and your provider’s authentication method. Generating a QR code does not test or contact these addresses.'],passwordTitle:['设置导入口令','Choose an import passphrase'],passwordHint:['手机导入时输入同一段口令。','Enter the same passphrase when importing on your phone.'],password:['导入口令','Import passphrase'],confirm:['再输入一次','Confirm passphrase'],strength:['口令至少 4 个字符。请将口令与二维码分开保管。','Use at least 4 characters. Keep the passphrase separately from your QR code.'],shortPassword:['请至少输入 4 个字符。','Enter at least 4 characters.'],generate:['生成加密二维码','Generate encrypted QR'],generating:['正在本机加密…','Encrypting locally…'],clear:['全部清空','Clear everything'],example:['没有配置？填入一组虚构示例试试','Just exploring? Fill in fictional sample connections'],scanTitle:['交给你的手机','Ready for your phone'],local:['仅在本机加密','ENCRYPTED LOCALLY'],emptyTitle:['二维码将在这里出现','Your QR code will appear here'],emptyHint:['填写左侧配置后，点击生成。','Complete the form, then generate your code.'],download:['保存二维码 PNG','Save QR as PNG'],hideQr:['隐藏并清除二维码','Hide and clear QR'],step1:['生成二维码，留在电脑屏幕上。','Generate a QR code and leave it on screen.'],step2:['在 Android 0.2.0 及以上版本中，打开“设置 → 扫码导入连接”。','On Android 0.2.0 or later, open Settings → Import connections from QR.'],step3:['输入口令，核对地址，再测试并保存。','Enter the passphrase, review the addresses, then test and save.'],privacyTitle:['配置只留在当前页面','Your configuration stays in this page'],privacy:['没有上传、账号或浏览器保存。清空或关闭页面会丢弃填写内容；下载的二维码文件需自行保管。','No uploads, accounts or browser storage. Clearing or closing the page discards the form; keep downloaded QR files safe.'],revoke:['二维码可重复导入；撤销访问请在服务商处更换或停用 API key。','QR codes can be imported again. To revoke access, rotate or disable the API key with your provider.'],footer:['手机直连模型服务 · 电脑无需保持运行','Your phone connects directly · Your computer can be turned off'],
  invalid_config:['请至少选择一组连接，并完整填写配置。','Select at least one connection and complete its fields.'],invalid_endpoint:['请填写有效的 HTTPS 基础地址，不含账号、查询参数或 # 片段。','Use a valid HTTPS base URL without credentials, query parameters or fragments.'],invalid_model:['请填写有效的模型或部署名称。','Enter a valid model or deployment name.'],invalid_key:['请填写完整 API key，不能使用已遮罩的文字。','Enter the complete API key, not a masked value.'],invalid_passphrase:['导入口令至少 4 个字符，不能全部为空格。','Use an import passphrase of at least 4 characters, not only whitespace.'],mismatch:['两次输入的导入口令不一致。','The two passphrases do not match.'],payload_too_large:['配置超出单个二维码容量。请分开生成语音和后端配置，或精简地址与模型名称；不要截短 API key。','This configuration is too large for one QR code. Generate the voice and backend separately, or shorten addresses and model names. Do not truncate API keys.'],failed:['生成失败，请检查填写内容后重试。','Generation failed. Check your entries and try again.'],ready:['二维码已生成，口令没有包含在二维码中。','Your QR code is ready. It does not contain the passphrase.'],cleared:['已清空填写内容与二维码。','The form and QR code have been cleared.'],sample:['已填入虚构示例。请自行设置一个导入口令。','Fictional samples are filled in. Choose your own import passphrase.'],unsupported:['此浏览器不支持本地加密，请用新版 Edge 或 Chrome 打开本机地址。','Local encryption is unavailable. Open this local address in a current Edge or Chrome browser.'],saveFailed:['图片保存失败，请重新生成后再试。','Could not save the image. Generate it again and retry.'],hidden:['二维码已清除，填写内容仍在本页。','The QR code is cleared. Your form entries remain in this page.'],masked:['用于确认','For confirmation'],result:['已加密：','Encrypted: '],qrLabel:['加密连接配置二维码','Encrypted connection configuration QR code'],previewLabel:['二维码预览','QR preview']
};
Object.assign(strings, {
  privacyTitle:['配置不作持久保存','No configuration is persisted'],
  privacy:['生成二维码只在浏览器内完成。仅点击测试时，连接配置临时交给本机程序并请求所填服务，不记录密钥。清空或关闭页面会丢弃填写内容；下载文件需自行保管。','QR generation stays in your browser. Only when you click Test are the connection details sent temporarily to the local program, which contacts your chosen service without logging keys. Clear or close the page to discard entries; keep downloaded files safe.'],
  testVoice:['测试语音连接','Test voice connection'],testBackend:['测试后端连接','Test backend connection'],cancelTest:['取消测试','Cancel test'],
  probeNotice:['点击测试后，本机程序会携带当前 API key 请求所填服务，可能产生少量用量。语音测试不录音；配置不保存。','Testing sends the current API key from this local program to the service you entered and may incur usage. Voice testing does not record audio. Configuration is not saved.'],
  testing:['正在验证连接…','Checking connection…'],voice_ok:['语音会话已建立并确认关闭；未测试录音、播放或手机网络。','Voice session started and closure confirmed. Audio and phone connectivity were not tested.'],backend_ok:['已收到有效模型响应；未验证搜索工具或手机网络。','A valid model response was received. Search tools and phone connectivity were not tested.'],
  auth_failed:['鉴权失败，请检查 API key 和鉴权方式。','Authentication failed. Check the API key and authentication method.'],access_denied:['服务拒绝访问，请检查账号或模型权限。','Access denied. Check account and model permissions.'],model_unavailable:['服务报告模型不存在或不可用，请检查模型/部署名称及权限。','The service reports the model is unavailable. Check its model/deployment name and permissions.'],endpoint_not_found:['接口不存在，请检查基础地址与服务协议。','Endpoint not found. Check the base URL and supported protocol.'],request_rejected:['服务不接受此测试请求，请检查配置及协议支持。','The service rejected this test request. Check configuration and protocol support.'],rate_limited:['请求受限，请检查配额，稍后重试。','Request rate or quota limit reached. Check quota and retry later.'],service_unavailable:['服务暂时不可用，请稍后重试。','Service unavailable. Try again later.'],network_error:['无法连接服务，请检查地址、网络或证书。','Could not reach the service. Check the address, network and certificate.'],timeout:['测试超时，请检查服务和网络后重试。','Test timed out. Check the service and network, then retry.'],cancelled:['测试已取消，本机已停止等待。','Test cancelled; local waiting has stopped.'],invalid_response:['未收到预期的协议响应，尚未验证通过。','No valid protocol response was received; the test has not passed.'],response_incomplete:['模型响应未完成，尚未验证通过。','The model response was incomplete; the test has not passed.'],close_unconfirmed:['已建立语音会话，但服务未确认关闭；请检查服务端状态。','Voice session started, but the service did not confirm closure. Check the service status.'],redirect_refused:['服务返回重定向；为避免转发密钥，请填写最终服务地址。','The service redirected the request. Enter its final endpoint so the key is not forwarded.'],probe_busy:['已有测试在进行，请稍后再试。','Other tests are running. Try again shortly.'],test_failed:['测试未完成，请确认本机工具正在运行后重试。','The test could not finish. Check that the local tool is running and retry.'],elapsed:['耗时','Elapsed']
});
const t = key => (strings[key] ?? strings.failed)[locale === 'zh' ? 0 : 1];

function renderTest(kind) {
  const test = tests[kind];
  $(`test-${kind}`).textContent = t(test.request ? 'cancelTest' : kind === 'voice' ? 'testVoice' : 'testBackend');
  const result = $(`${kind}-test-result`);
  result.dataset.state = test.state;
  result.textContent = test.code ? t(test.code) + (test.durationMs !== null ? ` ${t('elapsed')} ${(test.durationMs/1000).toFixed(1)}s` : '') : '';
}
function cancelTest(kind, show = false) {
  const test = tests[kind];
  const request = test.request;
  test.request = null;
  request?.abort();
  test.code = show ? 'cancelled' : ''; test.state = ''; test.durationMs = null;
  renderTest(kind);
}
function invalidateTestFor(target) {
  for (const kind of ['voice','backend']) {
    if (target?.closest(`#${kind}-fields`) || target === $(`include-${kind}`)) cancelTest(kind);
  }
}
async function testConnection(kind) {
  const test = tests[kind];
  if (test.request) { cancelTest(kind,true); return; }
  cancelTest(kind);
  let credential;
  try {
    credential = validateConfig({version:1,connections:{[kind]:readCredential(kind)}}).connections[kind];
  } catch (error) {
    test.code = strings[error.message] ? error.message : 'test_failed'; test.state = 'error'; renderTest(kind); return;
  }
  const request = new AbortController();
  test.request = request; test.code = 'testing'; test.state = 'pending'; renderTest(kind);
  let timedOut = false;
  const timer = setTimeout(() => {timedOut = true; request.abort();},35000);
  try {
    const response = await fetch('/api/test-connection',{
      method:'POST',headers:{'Content-Type':'application/json','X-Live-Voice-Probe':'1'},
      body:JSON.stringify({kind,credential}),signal:request.signal,cache:'no-store',credentials:'omit',redirect:'error',
    });
    const result = await response.json();
    if (test.request !== request) return;
    const codes = new Set(['auth_failed','access_denied','model_unavailable','endpoint_not_found','request_rejected','rate_limited','service_unavailable','network_error','timeout','cancelled','invalid_response','response_incomplete','close_unconfirmed','redirect_refused','invalid_config','invalid_endpoint','invalid_model','invalid_key']);
    if (response.ok && result?.ok === true && result.code === `${kind}_ok` && Number.isFinite(result.durationMs)) {
      test.code = result.code; test.state = 'success'; test.durationMs = result.durationMs;
    } else {
      test.code = result?.code === 'busy' ? 'probe_busy' : codes.has(result?.code) ? result.code : 'test_failed';
      test.state = 'error';
    }
  } catch {
    if (test.request !== request) return;
    test.code = timedOut ? 'timeout' : 'test_failed'; test.state = 'error';
  } finally {
    clearTimeout(timer);
    credential = null;
    if (test.request === request) {test.request = null; renderTest(kind);}
  }
}

function showStatus(key = '', error = false) {
  statusKey = key; statusError = error;
  $('status').textContent = key ? t(key) : '';
  $('status').dataset.error = String(error);
}
function refreshSummary() {
  $('result-summary').textContent = resultKinds.length ? t('result') + resultKinds.map(t).join(' + ') : '';
}
function maskKey(kind) {
  const key = $(`${kind}-key`).value;
  $(`${kind}-key-mask`).textContent = key ? `${t('masked')}: ${key.length > 12 ? `${key.slice(0,4)} ···· ${key.slice(-4)}` : '••••••••'}` : '';
}
function translate() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = locale === 'zh' ? 'Live Voice · 配置二维码' : 'Live Voice · Configuration QR';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('language').textContent = locale === 'zh' ? 'EN' : '中文';
  $('language').setAttribute('aria-label',locale === 'zh' ? 'Switch to English' : '切换为中文');
  $('theme').setAttribute('aria-label',t('appearance'));
  $('qr').setAttribute('aria-label',t('qrLabel'));
  document.querySelector('.preview').setAttribute('aria-label',t('previewLabel'));
  $('generate').textContent = t(busy ? 'generating' : 'generate');
  showStatus(statusKey,statusError); refreshSummary(); ['voice','backend'].forEach(maskKey);
  ['voice','backend'].forEach(renderTest);
}
function eraseQr() {
  revision++;
  resultKinds = [];
  const canvas = $('qr');
  canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  canvas.width = canvas.height = 1;
  canvas.hidden = true; $('result').hidden = true; $('placeholder').hidden = false;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
  refreshSummary();
}
function syncSections() {
  for (const kind of ['voice','backend']) {
    const include = $(`include-${kind}`).checked;
    $(`${kind}-fields`).hidden = !include;
    $(`${kind}-fields`).disabled = !include;
  }
}
function clearAll(message = true) {
  ['voice','backend'].forEach(kind => cancelTest(kind));
  eraseQr(); $('config-form').reset();
  // Explicit clearing also covers browsers which restore password form values.
  document.querySelectorAll('input[data-secret]').forEach(el => { el.value = ''; });
  ['voice','backend'].forEach(kind => {
    $(`${kind}-endpoint`).value = '';
    $(`${kind}-model`).value = kind === 'voice' ? 'gpt-live-1' : '';
    maskKey(kind);
  });
  $('short-passphrase').hidden = true;
  syncSections(); showStatus(message ? 'cleared' : '');
}
function readCredential(kind) {
  return {endpoint:$(`${kind}-endpoint`).value.trim(),model:$(`${kind}-model`).value.trim(),auth:$(`${kind}-auth`).value,apiKey:$(`${kind}-key`).value};
}
function readConfig() {
  const connections = {};
  for (const kind of ['voice','backend']) {
    if (!$(`include-${kind}`).checked) continue;
    connections[kind] = {
      endpoint:$(`${kind}-endpoint`).value.trim(),
      model:$(`${kind}-model`).value.trim(),
      auth:$(`${kind}-auth`).value,
      apiKey:$(`${kind}-key`).value,
    };
  }
  return {version:1,connections};
}

$('config-form').addEventListener('input', event => {
  invalidateTestFor(event.target);
  eraseQr(); showStatus(); syncSections();
  $('short-passphrase').hidden = !$('passphrase').value || [...$('passphrase').value].length >= 4;
  ['voice','backend'].forEach(maskKey);
});
$('config-form').addEventListener('change', event => { invalidateTestFor(event.target); eraseQr(); showStatus(); syncSections(); });
$('config-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  eraseQr(); showStatus(); const requestRevision = revision;
  if (!globalThis.crypto?.subtle) { showStatus('unsupported',true); return; }
  if ([...$('passphrase').value].length < 4 || !$('passphrase').value.trim()) { showStatus('invalid_passphrase',true); $('passphrase').focus(); return; }
  if ($('passphrase').value !== $('confirm-passphrase').value) { showStatus('mismatch',true); $('confirm-passphrase').focus(); return; }
  busy = true; $('generate').disabled = true; $('generate').textContent = t('generating');
  try {
    const config = readConfig();
    const payload = await encryptConfig(config,$('passphrase').value);
    if (requestRevision !== revision) return;
    drawQr($('qr'),payload);
    resultKinds = Object.keys(config.connections);
    $('qr').hidden = false; $('placeholder').hidden = true; $('result').hidden = false;
    refreshSummary(); showStatus('ready');
  } catch (error) {
    if (requestRevision === revision) { eraseQr(); showStatus(strings[error.message] ? error.message : 'failed',true); }
  } finally {
    busy = false; $('generate').disabled = false; $('generate').textContent = t('generate');
  }
});
$('clear').addEventListener('click', () => clearAll());
for (const kind of ['voice','backend']) $(`test-${kind}`).addEventListener('click', () => void testConnection(kind));
$('hide-qr').addEventListener('click', () => { eraseQr(); showStatus('hidden'); });
$('language').addEventListener('click', () => { locale = locale === 'zh' ? 'en' : 'zh'; translate(); });
$('theme').addEventListener('change', () => {
  if ($('theme').value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = $('theme').value;
});
$('example').addEventListener('click', () => {
  clearAll(false);
  $('include-backend').checked = true;
  for (const kind of ['voice','backend']) {
    $(`${kind}-endpoint`).value = `https://${kind}.example.invalid/v1`;
    $(`${kind}-model`).value = kind === 'voice' ? 'gpt-live-1' : 'example-model';
    $(`${kind}-key`).value = `demo-${kind}-not-a-real-key-1234`;
    maskKey(kind);
  }
  syncSections(); showStatus('sample');
});
$('download').addEventListener('click', () => {
  if ($('qr').hidden) return;
  const downloadRevision = revision;
  $('qr').toBlob(blob => {
    if (revision !== downloadRevision) return;
    if (!blob) { showStatus('saveFailed',true); return; }
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl; link.download = 'live-voice-encrypted-config.png';
    link.click();
  },'image/png');
});
document.querySelectorAll('[data-secret]').forEach(el => {
  for (const type of ['copy','cut','dragstart']) el.addEventListener(type,event => event.preventDefault());
});
window.addEventListener('pagehide', () => clearAll(false));
window.addEventListener('pageshow', event => { if (event.persisted) clearAll(false); });
clearAll(false); translate();
if (!globalThis.crypto?.subtle) { showStatus('unsupported',true); $('generate').disabled = true; }
