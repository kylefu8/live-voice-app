# 设置 v3：双语、独立连接与说话风格

本轮修改对象是浏览器交互原型，不是已接通模型的原生 App。用户已确认扫码导入和手机端手动修改都要保留。

## 本轮决定

1. 外观的“跟随系统 / 浅色 / 深色”固定为同一行三列；英文对应 System / Light / Dark。
2. 界面支持中文、英文，并记住选择。切换界面语言不改变会话内容、参数草稿或正在进行的会话。
3. 移除语音页的对话语言选项。真实接入时通过对话指令跟随用户所用语言；界面语言与说话语言彼此独立。历史原文和用户编写的指令不自动翻译。
4. 语音页提供音色、语气、语调、语速偏好、自定义指令和单次会话总时长。后三类风格偏好通过自然语言指令表达，不是精确声学采样参数。
5. 语音和后端各自维护 endpoint、模型/部署、鉴权方式、API key。两套连接独立保存；从某个模型页扫码只替换对应连接，从设置页扫码可导入两套。
6. 已配置 key 只展示开头 4 位和结尾 4 位，中间固定遮罩；不提供明文显示或复制按钮，遮罩不可选取。新 key 使用密码输入，拦截复制、剪切、拖动及相关快捷键，离开参数页时清空未保存的新 key。
7. 后端增加 xhigh、max 推理强度，并提供输出 Token 上限、联网搜索、请求超时、后端指令。鉴权、模型及连接地址在独立连接区修改。

## 时长含义

“单次会话总时长”是应用对一次 session 从启动到结束的总运行时间限制，包含停顿和静音，不是单次回答时长、Token 预算或静音超时。可选择不设应用上限；这不取消服务商自己的 session 限制。原型计时器从点击开始建立示例会话时计算；正式 App 应明确从会话就绪时计算并正确关闭连接。

## 哪些设置能实时调整

2026-09-20 已读取官方页面：

- [Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations#configuration-fields)：模型、音色在 session 创建时确定，更换需新 session。对话指令可通过 `session.instructions.append` 追加。
- [Context delivery](https://developers.openai.com/api/docs/guides/live-conversations#understand-when-context-reaches-the-model)：追加指令按 session 时间线交付，确认事件不等于立即听到效果；应用应匹配 `client_event_id`、处理错误并验证后续行为。单次 append 的 content 上限为 500 tokens，实际发送前需校验。
- [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)：语气、节奏、简短回应等可用指令控制；如 backchannel 的“moderate”是提示要求，不是数值频率参数。
- [Responses delegation](https://developers.openai.com/api/docs/guides/live-delegation#configure-responses-delegation)：使用 Responses 委托时，支持在原有委托模式下更新部分后端设置；这不能直接等同于本项目采用 client delegation 时的更新实现。
- [Reasoning effort](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort)：xhigh、max 是否可用依模型而异，更高推理通常增加延迟与消耗。

原型中“保存参数”仍设置下一次 session 的默认值。正在演示对话时，可另点“仅应用到当前对话（演示）”更新语气、语调、节奏与指令的示例状态；不会换音色、重启会话或改变已保存默认值。这只是交互演示，尚未发送真实 append，也没有证明声音效果。

## 连接与密钥边界

- 改 endpoint 或鉴权方式时，要求同时输入替换 key，避免复用另一目的地址的密钥。
- 正式 App 保留独立安全存储和经确认后测试连接的流程，不把密钥加入提示词、日志、历史或公开截图。
- 当前原型仅接受 `demo-` 开头且至少 12 字符的示例 key。保存后仅保留遮罩标识，丢弃完整输入；浏览器 localStorage 没有可供真实请求使用的 key。
- 原型不发送任何模型网络请求。手动保存仅更新示例连接数据，不标记真实连通性已验证。
- “不复制”是界面操作限制，不是对设备所有者无法提取 App 运行时凭据的承诺。真正直连时设备必须能使用密钥，仍需 Android Keystore / iOS Keychain。
- Token 输入的 16–131072 是原型输入边界，不代表每个后端模型支持此上限；正式实现按部署能力验证。

## 验收重点

两套连接各有独立的“测试连接（演示）”入口，测试当前草稿而非静默读取已保存配置。它不会自动保存，修改连接字段、key 或离开正在测试的页面会取消旧结果。中英界面均包含进行中、通过、失败和重试反馈。当前只做本地格式校验与明确标记的结果模拟；实际接入时，语音测试需验证建立并关闭真实会话，后端测试需取得有效响应，单独的后端连通性测试不能证明搜索等工具可用。

- 320px 两种语言下三个外观选项始终同排，没有横向溢出。
- 旧设置与历史能够迁移加载；旧 `voice.language` 不再保留为可选偏好。
- 中英切换不改用户指令、历史原文或正在进行的会话；参数和连接字段草稿保留。
- 语音/后端连接互不覆盖，原有 key 遮罩不会被空输入覆盖；新 key 保存后不在 DOM、普通存储或日志中出现完整值。
- `max` 保存和刷新后仍保留；风格演示应用不替换当前音色或 session，总时长标签及说明明确。
