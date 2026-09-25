# 构建与发布

**简体中文** | [English](BUILDING.en.md)

## Android

1. 安装 Android Studio（含 JDK）、Android SDK，以及项目 Gradle 文件声明的 SDK/NDK。
2. 安装 Node 24。现有 Windows 脚本使用项目内
   `work/toolchain/node-v24.21.0-win-x64/node.exe`，以及
   `work/toolchain/ninja/ninja.exe`；分别从 [Node.js](https://nodejs.org/)
   和 [Ninja](https://github.com/ninja-build/ninja/releases) 获取官方发行版。
3. 在 `native/` 执行 `npm ci`。调试构建可使用 Android SDK 自动生成的本机调试密钥。
4. 正式构建必须使用自己的发布密钥。按 [Android 应用签名文档](https://developer.android.com/studio/publish/app-signing)
   创建密钥并安全备份，构建进程需提供以下环境变量：
   `LIVEVOICE_KEYSTORE_PATH`、`LIVEVOICE_KEYSTORE_PASSWORD`、
   `LIVEVOICE_KEY_ALIAS`、`LIVEVOICE_KEY_PASSWORD`。
   通过本机秘密管理工具或不回显输入提供密码，不把密码写入命令历史、源码或日志。
5. 在 `native/` 运行 `powershell -File scripts/build-android.ps1`。
   缺少发布签名时构建失败，不会退回调试签名。

发布默认将 React Native 开发服务器地址固定为 `127.0.0.1`，避免写入构建机局域网信息。
只在本机调试时使用 `-PreactNativeDevServerIp=...` 覆盖；不要把这样的包用于公开发布。

密钥从未随公开源码分发。自行生成的密钥与官方发布者不同，不能据此覆盖官方签名的安装。
旧测试安装的说明见[签名切换](SIGNING-TRANSITION.md)。

## Windows

在 `desktop/` 使用 Node 24 执行 `npm ci`、`npm test`、`npm run build`。
`npm run package` 使用 `work/toolchain/electron-<版本>/` 中的官方 Electron ZIP
缓存；版本以 `desktop/package.json` 为准。便携包保持未签名状态，已在下载页说明。

打包使用全新的暂存目录。打包后不要运行发行目录中的 EXE 再直接压缩，以免带入 `debug.log`。
需要启动测试时先复制到本机测试目录。分发时保留 Electron 自带的许可证。

## iOS

见 [iOS 构建说明](../native/IOS.md)。Xcode 构建阶段会复制第三方许可与 CocoaPods
为实际依赖生成的 acknowledgements；先运行 `pod install`，不要分发个人签名配置或证书。

## 发布检查

- 核对源码、Git 历史与所有标签，不包含密钥、私人地址、设备信息、会话或录音。
- 更新 [第三方许可](../third-party/README.md)，确认新依赖的版权文本和许可证。
- 核对 APK 签名指纹、资源和 ZIP 内容；检查无私人 IP、调试日志、签名私钥或测试入口。
- 生成并核对 SHA-256，同时提供 Windows 与 Android 下载及许可证、第三方声明。
- 真机音频与模型验证需另行进行；编译通过不能替代这些验证。
