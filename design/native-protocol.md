# 原生直连协议契约

GPT-Live-1 Android 首版的协议边界：手机直接连接已配置的实时语音 endpoint，以及可选的后端 Responses 兼容 endpoint。PC 二维码只负责传递配置，运行时不增加 App 中转服务。本文件是实现契约和测试清单，不包含真实地址、密钥或真实会话。

核对日期：2026-09-20。官方资料只读核对，未调用真实 API。

## 1. 适用范围和信任边界

本契约只覆盖：

- GPT-Live-1 的 WebRTC 连接、`oai-events` data channel、Live session 生命周期。
- `delegation: { type: "client" }` 下由手机自己运行后端请求并把结果送回 Live。
- 手机端音频轨道、转写、用户插话、关闭和连接测试的状态管理。

手机直连是产品已确认的要求，因此实现不添加 relay 或 sideband 中转。官方 WebRTC 示例把 `POST /v1/live/sessions` 和项目 API key 放在可信应用服务器；手机直连意味着 key 会被设备使用，即使使用 Keystore 保护也不能把它当成服务端密钥。endpoint 是否允许这种客户端认证、是否需要额外的移动端授权，必须由实际服务和真机验证；这不改变本契约的直连边界。

后端模型沿用现有 demo 的独立请求方式：手机根据本地保存的转写历史请求 `POST {backendEndpoint}/responses`，再把经过校验的结果发送给 Live。delegation 事件本身不包含用户任务文本。

## 2. WebRTC 建立顺序

连接尝试必须有独立的 `attemptId`/generation。所有异步回调先检查它仍是当前尝试，旧尝试的事件、SDP 和后端结果一律丢弃。

状态顺序：

```text
idle
  -> preparing
  -> offer_ready
  -> create_pending
  -> answer_received
  -> waiting_started
  -> running
  -> closing
  -> closed | failed
```

建立流程：

1. 在用户点击开始后取得麦克风权限，创建 `RTCPeerConnection`，添加本地音频 track。
2. 在创建 SDP offer 前创建并注册 `oai-events` data channel 的所有监听器。
3. `createOffer()`、`setLocalDescription()`，等待 `iceGatheringState === "complete"`，设置有限超时。
4. 对配置的实时语音 endpoint 发起 `POST /live/sessions`（如果 endpoint 已含版本路径，按配置拼接；不得写死另一个 provider 地址）。请求体为：

   ```json
   {
     "session": {
       "model": "gpt-live-1",
       "instructions": "...",
       "audio": { "output": { "voice": "marin" } },
       "delegation": { "type": "client" }
     },
     "transport": {
       "type": "webrtc",
       "sdp": "<local SDP offer>"
     }
   }
   ```

   WebRTC 不在 `session` 中设置 `audio.format`；音频格式由 SDP 协商。鉴权头由连接配置决定，不能猜测 `Bearer` 与 `api-key` 的替代关系。

5. 期待成功响应中的 `session.id` 和 `transport.sdp`：

   ```json
   {
     "session": { "id": "live_..." },
     "transport": { "type": "webrtc", "sdp": "<remote SDP answer>" }
   }
   ```

6. `setRemoteDescription({ type: "answer", sdp: result.transport.sdp })`。
7. 等待 data channel 收到 `session.started`，确认 `event.session.id` 后才发送应用命令。

`POST /live/sessions` 已经启动 session；**WebRTC data channel 上不得发送 `session.start`**。`session.start` 只属于 Live WebSocket 连接的启动流程，不能混入 WebRTC。

官方依据：[WebRTC 连接顺序](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)、[Live WebSocket 启动顺序](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)。

## 3. 媒体和 data channel

### 音频轨道

- 本地麦克风音频通过 WebRTC audio track 发送；不要在 data channel 发送 `session.input_audio.append`。
- 远程语音通过 `ontrack`/接收的远程 audio track 播放到当前手机音频路由；不要期待 `session.output_audio.delta`。
- 音频播放器若有本地缓冲，必须保留可清空的队列；清空队列是应用播放器行为，不是 Live 事件。
- 释放顺序：先完成或标记 session 关闭，再停止本地 tracks、解绑远程 track、关闭 data channel 和 peer connection。
- 手机静音按钮可以立即禁用本地 track；若还发送 `session.input_audio.mute`，要等待 `session.input_audio.muted`。协议静音不会停止模型输出或后端工作。

### 全双工和插话

GPT-Live 被设计为全双工：用户和助手可以同时说话，用户插话时模型应停止当前回答并听取新内容。插话主要由持续的输入媒体和会话指令/提示行为完成；Live 文档没有为普通用户插话定义一个需要客户端发送的 `response.cancel` 事件。不要把 Realtime API 的 `response.cancel` 机制带入本协议。

口语模式的初始 instructions 应明确类似“用户插话时停止说话并听取用户”。`session.instructions.append` 也能中断当前模型语音或行为，但只改变 Live 的会话行为，**不会取消手机已经启动的后端任务**。

手机自己的播放策略必须独立处理：用户插话时可以停止/清空本地排队音频；如果不做本地缓冲，就让 WebRTC 远程 track 由音频路由播放，并以新的输入转写驱动 UI。不能把 `session.commentary.appended` 当成“已经播放完毕”，它只表示上下文注入已被接受。

官方依据：[管理转写与全双工](https://developers.openai.com/api/docs/guides/live-conversations#manage-speech-and-transcripts)、[Live 提示中的 interruptions](https://developers.openai.com/api/docs/guides/live-prompting#interruptions)、[播放控制](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#control-playback-when-needed)。

## 4. client delegation 事件契约

### 4.1 触发事件

session 创建时固定使用：

```json
{
  "model": "gpt-live-1",
  "delegation": { "type": "client" }
}
```

收到以下事件后启动手机自己的后端工作：

```json
{
  "type": "session.delegation.created",
  "event_id": "event_delegation",
  "offset_ms": 1000,
  "delegation": {
    "id": "item_9tA2bF3h7K9m2P5q8R1s4",
    "type": "delegation",
    "target": "client"
  }
}
```

必须保存 `delegation.id` 原值，后续更新使用同一个值。事件没有用户 utterance 或任务文本，也没有需要回送的 delegation ack。手机应把 `session.input_transcript.delta`、`session.output_transcript.delta` 和本地任务状态组合成后端输入；不能从该事件猜测任务内容。

同一个 delegation ID 只启动一次。另行生成应用自己的 `operationId` 和 `taskRevision`，分别用于后端副作用幂等和新输入覆盖旧请求。

### 4.2 手机后端请求

现有 demo 的对应行为为：

- 将近期 user/assistant 转写作为 Responses `input`，而不是把 delegation 元数据当作问题。
- 请求 `{backendEndpoint}/responses`，`store:false`。
- 使用配置的 backend model、instructions、tools、`max_output_tokens` 和 `reasoning.effort`；`reasoning.effort: "none"` 时省略 reasoning 字段。
- 工具调用逐轮提交 `function_call_output`，最多有限轮；后端失败或任务 revision 过期时不把旧结果送入当前 session。

手机应用可用 `AbortController` 取消仍可取消的 HTTP/本地任务，但“用户插话”本身不等于后端副作用已取消。对已开始的操作要检查应用状态；重连或重试时不能因迟到响应重复执行预约、写入等动作。首版后端工具应保持无外部写入，直到另有明确要求。

### 4.3 返回结果、内容类型和 ack

后端结果应按用途选择一种 Live append 事件：

| 用途 | 事件形状 | Live ack |
| --- | --- | --- |
| 要让模型在后续回答中使用、追加时不朗读 | `session.thinking.append` | `session.thinking.appended` |
| 要让模型向用户说出并自然转述 | `session.commentary.append` | `session.commentary.appended` |
| 要改变全 session 的系统级行为、如让它停止说话 | `session.instructions.append` | `session.instructions.appended` |

三个事件都使用纯字符串 `content`，每次 append 最多 500 tokens，并带原 delegation ID；与任务无关的会话级更新带 `delegation_id: null`。例如要返回后端已确认的结果：

```json
{
  "type": "session.commentary.append",
  "event_id": "result_123",
  "delegation_id": "item_9tA2bF3h7K9m2P5q8R1s4",
  "content": "The order shipped today and should arrive tomorrow."
}
```

对应 ack 至少按以下规则处理：

- 在待确认表中用 outgoing `event_id` 做 key。
- 收到 `session.commentary.appended`、`session.thinking.appended` 或 `session.instructions.appended` 时，用 `client_event_id` 找回发送项并标记“已接受”。
- ack 只表示预计已注入上下文，不表示模型已经说完或音频已经播放。
- 收到 `error` 时优先使用 `error.client_event_id` 关联失败项；没有关联 ID 时只更新会话级错误，不把任意待确认项误标记为成功。
- 分片发送时每片都要有独立 `event_id` 和 ack；不要因为第一片成功就认为完整答案已接受。内容不超过 500 tokens 时优先单片发送。

client delegation 的这条路径不发送 `response.create`；那是 Responses delegation 的 function-call continuation 机制。后端已经完成并 append 结果后，等待 Live 自己决定口语化表达。

官方依据：[client delegation](https://developers.openai.com/api/docs/guides/live-delegation#configure-client-delegation)、[接收 delegation](https://developers.openai.com/api/docs/guides/live-delegation#receive-a-client-delegation)、[更新类型和 ack](https://developers.openai.com/api/docs/guides/live-delegation#send-the-right-kind-of-update)。

## 5. 转写、状态和用量

持续处理：

```json
{
  "type": "session.input_transcript.delta",
  "event_id": "event_transcript_1",
  "delta": "What is",
  "start_ms": 1000,
  "end_ms": 1200
}
```

`session.output_transcript.delta` 使用同样的 `delta/start_ms/end_ms` 结构。片段不是完整 turn，必须原样追加并保留时间；不要用网络到达时间代替模型时间。新输入出现时增加 `taskRevision`，让过时的后端结果不能再次播报。

`session.usage.updated.usage.seconds` 是累计快照：收到 12 后再收到 15，当前使用量是 15，不是 27。`session.closed.usage.seconds` 是最终值，应保存一次。后端 token usage 独立统计。

## 6. 关闭、创建失败和迟到响应

### 正常关闭

1. 在发送关闭命令前注册 `session.closed` 监听器。
2. 进入 `closing`，停止发送新的音频、delegation 结果和应用命令。
3. 发送 `{ "type": "session.close", "event_id": "close_1" }`。
4. 保持 peer、data channel、远程音频和事件循环存活，直到收到 `session.closed`。
5. 记录最终 `usage.seconds`、`reason` 和会话快照，再释放音频设备与 WebRTC 资源。
6. 使用 15 秒应用超时；超时后释放本地资源，但把 finalization 标为 `unconfirmed`，不能伪造最终 usage。

`session.closed.reason` 可能包括 `close_requested`、`expired`、`content`、`remote_hangup`、`connection_lost`。收到该事件即确认 Live 已完成收尾，即使 reason 是连接丢失；data channel/peer 先断而没有该事件时，最终用量保持未确认。

### 建立期间取消和迟到 HTTP 响应

取消必须始终释放本地资源，但要区分“本地已清理”和“远程 session 已确认关闭”：

- 在 `create_pending` 中取消：abort SDP 创建请求（若仍可取消），停止本地 tracks，关闭 data channel/peer，并将 attempt 标为 canceled。
- HTTP 响应迟到后先比较 attempt generation；旧响应不得调用 `setRemoteDescription`、不得设置当前 session ID、不得把事件交给新尝试。
- 若迟到响应含有完整 `session.id`/SDP，且取消前尚未进入当前 transport，丢弃它；不要自动重试。若服务端仍需要显式关闭，当前直连协议没有官方文档化的独立 HTTP close 兜底，必须由 endpoint 提供方验证；否则只能标记远程 finalization 未确认。
- 若 race 导致已收到 `session.started`，并且 data channel 仍可用，按正常关闭发送 `session.close`，等待 `session.closed`；之后才能释放远程会话状态。
- SDP 设置失败、data channel 在 `session.closed` 前异常关闭、或连接创建返回错误时，同样释放本地资源并保存“未确认”标志；不要把它当作正常结束。
- 新 attempt 的所有事件按 generation 过滤；旧后端任务按 `taskRevision`/`operationId` 过滤。即使旧结果迟到，也不能覆盖新口语回答。

这一区分很重要：WebRTC 创建请求本身会产生初始化计费，即使用户还没开始说话；本地取消不等于已消除该费用。

## 7. 不采集麦克风的连接测试

推荐把“连接测试”和“WebRTC 能否通话”分开显示。

### WebSocket 短探针（协议可行性，需 provider 验证）

Live WebSocket 文档规定连接 `wss://api.openai.com/v1/live/sessions`、发送 `session.start`、等待 `session.started` 后才发送音频或应用命令。文档没有把“必须先发送麦克风音频”列为建 session 的前置条件，因此可以实现一个不打开麦克风的短探针：

1. 通过配置的 voice endpoint 建立 WebSocket，带配置的鉴权头。
2. 发送一次 `session.start`，包括 model、WebSocket 所需的 `audio.format`/voice 和 `delegation: { type: "client" }`；不发送任何 `session.input_audio.append`。
3. 收到 `session.started` 后立即发送 `session.close`，等待 `session.closed`，记录最终 usage，再关闭 socket。
4. 若没有 `session.started` 或 `session.closed`，显示“连接未完成/用量未确认”，不要显示成功。

这个探针只能检查鉴权、model、Live WebSocket 启动和收尾；它不能证明 WebRTC SDP、ICE、远程音频或设备麦克风可用。官方没有明确承诺所有兼容 endpoint 都允许零音频 probe，首版实现应以合成测试覆盖、以真实配置做一次短验证。

### 计费提醒

- Live voice session 按实际从建立到关闭的活动秒数计费；静音也不会让 session 停止计费。
- `POST /v1/live/sessions` 的 WebRTC 初始化会计 15 秒 voice duration，该 15 秒计入运行时总量，不应再额外相加；因此不要用 WebRTC 创建请求反复做无麦克风测试。
- WebSocket 的短 probe 没有文档化的“免费”保证；虽可不发音频，仍应按一个真实短 session 提醒用户可能产生 voice 费用。
- 探针不触发 client delegation（没有用户语音任务），但仍可能产生 Live voice usage；后端模型不会因为探针自动调用。

官方依据：[WebSocket 启动与事件](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)、[voice session 与 WebRTC 初始化费用](https://developers.openai.com/api/docs/guides/voice-latency-cost.md?api=live#voice-session-costs)。

## 8. 与现有 demo 的核对结果

只读检查了 `demo/server.mjs`、`backend.mjs`、`delivery.mjs` 和 `public/index.html`，没有读取 `.env` 或 `work`。

| 位置 | 已有行为 | 原生端采用结论 |
| --- | --- | --- |
| `server.mjs:226-227` | 以 `POST /live/sessions` 发送 `session` + `transport: { type: "webrtc", sdp }`，使用 `delegation: { type: "client" }` | 保留请求结构；把创建和鉴权移到手机直连层 |
| `server.mjs:110` | 服务端另开 `/live/sessions/{id}/attach` WebSocket | 原生直连不复制该 sideband；手机自己接收 `oai-events` |
| `server.mjs:123-135` | 处理转写、delegation、累计 usage 和 `session.closed` | 保留 generation、delegation ID、累计快照和 finalization 状态 |
| `server.mjs:85-107` | 用转写历史运行后端，检查 `closing`/`taskVersion` 后才 enqueue | 保留；补充 `operationId` 和迟到结果丢弃 |
| `backend.mjs:5-6,22-55` | 请求 `/responses`，`store:false`，处理工具循环、reasoning 和 usage | 可移植为手机后端 adapter；不得把真实 key 写入日志或普通偏好 |
| `delivery.mjs:31-36` | 用 `session.commentary.append` 发送结果并按 `session.commentary.appended` 计 ack | 保留事件和 ack；分片时每片独立 ID |
| `delivery.mjs:44-49` | 以 `session.instructions.append` 提醒 Live 播报 | 只作为可选恢复策略；它不表示音频已播放，也不取消后端任务 |
| `public/index.html:2730-2735` | `ontrack` 设置远程 audio；`:2766-2794` 建 channel、offer 和 ICE 等待 | 保留媒体/协商顺序；native 播放器替换 HTML audio |
| `public/index.html:2569-2586` | 发送 close，最多等待 2.5 秒后调用 demo 自己的 close API | 原生遵循官方等待 `session.closed`；15 秒超时后只标记未确认，没有 demo close API 兜底 |

## 9. 合成事件测试用例

测试只使用合成 JSON、假的 SDP、假的 endpoint 和假的 key；不请求真实服务，不保存真实配置。每个测试都应带一个唯一 attempt generation。

| ID | 合成输入 | 期望结果 |
| --- | --- | --- |
| `webrtc-no-session-start` | HTTP 返回有效 answer；data channel 依次收到 `session.started` | 建立前不发任何 data-channel 命令；成功后只把状态置为 `running`，发送记录中不存在 `session.start` |
| `webrtc-ice-order` | `iceGatheringState` 先 `gathering` 后 `complete` | POST 使用完整 local SDP；超时或取消时不发送不完整 SDP，并释放 peer/tracks |
| `webrtc-remote-audio` | 合成 `ontrack` 远程 audio track；data channel 没有 audio delta | 播放器绑定远程 track；不等待或解析 `session.output_audio.delta`；cleanup 时解绑并释放 |
| `delegation-shape` | 上述 `session.delegation.created` + 两个 transcript delta | 保存原始 delegation ID；后端输入来自转写历史；不从 delegation event 读取任务文本；同 ID 不重复启动 |
| `commentary-ack` | 发送 `session.commentary.append`，收到匹配 `session.commentary.appended.client_event_id` | 只标记“已接受”；不标记“已播放”；无匹配 ID 的 ack 不改变其他项 |
| `thinking-and-instructions-ack` | 分别发送 thinking/instructions，收到各自 appended ack | 使用同名 ack；`instructions` 可改变后续行为，但不能假设已取消后端或已完成音频 |
| `delegation-error` | `{type:"error", error:{client_event_id:"result_1", ...}}` | 只使 `result_1` 失败；保留会话；不把错误重试成另一条 commentary |
| `full-duplex-interrupt` | 先收 output transcript，再收新的 input transcript；后端结果延迟到达 | 播放器清空本地排队音频或停止当前播放；递增 task revision；迟到旧结果不 append；发送记录无 `response.cancel` |
| `close-ack` | 预先安装 closed listener，发送 `session.close`，收到 `session.closed` 含 `usage.seconds=15` | 在 closed 前不停止 peer/data channel；保存 15 秒和 reason；之后才释放所有媒体资源 |
| `usage-is-cumulative` | `session.usage.updated` 为 12、再为 15，最后 closed 为 15 | 当前 usage 始终取最新快照；不显示 27；final usage 取 closed 的 15 |
| `close-timeout` | 发送 close 后 15 秒内没有 closed | 释放本地资源，状态为 `finalization: unconfirmed`；不伪造最终 usage，不把它显示为正常关闭 |
| `late-create-response` | attempt A 已取消；随后 HTTP 返回 session ID/SDP；attempt B 已开始 | A 的响应不调用 setRemoteDescription、不修改 B、不连入当前 UI；若有已知关闭通道才尝试关闭 A，否则记录远程状态未确认 |
| `started-after-cancel` | A 取消后仍收到 `session.started` | 旧 generation 事件不进入 B；若 A channel 仍可用，发送一次 close 并等待 closed；否则释放并标记未确认 |
| `close-before-answer` | create pending 时取消，HTTP 随后失败或 answer 无效 | 本地 abort/peer/tracks 全部释放；不重复创建；错误文案区分“未启动”和“已启动但未确认” |
| `backend-late-result` | delegation A 启动后用户产生 revision B，A 后端结果最后返回 | A 的结果可记录但不送 Live；B 继续使用最新历史；operation ID 防止副作用重复 |
| `websocket-no-mic-probe` | 合成 WebSocket open → `session.started` → close → `session.closed`，无 audio append | 探针成功且无麦克风权限请求；报告“WebSocket 生命周期通过”，同时明确未验证 WebRTC/音频；显示可能产生 voice 费用 |
| `websocket-probe-timeout` | open 后无 started，或 close 后无 closed | 超时失败；关闭 socket；final usage 未确认；不显示连接成功 |

## 10. 尚未由官方文档确认的点

- 官方 WebRTC 页面以浏览器和可信应用服务器为示例，没有为“把标准 project API key 放进原生手机直连”给出安全保证；必须在真实 endpoint 和目标 Android 设备上验证。
- 官方没有定义普通用户插话的独立 cancel 事件，也没有承诺某个可观测的“输出音频已停止”事件；打断延迟和播放器清空必须做真机验收。
- 官方没有明确承诺每个 Live WebSocket endpoint 都支持完全不发送音频的短 probe；这里利用“`session.started` 后才发送音频”的协议顺序作最小探针，需用合成测试和一次受控真实验证确认。
- 当 WebRTC `POST /live/sessions` 已创建但手机在收到 SDP 前取消时，官方资料没有提供独立客户端 HTTP close 端点；直连模式只能保证本地资源释放，远程 finalization 可能未确认。不要把这个状态伪装成已关闭。

以上不确定点不应通过引入中转后端来“默认解决”；若服务提供方要求服务端创建/关闭 session，应在连接配置兼容性检查中明确失败原因。

