# 加密配置二维码协议 v1

本文定义 PC 配置生成器与手机端未来导入功能之间的加密载荷格式。PC 生成器把完整的 ASCII 载荷交给二维码组件；口令不写入载荷，需由用户通过另一条途径告诉手机使用者。

当前交付包含 PC 本地生成页面、Windows 配置导出、可在浏览器和 Node.js 中复用的加解密模块与测试向量。Android 0.2.0 接入相机扫码、本机口令解密、遮罩预览及测试后安全保存；二维码不是网络中转服务。设备相机与真实服务验证应独立于构建和密码学测试记录。

## 明文配置

加密前的 UTF-8 JSON 使用以下 schema：

```json
{
  "version": 1,
  "connections": {
    "voice": {
      "endpoint": "https://voice.example.test/v1",
      "model": "gpt-live-1",
      "auth": "bearer",
      "apiKey": "synthetic-key"
    },
    "backend": {
      "endpoint": "https://backend.example.test/openai",
      "model": "reasoning-mini",
      "auth": "api-key",
      "apiKey": "synthetic-key"
    }
  }
}
```

`connections.voice` 和 `connections.backend` 都是可选的，但至少要有一个。每个存在的连接必须只包含 `endpoint`、`model`、`auth`、`apiKey` 四个字段；`auth` 只能是 `bearer` 或 `api-key`。顶层和连接名也不接受未知字段。

校验会构造稳定字段顺序的副本：`version`、`connections`，连接按 `voice`、`backend` 顺序，连接字段按 `endpoint`、`model`、`auth`、`apiKey` 顺序。这样可以固定 JSON 字节，避免同一配置因为输入对象字段顺序不同而产生不同明文。endpoint 会通过 URL 解析后统一为 HTTPS、去除末尾 `/`；不允许用户名、密码、query 或 fragment。其他文本不做 Unicode 或空白规范化。

所有文本都拒绝 C0/C1 控制字符、未配对的 UTF-16 surrogate 和全空白值。endpoint 最多 512 个 Unicode 字符，model 最多 256 个，apiKey 最多 4096 个。apiKey 不能为空，也不能使用设置页面的明显遮罩值（例如 `sk-...1234`、连续星号或圆点）。测试和示例只能使用合成值；真实密钥不得写入源码、日志、二维码截图或测试夹具。

## Envelope

二维码内容必须是下面五段、四个 ASCII 点号分隔的字符串，不能有换行、padding `=` 或其他字段：

```text
LV1.600000.<salt-base64url>.<nonce-base64url>.<ciphertext-plus-tag-base64url>
```

具体约束如下：

| 段 | 内容 |
| --- | --- |
| 1 | 固定文本 `LV1` |
| 2 | 固定文本 `600000`，表示 PBKDF2 迭代次数 |
| 3 | 16 个随机字节的 unpadded base64url，固定 22 字符 |
| 4 | 12 个随机字节的 unpadded base64url，固定 16 字符 |
| 5 | AES-GCM 密文和 16 字节认证标签拼接后的 unpadded base64url |

base64url 只允许 `A-Z`、`a-z`、`0-9`、`-`、`_`，并且重新编码后必须与输入完全相同。完整 envelope 最多 1800 个 ASCII 字符；超过上限必须在派生密钥前拒绝。PC 生成器不得截断或静默拆成多个二维码。

## 派生和加密

1. 使用用户输入的口令原始字符串作为 PBKDF2 UTF-8 输入。口令长度为 1 到 256 个 Unicode 字符，不得全为空白或包含控制字符。口令不 trim、不做 Unicode normalization，也不写入二维码。
2. 使用 PBKDF2-HMAC-SHA-256，迭代次数 `600000`，派生 32 字节 AES-256 密钥。
3. 每次生成都使用新的随机 16 字节 salt 和 12 字节 nonce。nonce 不复用；salt、nonce 只通过 envelope 传递。
4. 明文是稳定字段顺序对象的 `JSON.stringify` UTF-8 字节。
5. AES-GCM 使用 128 bit tag。Additional Authenticated Data（AAD）是前四段的 UTF-8 字节，准确表示为：

   ```text
   LV1.600000.<salt-base64url>.<nonce-base64url>
   ```

6. 第五段是 AES-GCM 返回的 ciphertext 后紧接 16 字节 tag，再做 unpadded base64url 编码。

手机端必须先检查 envelope 长度、版本、KDF 参数、base64url canonical form、salt 和 nonce 长度，再派生密钥。解密失败或认证失败不能把 endpoint、密钥、明文或底层异常写进错误消息。

## 错误码

模块抛出的 `ConfigCryptoError.code` 只使用下列固定非敏感值：

| code | 含义 |
| --- | --- |
| `invalid_config` | schema、字段集合或连接结构不合法 |
| `invalid_endpoint` | endpoint 不是符合约束的 HTTPS 地址 |
| `invalid_model` | model 为空、含控制字符或超过长度 |
| `invalid_key` | apiKey 为空、含控制字符、超过长度或是明显遮罩值 |
| `invalid_passphrase` | 口令为空、全空白、含控制字符或超长 |
| `invalid_payload` | envelope 结构、编码或固定字段格式不合法 |
| `unsupported_version` | 版本或 KDF 参数不是本协议支持的固定值 |
| `payload_too_large` | envelope 超过 1800 字符，或生成结果不能放进单个二维码 |
| `decrypt_failed` | 口令错误、AAD/密文被改动、认证标签无效或明文不是 JSON |

实现可以将这些 code 显示为本地化提示，但不应把底层 Web Crypto 错误、口令、endpoint 或密钥拼进提示。

## 跨端测试向量

`pc-config/tests/fixtures/fixed-vector.json` 中的向量使用合成连接信息、固定 salt/nonce 和口令。测试使用 Node `crypto.pbkdf2Sync` 与 `createCipheriv` 独立计算预期 ciphertext，再用 Web Crypto 实现解密，以同时核对：UTF-8 编码、PBKDF2 参数、AAD 拼接、AES-GCM tag 顺序和 base64url 编码。Android 实现接入时应先通过同一个向量，再进行真机扫码测试。

生成端口令要求：至少 4 个 Unicode 字符，最多 256 个，不能全为空白。为兼容早期已生成的 v1 二维码，解密端仍接受 1–256 个字符的原口令；不改变口令字节、派生算法或载荷格式。
