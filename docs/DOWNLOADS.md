# 下载与安装

**简体中文** | [English](DOWNLOADS.en.md)

Live Voice 是 **GPT-Live-1 实时语音客户端**，可另接后端 LLM。**[最新统一发布页](https://github.com/kylefu8/live-voice-app/releases/latest)** 同时提供 Windows 和 Android 下载；iOS 使用 Xcode 签名安装。

| 平台 | 文件 / 方式 | 版本 |
| --- | --- | --- |
| Windows x64 | `live-voice-windows-0.2.0-2-x64.zip` | 0.2.0-2 |
| Android arm64 | `live-voice-android-0.5.0-2-arm64-v8a.apk` | 0.5.0-2 |
| iOS | 从源码使用 Mac/Xcode 签名安装 | 0.5.0-2 |

## 安装

- **Windows：**完整解压 ZIP 后运行 `Live Voice.exe`，不要单独移动 EXE。升级前结束会话并退出旧版，再启动新版目录中的程序。沿用原用户数据目录。
- **Android：**新用户安装 APK；旧内部测试版签名不同，不能直接覆盖。请先阅读[签名切换说明](SIGNING-TRANSITION.md)，不要卸载或清除数据。
- **iOS：**目前没有 App Store/TestFlight 安装包。参照 [iOS 安装指南](../native/IOS.md)完成 Xcode 签名和设备安装；个人签名产物不作为通用 IPA 发布。

Android 使用独立发布签名，Windows 便携包目前没有代码签名。系统出现安装提示时，由设备使用者按系统流程处理。

## 校验与许可

发布附件中的 `SHA256SUMS.txt` 列出 APK 和 ZIP 的 SHA-256。Windows 可以执行 `Get-FileHash -Algorithm SHA256 <文件路径>` 后核对。

当前源码采用[非商业许可](../LICENSE.zh-CN.md)：所有商业用途须事先书面授权。第三方依赖保留自己的条款，详见[商业授权说明](../COMMERCIAL-LICENSING.md)。

[开始配置](GETTING_STARTED.md) · [查看截图](SCREENSHOTS.md)
