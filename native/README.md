# Live Voice — Android / iOS 原生客户端

**简体中文** | [English](README.en.md)

面向 **GPT-Live-1 实时语音模型**的手机客户端。当前修订为 **0.5.0-2**。[统一下载](../docs/DOWNLOADS.md) · [首次使用](../docs/GETTING_STARTED.md) · [界面截图](../docs/SCREENSHOTS.md)

当前正式项目版本为 **0.5.0**，Android 和 iOS 的应用内版本统一显示 `0.5.0`。功能、安装方式与验证范围见 [发布说明](../docs/releases/mobile-0.5.0.md)。Android 构建产物按版本保存在 `releases/android/<version>/`。

这是实际原生连接代码，不使用浏览器原型的模拟结果。Android 已用于真机内测；iOS 已完成模拟器与真机架构编译、界面烟测及合成录音编码验证，真实模型、相机和音频体验仍需 iPhone 验收。Mac 构建、免费 Personal Team 安装和验收说明见 [IOS.md](IOS.md)。

## 当前范围

- 首页标题下显示版本号，设置页“关于 Live Voice”保留版本号、作者与 GitHub 仓库地址；版本读取 package.json，并与 Android versionName 共用版本源。
- Android 与 iOS 在前台语音会话（含连接中、静音）保持屏幕常亮；结束、连接失败、系统中断或离开前台后恢复原来的自动锁屏行为，不修改系统超时设置。用户仍可手动锁屏。
- 0.3.7：新安装或缺失字段时，后端默认最大输出 32768、联网搜索开启；保留已有设置。设置页可切换自动录音，默认开启、从下一次会话生效；关闭后仍保存文字历史，已有录音保留。
- 0.3.8：历史列表长按一条会话打开快捷菜单，可直接改名、仅删除录音或删除记录（文字与录音）；两种删除分别确认，无录音时隐藏“删除录音”。单击仍进入详情，进行中的会话期间不执行历史修改。
- 0.3.9：iOS 历史列表改为向左滑动露出快捷按钮，点击后直接改名或进入删除确认；只展开一行，右滑或点回条目可收起，滑到底也不会直接删除。Android 保持长按菜单。
- 0.3.9-1：修正短划后按钮立即回弹的问题，缩短展开距离并保护已识别的横向手势。此后同一功能版本的小修复使用 `-1`、`-2` 等尾号。
- 0.3.9-2：iOS 历史操作面板去掉上方半透明遮罩，保持底部面板滑入和滑出；空白处仍可点击关闭。
- 0.3.9-3：实时字幕默认跟随底部，手动上翻暂停，滑回底部恢复。会话中保存语音风格、指令和时长时应用到当前会话；后端参数及连接用于后续请求，保留正在处理的请求。音色与语音连接仍在下一次会话使用。iOS 已连接会话支持切换 App 后继续音频与录音，使用本地 Live Activity 在灵动岛和锁屏显示状态；系统音频抢占仍结束会话，进程被终止后不自动重建连接。
- 0.3.9-4：灵动岛正常会话使用应用 Logo，静音仍用划线麦克风；连接成功后可靠建立并保留计时起点，迟到的连接中状态不会清空计时。
- 0.3.9-5：实时活动在真实连接成功事件中直接创建，首次内容即包含已连接状态和计时起点；不再依赖 React 界面刷新补齐“连接中”活动。静音、录音和后端状态也由会话事件直接同步，结束时清理尚未完成的创建请求。

- 统一通用对话入口，中英界面及浅色/深色/系统主题。
- 语音与后端独立配置 endpoint、model、鉴权方式和 key。
- 完整连接凭据作为单条 secret 写入 Android Keystore 保护的 Keychain 存储；UI 只展示 key 头尾，不提供明文或复制。
- 真实语音短会话连接探针、真实 Responses 后端测试；测试可能产生服务用量，不将模型发现接口当作连通性证明。
- 原生 WebRTC 麦克风与播放、字幕、静音、speaker/earpiece 路由切换、会话关闭及资源释放。
- client delegation 将问题交给独立后端，支持所选模型可用的 reasoning effort（含 max）、Token 上限与原生搜索，并显示返回来源。
- 说话风格可追加指令并等待服务确认；音色及其他保存参数在下次会话生效。
- 本地文字历史：最多 50 条，并有单条与总大小限制。UI 展示最近 120 个合并文本段；历史保存保留该会话的合并段。云同步和历史恢复未实现。
- Android 0.3.0：新会话自动保存双方录音，历史详情支持播放、暂停、拖动进度、前后跳转 15 秒和单条删除。首页、历史、设置采用底部导航；会话操作固定在字幕滚动区外。

Android 0.2.0 支持扫描 [PC 生成器](../pc-config/README.md)或 Windows 客户端生成的加密配置二维码，也保留手动配置。构建、自动化测试与真实相机/服务/音频验证分别记录，不以编译成功代替设备验证。

Android 0.2.1 修复点击“开始对话”时的原生闪退：应用必须声明 `ACCESS_NETWORK_STATE`，供 WebRTC 在创建 PeerConnection 时读取网络状态。缺少此普通权限会导致 Android 抛出 `SecurityException`，继而触发 WebRTC JNI 的进程终止；JS 的异常捕获无法恢复。该权限随安装授予，无需运行时弹窗。连接探针不创建 WebRTC PeerConnection，因此探针成功不能代替语音启动测试。

Android 0.3.3 取消模式选择，首页直接开始通用对话。旧练口语设置自动归一为通用，历史和录音仍可查看；练口语时直接向助手提出需求。

Android 0.3.4 支持在历史详情改名和删除会话，删除前确认文字与录音会一并删除。启用后端时，新会话保存后发送最多 6000 字符的文字摘录自动命名，单次请求最多 20 秒，无搜索、无重试，不等待命名即可开始下一次对话；失败用日期。手动名称优先，已删除记录不会被迟到结果恢复。录音标题独立保留，不随 50 条文字历史上限淘汰。

## 扫码导入连接

1. 在电脑生成加密二维码，导入口令至少 4 个字符。
2. 手机打开“设置 → 扫码导入连接”，允许相机权限并扫描。
3. 输入口令，在手机本地解密。核对服务地址、模型、鉴权方式和已遮罩的 key，选择要导入的语音/后端连接。
4. 点“测试并保存”后才会访问这些地址；所有选中连接测试通过后，一次性写入系统加密存储。测试可能产生服务用量。
5. 取消、错误口令或测试失败都保留原配置。后台切换清除未保存的导入内容；已经开始的原子保存以实际写入结果为准。

二维码只传输连接，不修改偏好、启用后端或同步历史。首次写入会把旧的独立连接合并到 v2 加密条目，未选中的连接保留。现有 v2 条目读取失败时不会回退到旧值。Android 相机由离线 ZXing 扫描，不依赖 Google Play Services；iOS 使用 AVFoundation，两端均不保存扫码照片。iOS 的 CommonCrypto / CryptoKit 解密器已通过 PC 共用的 LV1 固定向量测试，真实相机扫码另行验收。

## 会话录音

Android 0.3.1 修复真实录音在回调调度抖动时失真：每路 PCM 按采样数量连续拼接，使用整数采样位置混音，时钟仅用于首次对齐与明显的流中断；混音保留双方同时讲话所需的余量。旧的受损录音文件不会被覆盖，也无法补回已经丢失的音频。

Android 0.3.2 修复退出并重新打开应用后启动失败：Activity 的 `onHostDestroy` 只清理播放和当次录音，只有 React 模块 `invalidate` 才关闭工作线程。录音启动失败与语音连接隔离，原生录音/设备错误不会再被笼统提示为连接配置问题。`RecordingLifecycleInstrumentationTest` 覆盖重复销毁/重建、重新准备录音和最终模块失效。

- 新对话自动录制用户与助手的声音，首页告知、会话中显示录音状态。静音时不保留麦克风声音，助手声音继续保留。未建立连接的尝试会丢弃录音。
- 结束后到“历史”打开带“录音”标记的会话回放。播放使用媒体音量；进入后台、离开详情或开始新对话会停止回放。
- 文件为应用私有目录中的 AAC/M4A（24 kHz 单声道，目标 64 kbps），约 0.5 MB/分钟，实际大小随编码器变化。录音不会上传、导出或进入配置二维码，应用禁止系统备份。
- 录音独立于文字历史保留到手动删除；更早录音可分页加载，即使文字已淘汰也可播放。删除录音保留仍在本机的文字。
- 可用空间不足 64 MB 时停止录音并提示，尽力保存已录部分，通话继续。进程被强行结束的未完成录音可能无法恢复；旧的纯文字会话不能补出声音。
- Android 使用 WebRTC 采样钩子；iOS 使用自定义 VoiceProcessingIO 音频设备采集双向 PCM。输入采样可能与 WebRTC 软件音频处理后的发送帧略有不同；输出在设备音量/蓝牙编解码前采集。Android 接入理由和升级约束见 [ADR 0002](../docs/adr/0002-android-local-recordings.md)；iOS 的代码与验证边界见 [IOS.md](IOS.md)。

`RecordingInstrumentationTest` 使用两路合成音频编码再解码，验证双方频率、静音、时长、文件目录和删除；也覆盖未连接尝试不会留下录音。常规运行不保留任何测试录音。仅在 UI 验证时传 `-e keepRecordingFixture true` 生成独立合成录音，验收后通过应用删除。

## 构建

本机基线：React Native 0.86.0、Node 24、JDK 21、Android SDK 36、NDK 27.1.12297006、Gradle 9.3.1、Ninja 1.13.2。SDK 37 不可取得，因此没有沿用要求 SDK 37 的 RN 0.87 模板版本。

`scripts/build-android.ps1` 使用项目 `../work/toolchain/node-v24.21.0-win-x64`、Android Studio 自带 JBR，以及当前用户的 Android SDK。环境变量仅在构建进程中设置，Gradle 缓存位于项目 `../work/gradle`，不修改系统默认 Node/Java。

```powershell
npm ci
npm run typecheck
npm test -- --runInBand
.\scripts\build-android.ps1
```

在符合上述 Node 版本的终端运行 npm。构建脚本生成 arm64 内测 APK 到 `../releases/`，JS 已打包进安装包，运行不依赖 Metro 或电脑中转。

Windows 构建需要 `../work/toolchain/ninja/ninja.exe`：使用 [Ninja v1.13.2 官方 ninja-win.zip](https://github.com/ninja-build/ninja/releases/tag/v1.13.2)，解压前核对 SHA-256 为 `07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65`。脚本通过 CMake 参数指定该程序，避免 SDK 自带旧 Ninja 的 260 字符路径限制，不修改 SDK 内文件。

此包使用模板的调试签名，仅用于本机/设备内测，不能作为正式商店签名方案。没有任何服务 key、实际 endpoint、历史记录或录音随包分发。

### WebRTC 原生启动回归

`android/app/src/androidTest/` 包含设备测试：用实际 WebRTC 库重复三次创建 PeerConnection/DataChannel、生成并设置 SDP offer，再释放资源。测试不访问模型服务、不使用 ICE server、不读取连接配置或录音；它覆盖 JS mock 测试无法发现的原生网络监视器崩溃。实际服务接通、录音、播放和打断仍需单独验证。

使用上述构建环境，在 `android/` 执行 `:app:assembleReleaseAndroidTest`（传入与发布构建相同的架构和 Ninja 参数）。安装发布 APK 后，安装 `app/build/outputs/apk/androidTest/release/app-release-androidTest.apk`，再运行：

```powershell
adb -d shell am instrument -w -e class com.livevoiceapp.WebRtcPeerConnectionInstrumentationTest com.livevoiceapp.test/androidx.test.runner.AndroidJUnitRunner
```

先结束应用中的实际对话再运行 instrumentation，它会重启目标进程；不要卸载主应用或清除数据。测试包使用同一内测签名，手机安装防护提示按系统流程处理。

Android 0.1.1-internal 已采用选定的“微笑声波”Logo。图标来源为 `../design/logo-v1-icon.png` 和 `logo-v1-mark.png`；使用 `python scripts/generate-android-icons.py`（需要 Pillow）生成五种密度的传统图标与自适应前景，XML 提供底色和单色主题图层。

## 手机上的首次操作

部分 Android 设备通过 USB 安装时会显示厂商的安装防护提示，按系统提示完成扫描与确认后继续安装，无需关闭设备安装防护。应用名称为 Live Voice。

1. 打开应用，进入“设置 → 语音模型 → 连接配置”。
2. 输入完整 HTTPS API base URL、模型/部署名、鉴权方式和 API key。语音与后端可以来自不同地址与账号。
3. 保存连接后点“测试连接”。语音探针创建并关闭短会话，不请求麦克风权限。真实服务可能不支持这个零音频探针；失败不能自动推断 WebRTC 一定不可用。
4. 如需推理和搜索，单独配置后端并开启后端，保存参数。搜索能力与连通性测试分开验证。
5. 回首页开始对话，按需授予麦克风与蓝牙权限。尝试普通对话、说话中插话、静音/恢复和结束。
6. 结束应收到服务关闭事件；超时/网络中断会显示未确认，但仍释放本机音频。进入后台或丢失音频焦点也会停止本地会话。

不要把密钥粘贴进聊天、源码、测试用例或日志，也不要复用已遮罩的 key 文本。更换 endpoint 或鉴权方式时必须重新输入 key。

## 代码边界

- `App.tsx`：原生界面、参数草稿、权限、应用生命周期与记录展示。
- `src/live.ts`：WebRTC 生命周期、命令确认、转写与委托、短会话探针。
- `src/backend.ts`：Responses 调用、输出和来源提取、探针。
- `src/protocol.ts`：受支持字段、指令与固定错误码。
- `src/storage.ts`：Keychain 凭据、普通设置与有界文字历史。
- `src/QrImportScreen.tsx`、`src/qr-import.ts`、`src/qr.ts`：导入界面、可取消流程与相机权限桥接。
- Android `QrConfigModule`、`QrConfigCrypto`：相机扫码及 QR v1 的 PBKDF2/AES-GCM 本地解密；JVM 测试校验 PC 固定向量。
- `src/audio.ts` 与 Android `VoiceAudioModule`：通信音频模式、焦点与路由。

Android 的 OkHttp HTTP/WebSocket 客户端禁用重定向，防止用户 key 被转送到其他地址。不能用浏览器 `fetch` 的 `redirect` 参数假装实现该保护。iOS 还需单独实现并验证相同网络与音频边界。

协议依据及待验证项见 [native-protocol.md](../design/native-protocol.md)。

## 自动音频路由

手机端默认使用通信音频设备，移除手动扬声器开关。Android 12+ 使用 availableCommunicationDevices/setCommunicationDevice，保留系统已选外接设备，无外接时按接近传感器切换内置扬声器/听筒；无听筒回退扬声器。旧版使用系统通话路由和 SCO，实际兼容性需实机确认。监听在会话结束时释放并恢复原通信模式；Android 保持原有前台常亮规则。页面显示自动输出类别，不展示设备名称。

对话设置与后端参数页自动保存，不需要保存按钮或离开确认。选择项修改后立即提交，文字及输出长度停止输入 500 毫秒后提交，返回或切到后台时提交最后一笔修改。支持实时更新的语音设置等待服务确认；后端参数用于下一次请求。顶部显示保存/应用状态，失败时保留草稿并提供“重试更新”，不会显示为成功。会话中不能实时修改的设置仍禁用；连接管理继续使用独立的测试和保存操作。

iOS 支持从屏幕左边缘向右滑返回，与顶部返回按钮执行同一操作。短滑可取消，页面中间的横滑与纵向滚动不触发返回；首页、弹窗及配置正在导入时不触发。返回会提交最后一笔对话设置，保留正在进行的会话。Android 使用系统返回手势及原有 BackHandler。

设置入口按标题实际长度分配宽度，说明尽量保持单行，箭头独立固定在右侧。必须换行时，使用原生文字测量寻找保持原行数的较窄排版宽度，让各行长度接近；保留系统字号，不缩小字体或截断内容。宽度、语言或系统字号变化后重新测量，结果留出像素取整余量。
