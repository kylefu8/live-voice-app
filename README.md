# Live Voice — GPT-Live-1 语音客户端

**简体中文** | [English](README.en.md)

Live Voice 是面向 **GPT-Live-1 实时语音模型**的 Android、iOS 和 Windows 客户端，支持自然对话与随时打断。语音连接必须指向提供 GPT-Live-1 协议的服务；独立的后端 LLM 用于推理和联网搜索，建议 GPT-5.6 或以上。

## 下载

**[统一发布页：Windows 和手机端都在这里](https://github.com/kylefu8/live-voice-app/releases/latest)**

| 平台 | 当前版本 | 安装方式 |
| --- | --- | --- |
| Windows（PC） | 0.2.0-2 | [下载 ZIP](https://github.com/kylefu8/live-voice-app/releases/download/mobile-v0.5.0-2/live-voice-windows-0.2.0-2-x64.zip)，完整解压后运行 `Live Voice.exe` |
| Android | 0.5.0-2 | [下载 APK](https://github.com/kylefu8/live-voice-app/releases/download/mobile-v0.5.0-2/live-voice-android-0.5.0-2-arm64-v8a.apk)；旧测试版见[签名切换](docs/SIGNING-TRANSITION.md) |
| iOS | 0.5.0-2 | 通过 Mac/Xcode 签名安装，见 [iOS 安装说明](native/IOS.md)；目前没有 App Store/TestFlight 下载 |

安装细节、版本区别和校验方式见 [下载说明](docs/DOWNLOADS.md)。旧内部版本不作为公开下载提供。

## 推荐使用方法

![Foundry 部署、Windows 配置和二维码、手机扫码后直连模型](docs/images/recommended-setup.png)

[查看完整流程图](docs/images/recommended-setup.png)

1. **部署模型**：在 Microsoft Foundry 部署 `gpt-live-1` 和后端 LLM（建议 GPT-5.6 或以上），取得两组 endpoint、API key 和实际部署名称。可用性以项目、地区和访问资格为准。
2. **安装 Windows**：下载并完整解压 PC 版 ZIP，运行 `Live Voice.exe`。
3. **配置连接**：在 **设置 → 连接管理**分别填写语音和后端连接，保存并分别测试；再到对话设置启用后端模型。
4. **生成二维码**：在 **连接管理 → 生成配置二维码**选择两组连接，设置并确认至少 4 位的导入口令。
5. **安装手机端**：Android 安装 APK；iOS 使用 Xcode 签名安装。
6. **扫码导入**：手机进入 **设置 → 连接管理 → 扫码导入连接**，输入相同口令，核对后**测试并保存**。在手机的 **对话设置 → 后端推理参数**中单独启用后端。
7. **开始使用**：回首页点击**开始对话**并授予麦克风权限。手机直接连接模型，Windows 可以关闭。

[完整步骤、字段说明和常见问题](docs/GETTING_STARTED.md)

## 界面预览

以下截图由实际界面代码和演示数据生成，不包含私人设备信息、真实连接、密钥或会话。它们用于展示界面，不是实时模型调用的证明。

**Windows**

![Windows：面向 GPT-Live-1 的对话首页](docs/images/screenshots/desktop-home-zh.png)

**手机端**

<p>
  <img src="docs/images/screenshots/mobile-home-zh.png" width="260" alt="手机端 GPT-Live-1 对话首页" />
  <img src="docs/images/screenshots/mobile-connections-zh.png" width="260" alt="手机端连接管理：演示地址与遮罩密钥" />
</p>

[查看完整截图：设置、模型连接、后端参数、历史与二维码](docs/SCREENSHOTS.md)

## 支持的功能

| 功能 | 手机端 | Windows |
| --- | --- | --- |
| GPT-Live-1 语音对话、打断、字幕 | 支持 | 支持 |
| 独立后端 LLM、联网搜索与来源折叠 | 支持，取决于服务能力 | 支持，取决于服务能力 |
| 中英文界面、浅色/深色/系统外观 | 支持 | 支持 |
| 两类模型连接分别配置、测试、密钥遮罩 | 支持 | 支持 |
| 加密二维码联动 | 相机扫码导入 | 生成和保存二维码 |
| 对话设置在会话中更新 | 支持的设置自动保存/应用 | 保存后应用支持的设置 |
| 历史改名、删除、后端生成标题 | 支持 | 支持 |
| 双方声音录音与回放 | 支持，可在设置关闭 | 当前保存文字历史 |
| 音频设备 | 系统通信路由 | 可选输入/输出并测试 |

不能实时修改的设置会在通话中禁用。模型是否遵循语气、语调等偏好取决于实际服务；收到更新确认不等于已验证所有听感。模型调用费用由所配置服务计费。

## 数据与许可

手机和 Windows 各自直连模型、各自保留本机历史；二维码只传加密连接信息，不同步偏好、历史或录音。API key 使用系统安全存储，界面只显示头尾遮罩。

个人学习及非商业使用、修改免费；**所有商业用途和商业二次开发须事先取得 kylefu8 的书面授权**，费用另议。采用自定义[非商业许可](LICENSE.zh-CN.md)，属于源码可用许可；第三方组件保留各自许可。详见 [商业授权说明](COMMERCIAL-LICENSING.md) 和 [英文许可证正文](LICENSE)。

## 文档与源码

- [使用指南](docs/GETTING_STARTED.md) · [截图](docs/SCREENSHOTS.md) · [下载](docs/DOWNLOADS.md)
- [Android / iOS](native/README.md) · [Windows](desktop/README.md) · [iOS 安装](native/IOS.md)
- `native/`：手机客户端；`desktop/`：Windows 客户端；`pc-config/`：独立二维码网页工具；`prototype/`：早期交互原型。
- 开发与历史设计材料保留在各平台目录和 `design/`、`docs/adr/`。本机配置、构建缓存、诊断、真实截图和录音不入库。
