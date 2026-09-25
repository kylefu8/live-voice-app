(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const storageKey = 'live-voice.interactive-prototype.v1';
  const mediaTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const defaults = {
    theme: 'system', mode: 'practice', uiLanguage: 'zh',
    voice: {voice: 'Marin', minutes: 10, tone:'natural', intonation:'balanced', pace:'normal', instructions: ''},
    backend: {enabled: true, effort: 'low', tokens: 1024, search: true, instructions:'', timeout:60},
    connections: {
      voice: {endpoint:'https://voice.example.invalid/v1',model:'gpt-live-1',auth:'api-key',keyMask:'demo••••••0001'},
      backend: {endpoint:'https://reasoning.example.invalid/v1',model:'example-reasoning',auth:'bearer',keyMask:'demo••••••0002'},
    },
  };
  const voiceNames = ['Marin','Quartz','Ripple','Vesper','Willow','Stone','Gleam','Meridian','Bossa','Tempo','Beacon','Delta','Cinder'];
  const minutesOptions = [0,5,10,15,30,60];
  const toneOptions = [['natural','自然'],['warm','温暖'],['relaxed','轻松'],['professional','专业']];
  const intonationOptions = [['balanced','自然'],['steady','平稳'],['expressive','生动']];
  const paceOptions = [['normal','适中'],['slow','慢一些'],['brisk','快一些']];
  const effortOptions = [['default','服务默认'],['low','低'],['medium','中'],['high','高'],['xhigh','极高（xhigh）'],['max','最高（max）']];
  const t = (key, vars={}) => window.LiveVoiceI18n.t(key,state.uiLanguage,vars);
  const scenarios = {
    practice: {title: '周末的小故事', question: 'What was the best part of your weekend?', user: 'I went hiking with a friend.', answer: 'That sounds lovely. Where did you go?'},
    general: {title: '今天吃点什么', question: '今天想吃清淡一点，还是来点有滋味的？', user: '想吃简单一点的，家里有番茄和鸡蛋。', answer: '那就做一碗番茄鸡蛋面吧。你喜欢汤多一点，还是偏拌面的做法？'},
  };
  function sampleRecords() {
    const now = Date.now();
    return [
      {id:'sample-weekend', mode:'practice', title:'聊聊周末', at:now - 3600000, duration:720, turns:[{who:'assistant', text:scenarios.practice.question}, {who:'user', text:scenarios.practice.user}, {who:'assistant', text:scenarios.practice.answer}]},
      {id:'sample-dinner', mode:'general', title:'晚餐做什么', at:now - 7200000, duration:360, turns:[{who:'assistant', text:scenarios.general.question}, {who:'user', text:scenarios.general.user}, {who:'assistant', text:scenarios.general.answer}]},
      {id:'sample-trip', mode:'practice', title:'旅行中的小故事', at:now - 86400000, duration:1080, turns:[{who:'assistant', text:'Tell me about a place you would love to visit again.'}, {who:'user', text:'I would love to go back to the mountains.'}, {who:'assistant', text:'What do you miss most about being there?'}]},
    ];
  }
  let state = {...structuredClone(defaults), records:sampleRecords()};
  let storageWarning = '';
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved?.version === 1) {
      if (['system','light','dark'].includes(saved.theme)) state.theme = saved.theme;
      if (['general','practice'].includes(saved.mode)) state.mode = saved.mode;
      if (['zh','en'].includes(saved.uiLanguage)) state.uiLanguage=saved.uiLanguage;
      if (saved.voice) {
        const v=saved.voice;
        if(voiceNames.includes(v.voice))state.voice.voice=v.voice;
        if(minutesOptions.includes(v.minutes))state.voice.minutes=v.minutes;
        if(typeof v.instructions==='string')state.voice.instructions=v.instructions.slice(0,1500);
        for(const [key,options] of [['tone',toneOptions],['intonation',intonationOptions],['pace',paceOptions]])if(options.some(([id])=>id===v[key]))state.voice[key]=v[key];
      }
      if (saved.backend) {
        const b=saved.backend;
        if(typeof b.enabled==='boolean')state.backend.enabled=b.enabled;
        if(effortOptions.some(([id])=>id===b.effort))state.backend.effort=b.effort;
        if(Number.isInteger(b.tokens)&&b.tokens>=16&&b.tokens<=131072)state.backend.tokens=b.tokens;
        if(typeof b.search==='boolean')state.backend.search=b.search;
        if(typeof b.instructions==='string')state.backend.instructions=b.instructions.slice(0,4000);
        if([15,30,60,120].includes(b.timeout))state.backend.timeout=b.timeout;
      }
      for(const kind of ['voice','backend']) {
        const c=saved.connections?.[kind];
        if(c&&validEndpoint(c.endpoint)&&typeof c.model==='string'&&/^[A-Za-z0-9_.:/-]{1,120}$/.test(c.model)&&['bearer','api-key'].includes(c.auth))state.connections[kind]={endpoint:c.endpoint,model:c.model,auth:c.auth,keyMask:/^demo•{6}[A-Za-z0-9_-]{4}$/.test(c.keyMask)?c.keyMask:''};
      }
      if (Array.isArray(saved.records)) state.records = saved.records.filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string' && ['general','practice'].includes(r.mode) && Number.isFinite(r.at) && Number.isFinite(r.duration) && Array.isArray(r.turns) && r.turns.every(t => t && ['user','assistant'].includes(t.who) && typeof t.text === 'string')).slice(0,100);
    }
  } catch { storageWarning = '本次使用临时数据，浏览器存储暂不可用。'; }
  const drafts = {voice:{...state.voice}, backend:{...state.backend}};
  const connectionDrafts = structuredClone(state.connections);
  const pendingKeys = {voice:'',backend:''};
  const keyEditing = {voice:false,backend:false};
  const connectionMessages = {voice:'',backend:''};
  const connectionOpen = {voice:false,backend:false};
  const connectionTests = {voice:{status:'idle',message:''},backend:{status:'idle',message:''}};
  const connectionTestTimers = {voice:null,backend:null};
  let filter = 'all';
  let call = null;
  let callTimer = null;
  let responseTimer = null;
  let toastTimer = null;
  let importTimer = null;
  const emptyImport = () => ({step:'scan', pass:'', visible:false, error:'', testing:false,scope:'both'});
  let importState = emptyImport();
  let priorRoute = '';
  let formMessage = '';
  const paths = {
    back:'M19 12H5m7-7-7 7 7 7', chevron:'m9 5 7 7-7 7',
    history:'M3 10a9 9 0 1 1 1 8M3 4v6h6m3-3v5l3 2',
    settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
    muted:'m3 3 18 18M9 9v3a3 3 0 0 0 4 3m2-5V5a3 3 0 0 0-6 0m-3 6v1a6 6 0 0 0 10 4m2-4v-1m-6 7v4m-3 0h6',
    end:'M3 15v-4c5-5 13-5 18 0v4l-5-1v-3a12 12 0 0 0-8 0v3Z',
    qr:'M3 3h6v6H3Zm12 0h6v6h-6ZM3 15h6v6H3Zm12 0h2v2h-2Zm4 0h2m-6 4h2v2m2-2h2v2',
    cube:'m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5m-9 5v10M7 5l10 6',
    sun:'M12 3V1m0 22v-2M3 12H1m22 0h-2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    check:'m5 12 4 4L19 6',
  };
  const icon = (name) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.mic}"/></svg>`;
  const modeName = (mode) => t(mode === 'practice' ? '练口语' : '通用');
  const stamp = (at) => new Date(at).toLocaleTimeString(state.uiLanguage==='en'?'en-GB':'zh-CN', {hour:'2-digit', minute:'2-digit', hour12:false});
  const duration = (seconds) => seconds < 60 ? t('{n} 秒',{n:Math.max(1,Math.round(seconds))}) : t('{n} 分钟',{n:Math.floor(seconds / 60)});
  const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  function dayName(at) {
    const date = new Date(at), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate()-1);
    if (date.toDateString() === today.toDateString()) return t('今天');
    if (date.toDateString() === yesterday.toDateString()) return t('昨天');
    return date.toLocaleDateString(state.uiLanguage==='en'?'en-GB':'zh-CN', {year:'numeric',month:'long',day:'numeric'});
  }
  function validEndpoint(value) {
    try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
  }
  function localizeApp() {
    const root=$('#app');
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[];let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest('[data-content], textarea, .key-mask'))nodes.push(node);
    for(const node of nodes){const raw=node.nodeValue,key=raw.trim();if(key)node.nodeValue=raw.replace(key,t(key));}
    for(const el of root.querySelectorAll('[aria-label],[placeholder]'))for(const attr of ['aria-label','placeholder'])if(el.hasAttribute(attr))el.setAttribute(attr,t(el.getAttribute(attr)));
    window.LiveVoiceI18n.applyShell(state.uiLanguage);
  }
  function languageControl() {
    return `<label class="language-control"><span class="sr-only">界面语言</span><select aria-label="界面语言" data-action="ui-language"><option value="zh" ${state.uiLanguage==='zh'?'selected':''}>中文</option><option value="en" ${state.uiLanguage==='en'?'selected':''}>English</option></select></label>`;
  }
  function optionLabel(options,value){return t(options.find(([id])=>id===value)?.[1]||value);}
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({version:1,...state})); return true; }
    catch { notify('已在本次预览生效；浏览器无法保存，刷新后可能丢失。'); return false; }
  }
  function notify(message) {
    clearTimeout(toastTimer);
    const toast = $('#toast'); toast.textContent = t(message); toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme === 'system' ? (mediaTheme.matches ? 'dark' : 'light') : state.theme;
  }
  function route() { return location.hash.replace(/^#\/?/,'') || 'home'; }
  function go(path) { if (route() !== path) location.hash = `/${path}`; render(); }
  function topbar(title, back='home', extra='') {
    return `<header class="topbar"><button class="icon-btn" data-go="${back}" aria-label="返回">${icon('back')}</button><h1 class="page-title">${title}</h1><div class="header-actions">${extra}${languageControl()}</div></header>`;
  }
  function segments(options, active, action, aria) {
    return `<div class="segment ${action==='theme'?'theme-segment':''}" role="group" aria-label="${aria}">${options.map(([value,label]) => `<button type="button" data-action="${action}" data-value="${value}" class="${active===value?'selected':''}" aria-pressed="${active===value}">${label}</button>`).join('')}</div>`;
  }
  function orb(stage='') {
    return `<div class="voice-orb ${stage}" aria-hidden="true"><div class="orb-core"><div class="wave">${'<span class="bar"></span>'.repeat(7)}</div></div></div>`;
  }
  function option(value, label, chosen) { return `<option value="${escape(value)}" ${String(value)===String(chosen)?'selected':''}>${escape(label)}</option>`; }
  function modelStatus(kind) { return `<div class="notice"><span><span class="status-dot"></span>已载入示例配置</span><button class="text-button" type="button" data-action="scan-target" data-kind="${kind}">${icon('qr')}扫码更新</button></div>`; }
  function connectionForm(kind) {
    const c=connectionDrafts[kind];
    return `<details class="connection-section" data-connection="${kind}" ${connectionOpen[kind]?'open':''}><summary>连接配置</summary><form id="connection-${kind}" novalidate><div class="connection-fields">
      <label class="connection-field" for="${kind}-endpoint"><span class="field-label">服务地址（Endpoint）</span><input class="field-input" id="${kind}-endpoint" name="endpoint" data-connection-draft="${kind}" type="url" inputmode="url" spellcheck="false" maxlength="500" value="${escape(c.endpoint)}"></label>
      <label class="connection-field" for="${kind}-model"><span class="field-label">模型 / 部署</span><input class="field-input" id="${kind}-model" name="model" data-connection-draft="${kind}" maxlength="120" spellcheck="false" value="${escape(c.model)}"></label>
      <label class="connection-field" for="${kind}-auth"><span class="field-label">鉴权方式</span><select class="field-input" id="${kind}-auth" name="auth" data-connection-draft="${kind}">${option('bearer','Bearer',c.auth)}${option('api-key','API key 请求头',c.auth)}</select></label>
      <div class="connection-field"><span class="field-label">API key</span><div class="field-row"><span class="key-mask" aria-label="API key">${escape(state.connections[kind].keyMask||t('未配置'))}</span><button type="button" class="text-button" data-action="edit-key" data-kind="${kind}">更换 API key</button></div><p class="hint">不提供明文显示或复制</p></div>
      ${keyEditing[kind]?`<label class="connection-field" for="${kind}-key"><span class="field-label">新的 API key</span><input class="field-input key-editor" id="${kind}-key" data-key-kind="${kind}" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" value="${escape(pendingKeys[kind])}" placeholder="留空保留原有密钥"></label><p class="hint">此原型只接受以 demo- 开头的示例 key，保存后仅保留头尾标识。</p>`:''}
      </div><p class="hint">语音与后端连接配置相互独立。</p><p class="form-message" role="status">${escape(connectionMessages[kind])}</p>
      <div class="connection-actions"><button class="secondary" type="button" data-action="test-connection" data-kind="${kind}" ${connectionTests[kind].status==='testing'?'disabled':''}>${connectionTests[kind].status==='testing'?'正在测试（演示）…':'测试连接（演示）'}</button><button class="secondary" type="submit">保存连接配置</button></div>
      <p class="connection-test-result" id="${kind}-test-result" role="status" data-status="${connectionTests[kind].status}">${escape(connectionTests[kind].message)}</p>
      <p class="hint">测试当前填写的配置，不会自动保存；当前仅模拟结果，不访问模型服务。</p>
      <button class="text-button" type="button" data-action="fail-connection" data-kind="${kind}" ${connectionTests[kind].status==='testing'?'disabled':''}>查看连接失败状态</button></form></details>`;
  }
  function draftMessage(kind) { return formMessage || (JSON.stringify(drafts[kind]) !== JSON.stringify(state[kind]) ? '有未保存的修改' : ''); }
  function settingRow(label, subtitle, target, glyph) { return `<button class="row" data-go="${target}">${icon(glyph)}<span class="row-copy"><span class="row-label">${label}</span><span class="row-help">${subtitle}</span></span>${icon('chevron')}</button>`; }
  function home() {
    return `<section class="page page-home"><header class="topbar"><h1 class="brand">Live Voice<span class="eyebrow">把交流，留给声音。</span></h1><div class="header-actions"><button class="icon-btn" data-go="history" aria-label="历史会话">${icon('history')}</button><button class="icon-btn" data-go="settings" aria-label="设置">${icon('settings')}</button>${languageControl()}</div></header>
      ${segments([['general','通用'],['practice','练口语']],state.mode,'mode','对话模式')}
      <div class="home-copy"><span class="eyebrow">${state.mode==='practice'?'SPEAK NATURALLY':'A LITTLE CONVERSATION'}</span><h2>${state.mode==='practice'?`${t('随时开口，')}<br>${t('自然交流。')}`:t('想聊什么？')}</h2><p class="muted">${state.mode==='practice'?'不用准备，从一句话开始。':'今天的小事，也值得聊聊。'}</p></div>${orb()}
      <div class="bottom-actions"><button class="primary" data-action="start">${icon('mic')}${call?'返回对话':'开始对话'}</button><p class="status-line"><span class="status-dot"></span>示例配置就绪</p><p class="subtle">交互预览，不会打开麦克风</p></div></section>`;
  }
  function callPage() {
    if (!call) return `<section class="page">${topbar('对话')}<div class="empty">还没有进行中的对话。<button class="primary" data-go="home">回到首页</button></div></section>`;
    const last = call.turns.at(-1);
    const status = call.muted ? '麦克风已静音' : ({connecting:'正在连接',speaking:'正在回应',listening:'正在听你说'}[call.stage]);
    return `<section class="page page-call">${topbar('Live Voice','home',`<button class="icon-btn" data-go="settings" aria-label="对话设置">${icon('settings')}</button>`)}
      <div class="call-meta"><span class="badge">${modeName(call.mode)}</span><span id="call-clock">${clock(Math.floor((Date.now()-call.at)/1000))}</span><span class="subtle">演示对话</span></div><h2 class="call-title">${escape(scenarios[call.mode].title)}</h2>${orb(call.muted?'muted-orb':call.stage)}
      <div class="call-state"><h3 aria-live="polite">${status}</h3><p class="muted">${call.muted?'取消静音后可以继续演示插话':'想说就说，随时打断'}</p><p class="subtle">${escape(t('{voice} · 风格：{tone}',{voice:call.snapshot.voice.voice,tone:optionLabel(toneOptions,call.style.tone)}))} · ${escape(call.snapshot.voice.minutes?t('{minutes} 分钟上限',{minutes:call.snapshot.voice.minutes}):t('无应用时长上限'))}</p></div>
      <div class="caption">${call.captions?`<p data-content>${escape(last?.text || t('正在建立示例会话…'))}</p>`:''}<button class="text-button" data-action="captions" aria-expanded="${call.captions}">${call.captions?'收起字幕':'展开字幕'}</button></div>
      <div class="prototype-control"><button class="secondary" data-action="interrupt" ${call.muted || call.stage!=='speaking'?'disabled':''}>演示插话</button><p class="subtle">仅演示状态切换，不采集或播放声音</p></div>
      <div class="call-controls"><button class="secondary" data-action="mute" aria-pressed="${call.muted}" aria-label="${call.muted?'取消静音':'静音'}">${icon(call.muted?'muted':'mic')}<span>${call.muted?'取消静音':'静音'}</span></button><button class="primary" data-action="end">${icon('end')}结束对话</button></div></section>`;
  }
  function settings() {
    return `<section class="page">${topbar('设置')}<div class="setting-group"><h2 class="section-label">外观</h2>${segments([['system','跟随系统'],['light','浅色'],['dark','深色']],state.theme,'theme','外观主题')}</div><div class="setting-group"><h2 class="section-label">界面语言</h2>${segments([['zh','中文'],['en','English']],state.uiLanguage,'ui-language','界面语言')}</div>
      <div class="setting-group"><h2 class="section-label">模型与连接</h2><div class="rows">${settingRow('语音模型','GPT-Live-1 · 音色与对话偏好','settings/voice','mic')}${settingRow('后端模型','推理与搜索','settings/backend','cube')}${settingRow('扫码更新配置','从电脑导入连接信息','import','qr')}</div></div>
      <div class="setting-group"><h2 class="section-label">会话</h2><div class="rows">${settingRow('历史记录','查看本机的示例文字记录','history','history')}</div></div><p class="hint">这是可点击原型。参数只保存到当前浏览器，不会发送到模型服务。</p></section>`;
  }
  function voiceSettings() {
    const v = drafts.voice;
    return `<section class="page">${topbar('语音模型','settings')}<h2 class="model-heading">GPT-Live-1</h2>${modelStatus('voice')}${connectionForm('voice')}<form id="voice-form"><div class="rows"><div class="field-row"><span>模型 / 部署</span><span class="row-value" data-content>${escape(state.connections.voice.model)}</span></div>
      <label class="field-row" for="voice-name"><span>音色</span><select class="field-input" id="voice-name" name="voice" data-draft="voice">${voiceNames.map(x=>option(x,x,v.voice)).join('')}</select></label></div>
      <p class="hint">跟随用户语言交流，无需预设对话语言。</p>
      <div class="setting-group"><h2 class="section-label">说话风格</h2><div class="rows">
      ${[['tone','语气',toneOptions],['intonation','语调',intonationOptions],['pace','语速偏好',paceOptions]].map(([name,label,options])=>`<label class="field-row" for="voice-${name}"><span>${label}</span><select class="field-input" id="voice-${name}" name="${name}" data-draft="voice">${options.map(([id,text])=>option(id,text,v[name])).join('')}</select></label>`).join('')}
      </div><p class="hint">这些偏好通过对话指令表达，不是精确声学参数。</p></div>
      <div class="setting-group"><label class="field-label" for="voice-instructions">自定义指令</label><textarea class="field-input" id="voice-instructions" name="instructions" data-draft="voice" rows="3" maxlength="1500" placeholder="例如：语气轻松一些，每次只追问一个问题。">${escape(v.instructions)}</textarea><p class="hint">保留为空即可使用当前模式的默认风格。请勿输入密钥。</p></div>
      <div class="setting-group"><label class="field-row" for="voice-minutes"><span>单次会话总时长</span><select class="field-input" id="voice-minutes" name="minutes" data-draft="voice">${minutesOptions.map(x=>option(x,x?t('{n} 分钟',{n:x}):t('不设应用上限'),v.minutes)).join('')}</select></label><p class="hint">从开始到结束的整个 session 上限，包含停顿和静音；不是单句回答长度。</p>${v.minutes===0?'<p class="hint">服务仍可能有时长限制。</p>':''}</div>
      <div class="form-footer"><p class="form-message" role="status">${escape(draftMessage('voice'))}</p><p class="hint">音色在新会话生效；语气、语调和节奏可在对话中追加指令调整。</p><button class="primary" type="submit">保存参数</button>${call?'<button class="secondary apply-live-button" type="button" data-action="apply-style">仅应用到当前对话（演示）</button><p class="hint">新风格会影响后续表达，不改变已播放的声音。</p>':''}</div></form></section>`;
  }
  function backendSettings() {
    const b = drafts.backend;
    return `<section class="page">${topbar('后端模型','settings')}${modelStatus('backend')}${connectionForm('backend')}<form id="backend-form" novalidate><label class="field-row switch" for="backend-enabled"><span>启用后端模型</span><input id="backend-enabled" name="enabled" type="checkbox" data-draft="backend" ${b.enabled?'checked':''}><span class="switch-track" aria-hidden="true"></span></label>
      <fieldset class="backend-fields" ${b.enabled?'':'disabled'}><legend class="sr-only">后端模型参数</legend><div class="rows"><div class="field-row"><span>模型 / 部署</span><span class="row-value" data-content>${escape(state.connections.backend.model)}</span></div>
      <label class="field-row" for="backend-effort"><span>推理强度</span><select class="field-input" id="backend-effort" name="effort" data-draft="backend">${effortOptions.map(([x,l])=>option(x,l,b.effort)).join('')}</select></label></div><p class="hint">推理强度依模型而异；更高通常更慢且消耗更多 Token。</p><div class="rows">
      <label class="field-row" for="backend-tokens"><span>最大输出 Token</span><input class="field-input" id="backend-tokens" name="tokens" data-draft="backend" type="number" inputmode="numeric" required min="16" max="131072" step="1" value="${escape(b.tokens)}"></label>
      <label class="field-row switch" for="backend-search"><span>联网搜索</span><input id="backend-search" name="search" data-draft="backend" type="checkbox" ${b.search?'checked':''}><span class="switch-track" aria-hidden="true"></span></label>
      <label class="field-row" for="backend-timeout"><span>请求超时</span><select class="field-input" id="backend-timeout" name="timeout" data-draft="backend">${[15,30,60,120].map(x=>option(x,t('{n} 秒',{n:x}),b.timeout)).join('')}</select></label></div>
      <p class="hint">请求超时是一次后端请求的等待上限，不是会话总时长。</p>
      <div class="setting-group"><label class="field-label" for="backend-instructions">后端指令</label><textarea class="field-input" id="backend-instructions" name="instructions" data-draft="backend" rows="3" maxlength="4000" placeholder="返回的答案应简洁、适合朗读。">${escape(b.instructions)}</textarea></div></fieldset>
      <p class="hint">这里展示示例参数。正式版本的选项以实际模型支持为准。</p>${!b.enabled?'<p class="notice">后端已在草稿中关闭；保存后，下次对话只使用语音模型。</p>':''}<div class="form-footer"><p class="form-message" role="status">${escape(draftMessage('backend'))}</p><p class="hint">保存后，下次对话生效。</p><button class="primary" type="submit">保存参数</button></div></form></section>`;
  }
  function historyList() {
    const records = state.records.filter(r=>filter==='all'||r.mode===filter).sort((a,b)=>b.at-a.at);
    let lastDay = '';
    return `<section class="page">${topbar('历史会话')}<p class="muted">仅保存在当前浏览器 · 示例文字</p><div class="chips" role="group" aria-label="会话类型">${[['all','全部'],['general','通用'],['practice','练口语']].map(([v,l])=>`<button class="chip ${v===filter?'selected':''}" data-action="filter" data-value="${v}" aria-pressed="${v===filter}">${l}</button>`).join('')}</div>
      <div class="history-list">${records.map(r=>{const day=dayName(r.at), heading=day!==lastDay?`<h2 class="section-label">${day}</h2>`:'';lastDay=day;return `${heading}<button class="history-item" data-go="history/${encodeURIComponent(r.id)}"><span class="row-copy"><span class="history-title"><span data-content>${escape(r.title)}</span> <span class="badge">${modeName(r.mode)}</span></span><span class="row-help" data-content>${escape(r.turns[0]?.text || t('暂无文字内容'))}</span><span class="history-time">${stamp(r.at)} · ${duration(r.duration)}</span></span>${icon('chevron')}</button>`;}).join('') || '<div class="empty">这里还没有会话记录。<p class="muted">结束一段演示对话后，可以在这里回看。</p><button class="secondary" data-go="home">开始一段对话</button></div>'}</div></section>`;
  }
  function historyDetail(id) {
    const r = state.records.find(x=>x.id===id);
    if (!r) return `<section class="page">${topbar('会话记录','history')}<div class="empty">这条记录不存在或已不可用。<button class="secondary" data-go="history">返回历史</button></div></section>`;
    return `<section class="page">${topbar(`<span data-content>${escape(r.title)}</span>`,'history')}<div class="call-meta"><span class="badge">${modeName(r.mode)}</span><span class="subtle">${dayName(r.at)} ${stamp(r.at)} · ${duration(r.duration)}</span></div><p class="hint">会话已结束 · 示例记录</p><div class="transcript">${r.turns.map((turn,i)=>`<article class="turn"><p class="turn-label ${turn.who==='user'?'user-label':''}">${t(turn.who==='user'?'我':'助手')} · ${stamp(turn.at || r.at+i*30000)}${turn.interrupted?' <span class="badge">已打断</span>':''}</p><p data-content>${escape(turn.text)}</p></article>`).join('')}</div><p class="subtle">只读文字记录，不会继续或恢复该会话</p></section>`;
  }
  function importPage() {
    let content;
    const kinds=importState.scope==='both'?['voice','backend']:[importState.scope];
    const boundary = '<p class="hint">仅演示导入流程，不扫描相机、不执行加解密。请勿输入真实口令或密钥。</p>';
    if (importState.step==='scan') content = `<div class="scanner"><div class="scan-corners"><div class="scan-grid" aria-hidden="true">${'<span></span>'.repeat(49)}</div></div><p>将电脑上的二维码放入框内</p><span class="badge">示意图案</span></div>${boundary}<div class="bottom-actions"><button class="primary" data-action="sample-qr">使用示例二维码</button></div>`;
    else if (importState.step==='pass') content = `<div class="notice">${icon('check')}已识别示例配置</div><div class="sheet"><h2>输入导入口令</h2><p class="muted">输入在电脑上设置的口令。仅首次导入时需要。</p><form id="import-form" novalidate><label class="field-label" for="import-pass">导入口令</label><div class="password-field"><input class="field-input" id="import-pass" name="pass" type="${importState.visible?'text':'password'}" value="${escape(importState.pass)}" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-describedby="import-error"><button class="icon-btn" type="button" data-action="show-pass" aria-label="${importState.visible?'隐藏口令':'显示口令'}">${icon('eye')}</button></div><p class="hint">演示口令：<strong>preview</strong></p><p class="error" id="import-error" role="alert">${escape(importState.error)}</p><button class="primary" type="submit">解密配置</button></form><button class="text-button" data-action="rescan">重新扫描</button>${boundary}</div>`;
    else content = `<div class="notice">${icon('check')}示例配置已就绪</div><h2>核对连接信息</h2><div class="import-summary">${kinds.map(kind=>`<div class="review-row"><span class="muted">${kind==='voice'?'语音服务地址':'后端服务地址'}</span><strong data-content>${defaults.connections[kind].endpoint}</strong></div><div class="review-row"><span class="muted">模型 / 部署</span><strong data-content>${defaults.connections[kind].model}</strong></div><div class="review-row"><span class="muted">API key</span><strong class="key-mask">${defaults.connections[kind].keyMask}</strong></div>`).join('')}</div><p class="hint">正式 App 会在你确认后测试这些地址。当前只模拟测试结果，不发送网络请求。</p><p class="error" role="alert">${escape(importState.error)}</p><div class="bottom-actions"><button class="primary" data-action="test-import" ${importState.testing?'disabled':''}>${importState.testing?'正在演示连接测试…':'测试并保存（演示）'}</button><button class="text-button" data-action="fail-import" ${importState.testing?'disabled':''}>查看连接失败状态</button></div>`;
    return `<section class="page">${topbar('扫码配置','settings')}<p class="badge">${importState.scope==='both'?'语音和后端':importState.scope==='voice'?'语音模型':'后端模型'}</p>${content}</section>`;
  }
  function render() {
    const current = route();
    const changed = current !== priorRoute;
    if (changed) formMessage = '';
    if(changed&&['settings/voice','settings/backend'].includes(priorRoute)){
      const kind=priorRoute.split('/')[1];
      if(pendingKeys[kind]||connectionTests[kind].status==='testing')invalidateConnectionTest(kind);
      pendingKeys[kind]='';keyEditing[kind]=false;
    }
    if (priorRoute==='import' && changed) {
      clearTimeout(importTimer); importState = emptyImport();
    }
    const live = call && current!=='call' ? `<button class="live-banner" data-go="call"><span class="status-dot"></span>对话进行中（演示） · 返回对话</button>` : '';
    let screen;
    if (current==='home') screen = home();
    else if (current==='call') screen = callPage();
    else if (current==='settings') screen = settings();
    else if (current==='settings/voice') screen = voiceSettings();
    else if (current==='settings/backend') screen = backendSettings();
    else if (current==='history') screen = historyList();
    else if (current.startsWith('history/')) { let id;try{id=decodeURIComponent(current.slice(8));}catch{id='';}screen=historyDetail(id); }
    else if (current==='import') screen = importPage();
    else screen = `<section class="page">${topbar('页面不存在')}<div class="empty"><button class="primary" data-go="home">回到首页</button></div></section>`;
    $('#app').innerHTML = live + screen;
    localizeApp();
    priorRoute = current;
    if (changed) {
      $('#app').scrollTop = 0;
      const heading=$('#app h1'); if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
    }
    document.title = `${t(({'home':'Live Voice','call':'对话','settings':'设置','settings/voice':'语音模型','settings/backend':'后端模型','history':'历史会话','import':'扫码配置'})[current] || '会话详情')} · ${t('交互原型')}`;
  }
  function refreshCall() { if (route()==='call') render(); }
  function startCall() {
    if (call) {go('call');return;}
    call = {mode:state.mode,at:Date.now(),muted:false,captions:true,stage:'connecting',turns:[],snapshot:structuredClone({voice:state.voice,backend:state.backend,connections:state.connections}),style:{tone:state.voice.tone,intonation:state.voice.intonation,pace:state.voice.pace,instructions:state.voice.instructions}, interruptions:0};
    go('call');
    responseTimer=setTimeout(()=>{if(!call)return;call.stage='speaking';call.turns.push({who:'assistant',text:scenarios[call.mode].question,at:Date.now()});refreshCall();},700);
    callTimer=setInterval(()=>{
      if(!call)return;
      const elapsed=Math.floor((Date.now()-call.at)/1000);
      if(call.snapshot.voice.minutes>0&&elapsed>=call.snapshot.voice.minutes*60){endCall();notify('已到本次会话时长上限，演示已结束。');return;}
      if($('#call-clock'))$('#call-clock').textContent=clock(elapsed);
    },1000);
  }
  function interrupt() {
    if(!call || call.muted || call.stage!=='speaking')return;
    clearTimeout(responseTimer);
    const previous=call.turns.at(-1);if(previous?.who==='assistant')previous.interrupted=true;
    call.interruptions++;
    call.stage='listening';
    const scenario=scenarios[call.mode];
    call.turns.push({who:'user',text:call.interruptions===1?scenario.user:(call.mode==='practice'?'Could we talk about something else?':'我们换个话题吧。'),at:Date.now()});
    refreshCall();
    responseTimer=setTimeout(()=>{if(!call)return;call.stage='speaking';call.turns.push({who:'assistant',text:call.interruptions===1?scenario.answer:(call.mode==='practice'?'Of course. What would you like to talk about?':'当然，你现在最想聊什么？'),at:Date.now()});refreshCall();},1100);
  }
  function endCall() {
    if(!call)return;
    clearTimeout(responseTimer);clearInterval(callTimer);
    const completed=call;call=null;
    if(completed.turns.length){state.records.unshift({id:`demo-${Date.now()}`,mode:completed.mode,title:`${scenarios[completed.mode].title}（演示）`,at:completed.at,duration:Math.max(1,Math.floor((Date.now()-completed.at)/1000)),turns:completed.turns});state.records=state.records.slice(0,100);if(persist())notify('演示会话已结束，文字记录已保存。');}
    else notify('演示会话已结束。');
    go('home');
  }
  function changeLanguage(value) {
    if(!['zh','en'].includes(value))return;
    state.uiLanguage=value;persist();$('#toast').classList.remove('visible');render();
  }
  function connectionError(kind) {
    const c=connectionDrafts[kind], current=state.connections[kind], key=pendingKeys[kind].trim();
    if(!validEndpoint(c.endpoint)||c.endpoint.length>500)return '地址需为不含账号、查询参数或片段的 HTTPS 地址。';
    const normalized=new URL(c.endpoint).href.replace(/\/$/,'');
    if(!/^[A-Za-z0-9_.:/-]{1,120}$/.test(c.model))return '请输入模型或部署名称。';
    if(!['bearer','api-key'].includes(c.auth))return '请选择有效的鉴权方式。';
    if((normalized!==current.endpoint||c.auth!==current.auth||!current.keyMask)&&!key)return '更换地址或鉴权方式时，请同时更换示例 key。';
    if(key&&!/^demo-[A-Za-z0-9_-]{7,251}$/.test(key))return '示例 key 至少 12 个字符，并以 demo- 开头。';
    return '';
  }
  function updateConnectionTestView(kind) {
    const result=$(`#${kind}-test-result`), test=connectionTests[kind];
    if(result){result.dataset.status=test.status;result.textContent=t(test.message);}
    const button=$(`[data-action="test-connection"][data-kind="${kind}"]`);
    if(button){button.disabled=test.status==='testing';button.textContent=t(button.disabled?'正在测试（演示）…':'测试连接（演示）');}
    const failure=$(`[data-action="fail-connection"][data-kind="${kind}"]`);
    if(failure)failure.disabled=test.status==='testing';
  }
  function invalidateConnectionTest(kind) {
    clearTimeout(connectionTestTimers[kind]);connectionTestTimers[kind]=null;
    if(connectionTests[kind].status!=='idle')connectionTests[kind]={status:'stale',message:'配置已修改或测试已取消，请重新测试。'};
    updateConnectionTestView(kind);
  }
  function testConnection(kind,fail=false) {
    if(connectionTests[kind].status==='testing')return;
    const error=connectionError(kind);connectionOpen[kind]=true;
    if(error){connectionTests[kind]={status:'failed',message:error};render();return;}
    connectionTests[kind]={status:'testing',message:kind==='voice'?'正在模拟建立语音会话…':'正在模拟验证后端响应…'};render();
    connectionTestTimers[kind]=setTimeout(()=>{
      connectionTestTimers[kind]=null;
      connectionTests[kind]=fail?{status:'failed',message:'连接失败（演示）：服务响应超时。请检查配置后重试，已保存配置未改变。'}:{status:'success',message:kind==='voice'?'语音会话测试通过（演示）；未连接真实服务。':'后端响应测试通过（演示）；未连接真实服务。'};
      updateConnectionTestView(kind);
    },900);
  }
  function saveConnection(kind) {
    const c=connectionDrafts[kind], current=state.connections[kind], key=pendingKeys[kind].trim();
    const error=connectionError(kind);
    if(error){connectionMessages[kind]=error;connectionOpen[kind]=true;render();return;}
    if(connectionTests[kind].status==='testing')invalidateConnectionTest(kind);
    const normalized=new URL(c.endpoint).href.replace(/\/$/,'');
    state.connections[kind]={endpoint:normalized,model:c.model,auth:c.auth,keyMask:key?`${key.slice(0,4)}••••••${key.slice(-4)}`:current.keyMask};
    connectionDrafts[kind]={...state.connections[kind]};pendingKeys[kind]='';keyEditing[kind]=false;
    connectionMessages[kind]=persist()?'连接设置已保存（演示），下次会话使用。':'已在本次预览生效，无法持久保存';render();
  }
  $('#app').addEventListener('click',(event)=>{
    const button=event.target.closest('button');if(!button || button.disabled)return;
    if(button.dataset.go){if(button.dataset.go==='import')importState=emptyImport();go(button.dataset.go);return;}
    const action=button.dataset.action, value=button.dataset.value;
    if(action==='mode'){if(call){notify('先结束当前对话，再切换模式。');return;}state.mode=value;persist();render();}
    else if(action==='theme'){state.theme=value;applyTheme();persist();render();}
    else if(action==='ui-language')changeLanguage(value);
    else if(action==='test-connection')testConnection(button.dataset.kind);
    else if(action==='fail-connection')testConnection(button.dataset.kind,true);
    else if(action==='scan-target'){importState={...emptyImport(),scope:button.dataset.kind};go('import');}
    else if(action==='edit-key'){keyEditing[button.dataset.kind]=true;connectionOpen[button.dataset.kind]=true;render();$(`#${button.dataset.kind}-key`)?.focus();}
    else if(action==='apply-style'){
      if(!call){notify('当前没有进行中的对话。');return;}
      call.style={tone:drafts.voice.tone,intonation:drafts.voice.intonation,pace:drafts.voice.pace,instructions:drafts.voice.instructions};
      formMessage='风格指令已追加（演示）；音色和总时长仍在下次会话生效。';render();
    }
    else if(action==='start')startCall();
    else if(action==='end')endCall();
    else if(action==='interrupt')interrupt();
    else if(action==='mute'&&call){call.muted=!call.muted;refreshCall();}
    else if(action==='captions'&&call){call.captions=!call.captions;refreshCall();}
    else if(action==='filter'){filter=value;render();}
    else if(action==='sample-qr'){importState.step='pass';render();$('#import-pass')?.focus();}
    else if(action==='show-pass'){importState.visible=!importState.visible;const field=$('#import-pass');field.type=importState.visible?'text':'password';button.setAttribute('aria-label',importState.visible?'隐藏口令':'显示口令');}
    else if(action==='rescan'){importState={...emptyImport(),scope:importState.scope};render();}
    else if(action==='fail-import'){importState.error='连接测试失败（演示）。原有配置已保留，可以重试。';render();}
    else if(action==='test-import'){
      importState.testing=true;importState.error='';render();
      importTimer=setTimeout(()=>{
        const kinds=importState.scope==='both'?['voice','backend']:[importState.scope];
        for(const kind of kinds){invalidateConnectionTest(kind);state.connections[kind]={...defaults.connections[kind]};connectionDrafts[kind]={...state.connections[kind]};pendingKeys[kind]='';keyEditing[kind]=false;connectionMessages[kind]='';}
        persist();importState.testing=false;importState.pass='';go('settings');notify('示例导入流程已完成；未连接任何真实服务。');
      },900);
    }
  });
  $('#app').addEventListener('input',(event)=>{
    const input=event.target;
    if(input.id==='import-pass'){importState.pass=input.value;return;}
    if(input.dataset.keyKind){pendingKeys[input.dataset.keyKind]=input.value;invalidateConnectionTest(input.dataset.keyKind);return;}
    if(input.dataset.connectionDraft){connectionDrafts[input.dataset.connectionDraft][input.name]=input.value;connectionMessages[input.dataset.connectionDraft]='有未保存的修改';invalidateConnectionTest(input.dataset.connectionDraft);return;}
    const kind=input.dataset.draft;
    if(!kind)return;
    drafts[kind][input.name]=input.type==='checkbox'?input.checked:['minutes','timeout'].includes(input.name)?Number(input.value):input.value;
    formMessage='有未保存的修改';const message=$(`#${kind}-form .form-message`);if(message)message.textContent=t(formMessage);
  });
  $('#app').addEventListener('change',(event)=>{
    const input=event.target;
    if(input.dataset.action==='ui-language'){changeLanguage(input.value);return;}
    if(input.dataset.connectionDraft){connectionDrafts[input.dataset.connectionDraft][input.name]=input.value;invalidateConnectionTest(input.dataset.connectionDraft);}
    if(input.id==='voice-minutes'){render();$('#voice-minutes')?.focus({preventScroll:true});}
    if(input.id==='backend-enabled') {drafts.backend.enabled=input.checked;render();$('#backend-enabled')?.focus();}
  });
  $('#app').addEventListener('submit',(event)=>{
    event.preventDefault();
    if(event.target.id.startsWith('connection-')){saveConnection(event.target.id.slice(11));}
    else if(event.target.id==='voice-form'){
      state.voice={...drafts.voice,minutes:Number(drafts.voice.minutes)};
      formMessage=persist()?'已保存，下次对话生效':'已在本次预览生效，无法持久保存';render();
    } else if(event.target.id==='backend-form'){
      const tokens=Number(drafts.backend.tokens);
      if(drafts.backend.enabled&&(!Number.isInteger(tokens)||tokens<16||tokens>131072)){formMessage='原型请输入 16–131072 之间的整数；实际限制取决于模型。';render();$('#backend-tokens')?.focus();return;}
      state.backend={...drafts.backend,tokens:(!Number.isInteger(tokens)||tokens<16||tokens>131072)?state.backend.tokens:tokens};
      drafts.backend={...state.backend};formMessage=persist()?'已保存，下次对话生效':'已在本次预览生效，无法持久保存';render();
    } else if(event.target.id==='import-form'){
      if(importState.pass!=='preview'){importState.error='演示口令不匹配，请输入 preview。';render();$('#import-pass')?.focus();return;}
      importState.pass='';importState.error='';importState.step='review';render();
    }
  });
  $('#app').addEventListener('toggle',(event)=>{if(event.target.matches('details[data-connection]'))connectionOpen[event.target.dataset.connection]=event.target.open;},true);
  for(const name of ['copy','cut','dragstart'])$('#app').addEventListener(name,(event)=>{if(event.target.closest('.key-mask,.key-editor')){event.preventDefault();notify('示例密钥不能复制。');}});
  $('#app').addEventListener('keydown',(event)=>{if((event.ctrlKey||event.metaKey)&&['c','x'].includes(event.key.toLowerCase())&&event.target.closest('.key-mask,.key-editor')){event.preventDefault();notify('示例密钥不能复制。');}});
  $('#app').addEventListener('contextmenu',(event)=>{if(event.target.closest('.key-mask'))event.preventDefault();});
  window.addEventListener('hashchange',()=>{if(route()!==priorRoute)render();});
  mediaTheme.addEventListener('change',()=>{if(state.theme==='system')applyTheme();});
  window.addEventListener('pagehide',()=>{clearTimeout(responseTimer);clearTimeout(importTimer);clearInterval(callTimer);for(const kind of ['voice','backend'])invalidateConnectionTest(kind);});
  applyTheme();render();if(storageWarning)notify(storageWarning);
})();
