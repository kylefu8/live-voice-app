# iOS 开发与真机验证

**简体中文** | [English](IOS.en.md)

Live Voice 是面向 **GPT-Live-1** 的实时语音客户端。[使用指南](../docs/GETTING_STARTED.md) · [下载说明](../docs/DOWNLOADS.md) · [截图](../docs/SCREENSHOTS.md)

iOS 与 Android 使用同一个 React Native 应用和本机数据协议。Mac 上构建 iOS，不需要 PC 充当对话服务；连接凭据仍由用户在手机扫码导入或手动配置。

## 构建环境

- Apple Silicon Mac；Xcode 16.1 以上、iOS 15.1 以上（实际要求由当前 React Native 依赖决定）。
- Node 24、Ruby 3.4、Bundler；Ruby gems 安装在项目的 `work/ruby-gems`。
- 从仓库根目录进入 `native` 执行 `npm ci`，然后执行 `bash scripts/build-ios.sh simulator`。
- 脚本执行 CocoaPods 安装及 Release 模拟器构建，JS 打入包，不依赖 Metro。模拟器使用本地临时签名以支持 Keychain，不需要开发者账户。产物在项目 `work/ios-build/Build/Products/Release-iphonesimulator/LiveVoiceApp.app`。
- 如果系统 Command Line Tools 比 Xcode 更新，Ruby 扩展编译可能误选系统 SDK；脚本仅为该依赖安装过程指定当前 Xcode 的 macOS SDK，不切换系统的默认开发工具。
- 使用 Xcode 打开 `ios/LiveVoiceApp.xcworkspace`，不要打开 `.xcodeproj`。每次更新依赖或工程文件后重新运行 `bundle exec pod install`，保留 React Native 对新 Xcode 的编译设置。
- 小修复的界面版本使用 `package.json` 中的 `0.3.9-1` 形式。iOS 的 `MARKETING_VERSION` 保持三段数字（如 `0.3.9`），同时递增 `CURRENT_PROJECT_VERSION`（构建号），构建脚本会去掉界面版本的修复尾号。
- Live Activity 的 Widget Extension 由 `bundle exec ruby scripts/setup-ios-live-activity.rb` 配置；同步新增源文件后从 `native/` 运行。主应用与扩展必须使用相同营销版本和构建号，在本机使用同一签名团队。仅本地 ActivityKit 更新，不启用 APNs 或 App Groups，也不向锁屏发送文字内容或凭据。

## 真机安装

1. 用户本人在 Xcode Settings → Accounts 登录 Apple ID；密码、验证码不进入代码、终端或聊天。
2. 将 iPhone 通过 USB 连接 Mac，解锁并信任电脑；按手机提示启用开发者模式。
3. 选择 LiveVoiceApp target，在 Signing & Capabilities 中启用自动签名，选择自己的 Personal Team 或开发者团队。若默认 Bundle Identifier 已被占用，在本机选择唯一标识。
4. 选择 iPhone 运行。普通 Apple ID 可用于自己的设备测试，免费签名有有效期和功能限制；TestFlight 或 App Store 分发另需开发者计划。
5. 如用命令行签名，在本机设置 `DEVELOPMENT_TEAM` 后运行 `bash scripts/build-ios.sh device`。团队标识、签名证书、provisioning profile 和账户状态不进仓库。

## 原生接入

- `VoiceAudio` 管理麦克风权限、通信音频会话、扬声器/系统路由及中断。权限先于 JS 会话初始化，以免首次系统授权弹窗取消新会话。
- `UIBackgroundModes=audio` 允许已连接会话在切换应用后维持音频。普通退后台不结束连接或录音；连接中退后台仍取消启动，真正的音频中断仍结束会话。回到前台按开始时间恢复计时和屏幕常亮。没有承诺进程被系统终止后的自动续接。
- `LVAudioDevice` 在 React Native factory 创建前安装到 WebRTC，使用单一 VoiceProcessingIO 单元，双方 PCM 交给独立录音引擎；录音不会再次占用麦克风。
- `VoiceRecording` 对接已有自动录音、播放、历史改名与删除界面。录音保留在应用私有目录并排除备份，不随二维码传输。
- `QrConfig` 使用 AVFoundation 扫码、CommonCrypto PBKDF2 和 CryptoKit AES-GCM，与 PC 的 LV1 格式兼容。相机与录音权限说明含中英文。
- iOS 凭据使用 Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`；固定连接条目通过 `SecItemUpdate` 更新，不采用先删除再添加，避免保存失败丢失旧配置。HTTP 请求处理器拒绝重定向，避免离开配置的服务地址。

## 会话中的设置

连接中、通话中与结束中禁用音色、语音连接和录音开关，扫码导入也禁用；会话结束后恢复。连接稳定后可修改语音风格、指令、时长和后端参数/连接。连接中和结束中暂停参数保存。语气、语调和节奏是模型行为偏好，并非精确声学控制；收到指令确认不能当作听感已验证。

模拟器可使用 `ENTRY_FILE=ios-tests/ui/SettingsLockHarness.tsx` 运行 `testInCallSettingsLocks`，在不调用模型、不采集麦克风且不改真实配置的情况下，验证生产界面的禁用和结束后恢复。正式构建必须清除该入口，并确认包不含 `Settings lock harness`。

## 必须分别验收

iOS 的启动延迟诊断只保留最近一次会话，写入本机缓存 `Library/Caches/LiveVoiceDiagnostics/latest.json`。记录固定名称的连接、首段转写、后端请求事件以及前一分钟每两秒一次的音频/WebRTC 数值计数，不记录文本、音频、凭据、地址或服务端会话标识。下次开始覆盖，缓存可被系统清理；不上传。诊断失败不阻塞通话，结束后停止采样。

事件和采样的毫秒数相对 `connect()`；原生 `firstCaptureMs`/`firstPlayoutMs` 相对更早的音频会话激活，不能直接相减。转写事件时间是本机收到事件的时间；输入峰值只能证明存在音频信号，发包计数只能证明本机发送，不能证明可辨认的人声或服务端已经收到。输出回调可能是静音，不能将首个播放回调当作助手开始讲话。用这些指标定位后，再以真机复现验证原因。

构建通过不能代替声音验证。依次检查：启动与中英文页面、Keychain 配置保存与重启、固定二维码解密向量、真机相机扫码、首次麦克风授权、真实语音与后端连接、连续对话与打断、扬声器/听筒/蓝牙、录音中静音、双方回放音质、退后台和系统中断、历史改名与连录音删除。

可用 `ios-tests/qr/main.swift` 在 Mac 直接编译运行共用固定向量测试；合成录音测试只能证明采样和编码行为，仍需 iPhone 实际试听。构建、模拟器、合成音频与真实服务结果分别记录在本机 `VERIFICATION.md`，不上传用户会话和录音。

`SessionRuntimeUITests` 使用独立的模拟器入口 `ENTRY_FILE=ios-tests/ui/SessionHarness.tsx`，验证真实 ScrollView 的字幕跟随以及 ActivityKit 的开始、切后台和结束；不调用模型、不启用麦克风。只对模拟器运行该入口，随后清除 `ENTRY_FILE` 重新构建正常应用。发布包必须确认不含 `Session UI harness`，这些测试不能代替真机后台通话与录音试听。

历史快捷菜单的 UI 测试为 `testHistorySwipeActions`。先停止模拟器中的 App，用 `simctl get_app_container <模拟器标识> com.kylefu.livevoice data` 取得数据目录，再运行 `python3 scripts/ios-history-fixture.py seed <数据目录> <work下新的备份文件>`。用 `-parallel-testing-enabled NO` 在同一模拟器运行测试。测试后重新获取数据目录（Xcode 安装可能更换容器路径），运行脚本的 `verify` 检查改名、仅删录音保留文字和整条删除，再停止 App 并运行 `restore` 恢复测试前数据。脚本只接受 CoreSimulator 容器，合成静音录音，无真实模型请求；缺少合成记录时该项 UI 测试会明确跳过。

搜索来源默认折叠为带数量的一行入口，展开后在限高列表内独立滚动，不随来源数量增长占满字幕区。新会话或新一批搜索结果到达时恢复折叠；查看当前来源时的普通字幕更新不改变展开状态。

自动音频路由：手机不再提供手动输出开关。iOS 使用 PlayAndRecord/VoiceChat 与蓝牙通话选项；用 DefaultToSpeaker 作为内置回退，不强制 Speaker override。已连接后才启用接近监测，耳机路由优先，内置设备随远近在扬声器/听筒之间切换。iOS 接近监测可能触发系统屏幕防误触，移开恢复；停止/销毁恢复原音频类别与监测状态。显示的设备类别来自系统路由，不包含设备名称。

`AudioRoutingHarness.tsx` 与 `AutomaticAudioTests/testAutomaticRoutingBridge` 可在模拟器验证真实原生激活/自动路由入口/清理，断言没有采集音频帧。模拟器没有真实蓝牙和接近传感器；耳机插拔、实际输入输出及贴耳切换必须在 iPhone 单独验收。正式包不得包含 `Audio routing harness`。
