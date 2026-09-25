(() => {
  'use strict';

  // Chinese is the source language for the prototype.  Keeping the source
  // text as the key makes calls readable in the render code and lets a
  // missing English translation remain visible during review.
  const entries = [
    ['测试连接（演示）', 'Test connection (demo)'],
    ['正在测试（演示）…', 'Testing (demo)…'],
    ['测试当前填写的配置，不会自动保存；当前仅模拟结果，不访问模型服务。', 'Tests the current form without saving. This preview simulates results and does not contact a model service.'],
    ['配置已修改或测试已取消，请重新测试。', 'Configuration changed or the test was cancelled. Test again.'],
    ['正在模拟建立语音会话…', 'Simulating voice session setup…'],
    ['正在模拟验证后端响应…', 'Simulating a backend response check…'],
    ['语音会话测试通过（演示）；未连接真实服务。', 'Voice session test passed (demo); no real service was contacted.'],
    ['后端响应测试通过（演示）；未连接真实服务。', 'Backend response test passed (demo); no real service was contacted.'],
    ['连接失败（演示）：服务响应超时。请检查配置后重试，已保存配置未改变。', 'Connection failed (demo): the service timed out. Check the configuration and retry. Saved settings were not changed.'],
    ['请求超时是一次后端请求的等待上限，不是会话总时长。', 'Request timeout limits the wait for one backend request, not the whole conversation.'],
    ['语音和后端', 'Voice and backend'],
    ['界面语言', 'Interface language'],
    ['中文', 'Chinese'],
    ['English', 'English'],
    ['Live Voice', 'Live Voice'],
    ['交互原型', 'Interactive prototype'],
    ['交互原型 · 示例数据', 'Interactive prototype · Sample data'],
    ['VOICE COMPANION', 'VOICE COMPANION'],
    ['让每次开口，', 'Make every conversation'],
    ['都像自然聊天。', 'feel natural.'],
    ['让每次开口，都像自然聊天。', 'Make every time you speak feel like a natural conversation.'],
    ['通用聊天与口语练习共用一套简单的实时交流体验。选择模式，点一下，就可以开始。', 'General chat and speaking practice share one simple live conversation. Choose a mode and tap once to start.'],
    ['这是可点击的界面演示。它不连接模型，也不访问麦克风或相机。', 'This is a clickable interface demo. It does not connect to a model or access the microphone or camera.'],
    ['原型说明', 'Prototype description'],
    ['原型范围', 'Prototype scope'],
    ['手机预览', 'Phone preview'],
    ['一键进入自然对话', 'Start a natural conversation in one tap'],
    ['随时插话，语音即时让路', 'Interrupt anytime; speech makes room immediately'],
    ['设置、历史与扫码导入集中管理', 'Settings, history, and QR import in one place'],
    ['请启用 JavaScript 查看交互原型。', 'Enable JavaScript to view the interactive prototype.'],

    ['通用', 'General'],
    ['通用模式', 'General mode'],
    ['练口语', 'Speaking practice'],
    ['口语练习', 'Speaking practice'],
    ['对话模式', 'Conversation mode'],
    ['想聊什么？', 'What would you like to talk about?'],
    ['随时开口，', 'Start speaking anytime,'],
    ['自然交流。', 'talk naturally.'],
    ['随时开口，自然交流。', 'Start speaking anytime and talk naturally.'],
    ['不用准备，从一句话开始。', 'No preparation needed. Start with one sentence.'],
    ['今天的小事，也值得聊聊。', 'Even the little things today are worth talking about.'],
    ['SPEAK NATURALLY', 'SPEAK NATURALLY'],
    ['A LITTLE CONVERSATION', 'A LITTLE CONVERSATION'],
    ['把交流，留给声音。', 'Leave communication to your voice.'],
    ['开始对话', 'Start conversation'],
    ['返回对话', 'Return to conversation'],
    ['对话', 'Conversation'],
    ['对话设置', 'Conversation settings'],
    ['对话进行中（演示） · 返回对话', 'Conversation in progress (demo) · Return to conversation'],
    ['示例配置就绪', 'Sample configuration ready'],
    ['已载入示例配置', 'Sample configuration loaded'],
    ['示例配置已就绪', 'Sample configuration is ready'],
    ['交互预览，不会打开麦克风', 'Interactive preview; the microphone will not open'],
    ['演示对话', 'Demo conversation'],
    ['演示插话', 'Demo interruption'],
    ['仅演示状态切换，不采集或播放声音', 'Demo state changes only; no audio is recorded or played'],
    ['想说就说，随时打断', 'Speak naturally and interrupt anytime'],
    ['正在建立示例会话…', 'Starting sample session…'],
    ['正在连接', 'Connecting'],
    ['正在回应', 'Responding'],
    ['正在听你说', 'Listening'],
    ['麦克风已静音', 'Microphone muted'],
    ['取消静音', 'Unmute'],
    ['静音', 'Mute'],
    ['取消静音后可以继续演示插话', 'Unmute to continue the demo interruption'],
    ['收起字幕', 'Hide captions'],
    ['展开字幕', 'Show captions'],
    ['结束对话', 'End conversation'],
    ['还没有进行中的对话。', 'There is no conversation in progress.'],
    ['当前没有进行中的对话。', 'There is no conversation in progress.'],
    ['回到首页', 'Back to home'],
    ['先结束当前对话，再切换模式。', 'End the current conversation before switching modes.'],
    ['页面不存在', 'Page not found'],
    ['会话详情', 'Conversation details'],

    ['设置', 'Settings'],
    ['外观', 'Appearance'],
    ['跟随系统', 'System'],
    ['浅色', 'Light'],
    ['深色', 'Dark'],
    ['外观主题', 'Appearance theme'],
    ['模型与连接', 'Models and connections'],
    ['语音模型', 'Voice model'],
    ['GPT-Live-1 · 音色与对话偏好', 'GPT-Live-1 · Voice and conversation preferences'],
    ['后端模型', 'Backend model'],
    ['推理与搜索', 'Reasoning and search'],
    ['扫码更新配置', 'Update configuration by QR'],
    ['从电脑导入连接信息', 'Import connection details from a computer'],
    ['会话', 'Conversations'],
    ['历史记录', 'History'],
    ['查看本机的示例文字记录', 'View sample text records on this device'],
    ['这是可点击原型。参数只保存到当前浏览器，不会发送到模型服务。', 'This is a clickable prototype. Settings stay in this browser and are not sent to model services.'],

    ['模型 / 部署', 'Model / deployment'],
    ['音色', 'Voice'],
    ['对话语言', 'Conversation language'],
    ['自动', 'Automatic'],
    ['英语', 'English'],
    ['会话时长', 'Session duration'],
    ['单次会话总时长', 'Total duration per session'],
    ['从开始到结束的整个 session 上限，包含停顿和静音；不是单句回答长度。', 'The limit for the whole session from start to finish, including pauses and mute time; it is not the length of one answer.'],
    ['自定义指令', 'Custom instructions'],
    ['例如：语气轻松一些，每次只追问一个问题。', 'For example: Keep the tone relaxed and ask only one follow-up question at a time.'],
    ['保留为空即可使用当前模式的默认风格。请勿输入密钥。', 'Leave this empty to use the current mode default. Do not enter a key.'],
    ['跟随用户语言交流，无需预设对话语言。', 'Follow the user\'s language; no conversation language needs to be set.'],
    ['说话风格', 'Speaking style'],
    ['语气', 'Tone'],
    ['自然', 'Natural'],
    ['温暖', 'Warm'],
    ['轻松', 'Relaxed'],
    ['专业', 'Professional'],
    ['语调', 'Intonation'],
    ['平稳', 'Even'],
    ['生动', 'Expressive'],
    ['语速偏好', 'Speaking pace'],
    ['适中', 'Moderate'],
    ['慢一些', 'Slower'],
    ['快一些', 'Faster'],
    ['这些偏好通过对话指令表达，不是精确声学参数。', 'These preferences are expressed as conversation instructions, not precise acoustic parameters.'],
    ['仅应用到当前对话（演示）', 'Apply to this conversation only (demo)'],
    ['风格指令已追加（演示）；音色和总时长仍在下次会话生效。', 'Style instruction added (demo); voice and total duration still apply to the next session.'],
    ['新风格会影响后续表达，不改变已播放的声音。', 'The new style affects later responses and does not change audio already played.'],
    ['音色在新会话生效；语气、语调和节奏可在对话中追加指令调整。', 'Voice takes effect in a new session; tone, intonation, and pace can be adjusted with instructions during a conversation.'],
    ['保留为空', 'Leave empty'],
    ['保存参数', 'Save settings'],
    ['保存后，下次对话生效。', 'Changes apply to the next conversation.'],
    ['保存后，下次对话生效。返回页面会保留未保存的草稿。', 'Changes apply to the next conversation. Unsaved drafts remain when you return to this page.'],
    ['有未保存的修改', 'You have unsaved changes'],
    ['已保存，下次对话生效', 'Saved; changes apply to the next conversation'],
    ['已保存，下次对话生效。', 'Saved; changes apply to the next conversation.'],
    ['已在本次预览生效，无法持久保存', 'Applied in this preview; it cannot be saved persistently'],
    ['已在本次预览生效；浏览器无法保存，刷新后可能丢失。', 'Applied in this preview; the browser cannot save it and a refresh may lose it.'],

    ['启用后端模型', 'Enable backend model'],
    ['后端模型参数', 'Backend model settings'],
    ['推理强度', 'Reasoning effort'],
    ['服务默认', 'Service default'],
    ['低', 'Low'],
    ['中', 'Medium'],
    ['高', 'High'],
    ['极高（xhigh）', 'Very high (xhigh)'],
    ['最高（max）', 'Maximum (max)'],
    ['最大输出 Token', 'Maximum output tokens'],
    ['联网搜索', 'Web search'],
    ['请求超时', 'Request timeout'],
    ['不设应用上限', 'No app limit'],
    ['无应用时长上限', 'No app time limit'],
    ['服务仍可能有时长限制。', 'The service may still enforce a time limit.'],
    ['推理强度依模型而异；更高通常更慢且消耗更多 Token。', 'Reasoning effort varies by model; higher effort is usually slower and uses more tokens.'],
    ['后端指令', 'Backend instructions'],
    ['返回的答案应简洁、适合朗读。', 'Keep returned answers concise and suitable for reading aloud.'],
    ['常用参数', 'Common parameters'],
    ['高级', 'Advanced'],
    ['这里展示示例参数。正式版本的选项以实际模型支持为准。', 'These are sample parameters. The production options depend on the model.'],
    ['后端已在草稿中关闭；保存后，下次对话只使用语音模型。', 'The backend is disabled in this draft; after saving, the next conversation will use only the voice model.'],

    ['连接配置', 'Connection settings'],
    ['服务地址（Endpoint）', 'Service address (Endpoint)'],
    ['API key', 'API key'],
    ['鉴权方式', 'Authentication method'],
    ['Bearer', 'Bearer'],
    ['API key 请求头', 'API key header'],
    ['已配置', 'Configured'],
    ['未配置', 'Not configured'],
    ['更换 API key', 'Change API key'],
    ['新的 API key', 'New API key'],
    ['留空保留原有密钥', 'Leave empty to keep the existing key'],
    ['不提供明文显示或复制', 'Plaintext display and copying are unavailable'],
    ['此原型只接受以 demo- 开头的示例 key，保存后仅保留头尾标识。', 'This prototype accepts only sample keys beginning with demo-; after saving, only the beginning and end markers are kept.'],
    ['地址需为不含账号、查询参数或片段的 HTTPS 地址。', 'The address must be an HTTPS URL without credentials, query parameters, or fragments.'],
    ['更换地址或鉴权方式时，请同时更换示例 key。', 'When changing the address or authentication method, change the sample key as well.'],
    ['请输入模型或部署名称。', 'Enter a model or deployment name.'],
    ['示例 key 至少 12 个字符，并以 demo- 开头。', 'The sample key must be at least 12 characters and begin with demo-.'],
    ['连接设置已保存（演示），下次会话使用。', 'Connection settings saved (demo); they will be used next session.'],
    ['保存连接配置', 'Save connection settings'],
    ['请选择有效的鉴权方式。', 'Select a valid authentication method.'],
    ['语音与后端连接配置相互独立。', 'Voice and backend connection settings are independent.'],
    ['接口类型', 'API type'],
    ['Responses 兼容', 'Responses compatible'],
    ['原型未连接真实服务，请勿输入真实凭据。', 'The prototype is not connected to real services; do not enter real credentials.'],
    ['示例密钥不能复制。', 'Sample keys cannot be copied.'],
    ['服务地址', 'Service address'],
    ['语音服务地址', 'Voice service address'],
    ['后端服务地址', 'Backend service address'],
    ['语音模型 / 部署', 'Voice model / deployment'],
    ['后端模型 / 部署', 'Backend model / deployment'],
    ['示例中不包含密钥', 'The sample does not contain a key'],

    ['历史会话', 'Conversation history'],
    ['仅保存在当前浏览器 · 示例文字', 'Stored only in this browser · Sample text'],
    ['会话类型', 'Conversation type'],
    ['全部', 'All'],
    ['暂无文字内容', 'No text content'],
    ['这里还没有会话记录。', 'There are no conversation records yet.'],
    ['结束一段演示对话后，可以在这里回看。', 'After ending a demo conversation, you can review it here.'],
    ['开始一段对话', 'Start a conversation'],
    ['会话记录', 'Conversation record'],
    ['这条记录不存在或已不可用。', 'This record does not exist or is no longer available.'],
    ['返回历史', 'Back to history'],
    ['会话已结束 · 示例记录', 'Conversation ended · Sample record'],
    ['我', 'Me'],
    ['助手', 'Assistant'],
    ['已打断', 'Interrupted'],
    ['只读文字记录，不会继续或恢复该会话', 'Read-only text record; this conversation cannot be resumed or restored'],
    ['聊聊周末', 'Talk about the weekend'],
    ['晚餐做什么', 'What to make for dinner'],
    ['旅行中的小故事', 'A little travel story'],
    ['周末的小故事', 'A little weekend story'],
    ['今天吃点什么', 'What to eat today'],

    ['扫码配置', 'QR configuration'],
    ['仅演示导入流程，不扫描相机、不执行加解密。请勿输入真实口令或密钥。', 'Import flow demo only; it does not scan the camera or perform encryption. Do not enter a real passphrase or key.'],
    ['将电脑上的二维码放入框内', 'Place the QR code from your computer inside the frame'],
    ['示意图案', 'Illustration'],
    ['使用示例二维码', 'Use sample QR code'],
    ['已识别示例配置', 'Sample configuration recognized'],
    ['输入导入口令', 'Enter import passphrase'],
    ['输入在电脑上设置的口令。仅首次导入时需要。', 'Enter the passphrase set on the computer. It is needed only for the first import.'],
    ['导入口令', 'Import passphrase'],
    ['隐藏口令', 'Hide passphrase'],
    ['显示口令', 'Show passphrase'],
    ['演示口令：', 'Demo passphrase:'],
    ['解密配置', 'Decrypt configuration'],
    ['重新扫描', 'Scan again'],
    ['核对连接信息', 'Review connection details'],
    ['正式 App 会在你确认后测试这些地址。当前只模拟测试结果，不发送网络请求。', 'The production app will test these addresses after confirmation. This preview only simulates the result and sends no network requests.'],
    ['测试并保存（演示）', 'Test and save (demo)'],
    ['正在演示连接测试…', 'Running demo connection test…'],
    ['查看连接失败状态', 'View connection failure state'],
    ['连接测试失败（演示）。原有配置已保留，可以重试。', 'Connection test failed (demo). The previous configuration was kept; you can retry.'],
    ['示例导入流程已完成；未连接任何真实服务。', 'Sample import flow completed; no real service was connected.'],

    ['今天', 'Today'],
    ['昨天', 'Yesterday'],
    ['返回', 'Back'],
    ['扫码更新', 'Update by QR'],
    ['本次会话时长上限', 'Session time limit'],
    ['本次音色 {voice} · {minutes} 分钟上限', 'Voice {voice} · {minutes}-minute limit'],
    ['{minutes} 分钟上限', '{minutes}-minute limit'],
    ['{n} 分钟', '{n} minutes'],
    ['{n} 秒', '{n} seconds'],
    ['{voice} · 风格：{tone}', '{voice} · Style: {tone}'],
    ['演示会话 {title}', 'Demo session {title}'],
    ['{title}（演示）', '{title} (demo)'],
    ['演示会话已结束，文字记录已保存。', 'Demo conversation ended; the text record was saved.'],
    ['演示会话已结束。', 'Demo conversation ended.'],
    ['已到本次会话时长上限，演示已结束。', 'The session time limit was reached; the demo has ended.'],
    ['本次使用临时数据，浏览器存储暂不可用。', 'Temporary data is in use because browser storage is unavailable.'],
    ['请输入 256–4096 之间的整数。', 'Enter an integer between 256 and 4096.'],
    ['原型请输入 16–131072 之间的整数；实际限制取决于模型。', 'For this prototype, enter an integer between 16 and 131072; the actual limit depends on the model.'],
    ['演示口令不匹配，请输入 preview。', 'The demo passphrase does not match. Enter preview.'],
    ['preview', 'preview'],
  ];

  const dictionary = Object.create(null);
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(dictionary, key)) {
      throw new Error(`Duplicate i18n key: ${key}`);
    }
    dictionary[key] = value;
  }
  Object.freeze(dictionary);

  function interpolate(value, vars) {
    const source = String(value);
    const values = vars && typeof vars === 'object' ? vars : {};
    return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder
    ));
  }

  function isEnglish(lang) {
    return String(lang || 'zh').toLowerCase().startsWith('en');
  }

  function t(key, lang = 'zh', vars = {}) {
    const source = String(key ?? '');
    // A missing key deliberately falls back to the source text. This keeps
    // untranslated UI visible and makes missing entries easy to test.
    const translated = isEnglish(lang) && Object.prototype.hasOwnProperty.call(dictionary, source)
      ? dictionary[source]
      : source;
    return interpolate(translated, vars);
  }

  function readVars(node) {
    const raw = node.getAttribute('data-i18n-vars');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function applyShell(lang = 'zh') {
    if (typeof document === 'undefined') return;
    const english = isEnglish(lang);
    document.documentElement.lang = english ? 'en' : 'zh-CN';

    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n') || '', english ? 'en' : 'zh', readVars(node));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria') || '', english ? 'en' : 'zh', readVars(node)));
    });
  }

  if (typeof window !== 'undefined') {
    window.LiveVoiceI18n = {t, applyShell};
  } else if (typeof globalThis !== 'undefined') {
    globalThis.LiveVoiceI18n = {t, applyShell};
  }
})();
