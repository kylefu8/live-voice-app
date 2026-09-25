import CommonCrypto
import CryptoKit
import Foundation

/// The connection object returned by the native QR decoder.
///
/// These values live only in the short-lived native-to-JavaScript call.  The
/// JavaScript importer masks the key before it updates React state and only
/// passes the credentials to the existing secure-storage boundary after the
/// user has reviewed and tested them.
internal struct QrConnection {
  let endpoint: String
  let model: String
  let auth: String
  let apiKey: String
}

internal struct QrDecodedConfig {
  let version: Int
  let connections: [String: QrConnection]

  func bridgeValue() -> [String: Any] {
    var bridgedConnections: [String: Any] = [:]
    for (name, connection) in connections {
      bridgedConnections[name] = [
        "endpoint": connection.endpoint,
        "model": connection.model,
        "auth": connection.auth,
        "apiKey": connection.apiKey,
      ]
    }
    return ["version": version, "connections": bridgedConnections]
  }
}

internal struct QrConfigCryptoError: Error {
  let code: String

  init(_ code: String) {
    self.code = code
  }
}

/// LV1 QR configuration decoder.
///
/// Keep this implementation independent of the React Native bridge so it can
/// be exercised by a small XCTest target with the fixed vectors in
/// `pc-config/tests/fixtures/fixed-vector.json`.  The envelope and plaintext
/// validation intentionally mirrors pc-config and Android; in particular, no
/// URL, key, password, or provider error is included in an error code.
internal enum QrConfigCrypto {
  private static let envelopeVersion = "LV1"
  private static let iterations: UInt32 = 600_000
  private static let saltBytes = 16
  private static let nonceBytes = 12
  private static let tagBytes = 16
  private static let keyBytes = 32
  private static let maxPayloadLength = 1_800
  private static let maxEndpointLength = 512
  private static let maxModelLength = 256
  private static let maxKeyLength = 4_096
  private static let maxPassphraseLength = 256

  private static let supportedAuth = Set(["bearer", "api-key"])

  private struct Envelope {
    let salt: Data
    let nonce: Data
    let ciphertext: Data
    let aad: Data
  }

  /// Decode and validate one complete LV1 envelope.
  ///
  /// `shouldCancel` is checked before expensive work and before returning a
  /// plaintext.  CommonCrypto's PBKDF2 call is intentionally kept on the
  /// caller's worker queue; cancellation also causes the bridge to discard a
  /// completed result before it can be resolved to JavaScript.
  static func decrypt(
    payload: String,
    passphrase: String,
    shouldCancel: () -> Bool = { false }
  ) throws -> QrDecodedConfig {
    let envelope = try parseEnvelope(payload)
    var password = try validatePassphrase(passphrase)
    defer { zero(&password) }
    if shouldCancel() {
      throw QrConfigCryptoError(ErrorCode.cancelled)
    }

    var key = try deriveKey(password: password, salt: envelope.salt)
    defer { zero(&key) }

    var plaintext: Data
    do {
      if shouldCancel() {
        throw QrConfigCryptoError(ErrorCode.cancelled)
      }
      let nonce = try AES.GCM.Nonce(data: envelope.nonce)
      let ciphertext = envelope.ciphertext.dropLast(tagBytes)
      let tag = envelope.ciphertext.suffix(tagBytes)
      let sealedBox = try AES.GCM.SealedBox(
        nonce: nonce,
        ciphertext: Data(ciphertext),
        tag: Data(tag)
      )
      plaintext = try AES.GCM.open(sealedBox, using: SymmetricKey(data: key), authenticating: envelope.aad)
    } catch let error as QrConfigCryptoError {
      throw error
    } catch {
      throw QrConfigCryptoError(ErrorCode.decryptFailed)
    }

    if shouldCancel() {
      throw QrConfigCryptoError(ErrorCode.cancelled)
    }
    defer { zero(&plaintext) }
    guard let json = String(data: plaintext, encoding: .utf8) else {
      throw QrConfigCryptoError(ErrorCode.decryptFailed)
    }
    return try parsePlaintext(json)
  }

  /// Validate only the public envelope.  This is called immediately after a
  /// scanner reports a value, so an ordinary URL or arbitrary QR content is
  /// rejected before the passphrase screen is shown.
  static func validatePayload(_ payload: String) throws {
    _ = try parseEnvelope(payload)
  }

  private static func parseEnvelope(_ payload: String) throws -> Envelope {
    let asciiLength = payload.utf8.count
    if asciiLength > maxPayloadLength {
      throw QrConfigCryptoError(ErrorCode.payloadTooLarge)
    }
    guard !payload.isEmpty,
          payload.unicodeScalars.allSatisfy({
            let value = $0.value
            return value <= 0x7f && value > 0x1f && !(0x7f...0x9f).contains(value)
          })
    else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }

    let parts = payload.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 5 else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }

    let version = parts[0]
    let kdf = parts[1]
    if version != envelopeVersion {
      if version.range(of: #"^LV[0-9]+$"#, options: .regularExpression) != nil {
        throw QrConfigCryptoError(ErrorCode.unsupportedVersion)
      }
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }
    if kdf != String(iterations) {
      if kdf.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil {
        throw QrConfigCryptoError(ErrorCode.unsupportedVersion)
      }
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }
    guard parts[2].utf8.count == 22, parts[3].utf8.count == 16 else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }

    let salt = try decodeBase64URL(parts[2], expectedLength: saltBytes)
    let nonce = try decodeBase64URL(parts[3], expectedLength: nonceBytes)
    let ciphertext = try decodeBase64URL(parts[4], expectedLength: nil)
    guard ciphertext.count >= tagBytes else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }

    let aad = Data(parts[0...3].joined(separator: ".").utf8)
    return Envelope(salt: salt, nonce: nonce, ciphertext: ciphertext, aad: aad)
  }

  private static func decodeBase64URL(_ value: String, expectedLength: Int?) throws -> Data {
    guard !value.isEmpty,
          value.unicodeScalars.allSatisfy({ scalar in
            switch scalar.value {
            case 0x41...0x5a, 0x61...0x7a, 0x30...0x39, 0x2d, 0x5f:
              return true
            default:
              return false
            }
          }),
          value.utf8.count % 4 != 1
    else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }

    let padding = String(repeating: "=", count: (4 - value.utf8.count % 4) % 4)
    let standard = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/") + padding
    guard let decoded = Data(base64Encoded: standard, options: []) else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }
    guard encodeBase64URL(decoded) == value,
          expectedLength == nil || decoded.count == expectedLength
    else {
      throw QrConfigCryptoError(ErrorCode.invalidPayload)
    }
    return decoded
  }

  private static func encodeBase64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .trimmingCharacters(in: CharacterSet(charactersIn: "="))
  }

  private static func validatePassphrase(_ value: String) throws -> Data {
    try validateText(value, code: ErrorCode.invalidPassphrase, maximum: maxPassphraseLength)
    guard !isAllJsWhitespace(value), let data = value.data(using: .utf8) else {
      throw QrConfigCryptoError(ErrorCode.invalidPassphrase)
    }
    return data
  }

  private static func deriveKey(password: Data, salt: Data) throws -> Data {
    var derived = Data(count: keyBytes)
    let status: Int32 = password.withUnsafeBytes { passwordBytes in
      salt.withUnsafeBytes { saltBytes in
        derived.withUnsafeMutableBytes { derivedBytes in
          let passwordPointer = passwordBytes.bindMemory(to: Int8.self).baseAddress
          let saltPointer = saltBytes.bindMemory(to: UInt8.self).baseAddress
          let derivedPointer = derivedBytes.bindMemory(to: UInt8.self).baseAddress
          return CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            passwordPointer,
            password.count,
            saltPointer,
            salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            iterations,
            derivedPointer,
            keyBytes
          )
        }
      }
    }
    guard status == kCCSuccess else {
      zero(&derived)
      throw QrConfigCryptoError(ErrorCode.decryptFailed)
    }
    return derived
  }

  private static func parsePlaintext(_ json: String) throws -> QrDecodedConfig {
    guard let data = json.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
          let root = object as? [String: Any],
          Set(root.keys) == Set(["version", "connections"])
    else {
      throw QrConfigCryptoError(ErrorCode.decryptFailed)
    }

    guard let version = root["version"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID()
    else {
      throw QrConfigCryptoError(ErrorCode.invalidConfig)
    }
    guard version.doubleValue == 1.0 else {
      throw QrConfigCryptoError(ErrorCode.unsupportedVersion)
    }
    guard let rawConnections = root["connections"] as? [String: Any],
          !rawConnections.isEmpty,
          rawConnections.keys.allSatisfy({ $0 == "voice" || $0 == "backend" })
    else {
      throw QrConfigCryptoError(ErrorCode.invalidConfig)
    }

    var connections: [String: QrConnection] = [:]
    for name in ["voice", "backend"] where rawConnections[name] != nil {
      guard let value = rawConnections[name] as? [String: Any],
            Set(value.keys) == Set(["endpoint", "model", "auth", "apiKey"])
      else {
        throw QrConfigCryptoError(ErrorCode.invalidConfig)
      }
      guard let endpoint = value["endpoint"] as? String else {
        throw QrConfigCryptoError(ErrorCode.invalidEndpoint)
      }
      guard let model = value["model"] as? String else {
        throw QrConfigCryptoError(ErrorCode.invalidModel)
      }
      guard let auth = value["auth"] as? String, supportedAuth.contains(auth) else {
        throw QrConfigCryptoError(ErrorCode.invalidConfig)
      }
      guard let apiKey = value["apiKey"] as? String else {
        throw QrConfigCryptoError(ErrorCode.invalidKey)
      }
      connections[name] = QrConnection(
        endpoint: try normalizeEndpoint(endpoint),
        model: try normalizeModel(model),
        auth: auth,
        apiKey: try validateApiKey(apiKey)
      )
    }

    guard !connections.isEmpty else {
      throw QrConfigCryptoError(ErrorCode.invalidConfig)
    }
    return QrDecodedConfig(version: 1, connections: connections)
  }

  private static func normalizeEndpoint(_ value: String) throws -> String {
    try validateText(value, code: ErrorCode.invalidEndpoint, maximum: maxEndpointLength)
    guard value == trimJs(value), !value.contains("?"), !value.contains("#"),
          let components = URLComponents(string: value),
          components.scheme?.lowercased() == "https",
          let host = components.host, !host.isEmpty,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil
    else {
      throw QrConfigCryptoError(ErrorCode.invalidEndpoint)
    }

    var normalized = value
    while normalized.last == "/" {
      normalized.removeLast()
    }
    guard !normalized.isEmpty else {
      throw QrConfigCryptoError(ErrorCode.invalidEndpoint)
    }
    return normalized
  }

  private static func normalizeModel(_ value: String) throws -> String {
    try validateText(value, code: ErrorCode.invalidModel, maximum: maxModelLength)
    return value
  }

  private static func validateApiKey(_ value: String) throws -> String {
    try validateText(value, code: ErrorCode.invalidKey, maximum: maxKeyLength)
    if isClearlyMaskedKey(value) {
      throw QrConfigCryptoError(ErrorCode.invalidKey)
    }
    return value
  }

  private static func validateText(_ value: String, code: String, maximum: Int) throws {
    let scalars = Array(value.unicodeScalars)
    guard !scalars.isEmpty, scalars.count <= maximum, !isAllJsWhitespace(value) else {
      throw QrConfigCryptoError(code)
    }
    for scalar in scalars {
      let point = scalar.value
      if point <= 0x1f || (0x7f...0x9f).contains(point) {
        throw QrConfigCryptoError(code)
      }
    }
  }

  private static func isClearlyMaskedKey(_ value: String) -> Bool {
    let obviousCharacters: Set<Character> = ["…", "•", "·", "█", "＊", "*"]
    if value.contains(where: { obviousCharacters.contains($0) }) || value.contains("...") {
      return true
    }
    switch value.lowercased() {
    case "masked", "redacted", "hidden", "removed", "secret":
      return true
    default:
      break
    }
    let maskOnly: Set<Character> = ["x", "X", "*", ".", "_", "-", "#"]
    return value.count >= 4 && value.allSatisfy { maskOnly.contains($0) }
  }

  private static func trimJs(_ value: String) -> String {
    let scalars = Array(value.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end && isJsWhitespace(scalars[start].value) {
      start += 1
    }
    while end > start && isJsWhitespace(scalars[end - 1].value) {
      end -= 1
    }
    return String(String.UnicodeScalarView(scalars[start..<end]))
  }

  private static func isAllJsWhitespace(_ value: String) -> Bool {
    trimJs(value).isEmpty
  }

  /// This is the ECMAScript String.trim() whitespace set used by pc-config.
  private static func isJsWhitespace(_ point: UInt32) -> Bool {
    switch point {
    case 0x0009, 0x000a, 0x000b, 0x000c, 0x000d,
         0x0020, 0x00a0, 0x1680,
         0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
      return true
    case 0x2000...0x200a:
      return true
    default:
      return false
    }
  }

  private static func zero(_ data: inout Data) {
    _ = data.withUnsafeMutableBytes { bytes in
      bytes.initializeMemory(as: UInt8.self, repeating: 0)
    }
  }

  internal enum ErrorCode {
    static let invalidConfig = "invalid_config"
    static let invalidEndpoint = "invalid_endpoint"
    static let invalidModel = "invalid_model"
    static let invalidKey = "invalid_key"
    static let invalidPassphrase = "invalid_passphrase"
    static let invalidPayload = "invalid_payload"
    static let unsupportedVersion = "unsupported_version"
    static let payloadTooLarge = "payload_too_large"
    static let decryptFailed = "decrypt_failed"
    static let cancelled = "qr_cancelled"
  }
}
