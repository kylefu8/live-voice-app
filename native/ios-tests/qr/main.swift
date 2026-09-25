import Foundation

func expectError(_ code: String, _ operation: () throws -> Void) {
  do {
    try operation()
    fatalError("Expected fixed error: \(code)")
  } catch let error as QrConfigCryptoError {
    precondition(error.code == code, "Unexpected fixed error: \(error.code)")
  } catch {
    fatalError("Unexpected error type")
  }
}

let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: String]
let payload = fixture["payload"]!
let password = fixture["passphrase"]!
let decoded = try QrConfigCrypto.decrypt(payload: payload, passphrase: password)
precondition(decoded.version == 1)
precondition(decoded.connections.count == 2)
precondition(decoded.connections["voice"]?.model == "gpt-live-1")
expectError("decrypt_failed") { _ = try QrConfigCrypto.decrypt(payload: payload, passphrase: "wrong password") }
expectError("invalid_payload") { try QrConfigCrypto.validatePayload("https://example.test") }
expectError("unsupported_version") { try QrConfigCrypto.validatePayload(payload.replacingOccurrences(of: "LV1.", with: "LV2.")) }
expectError("qr_cancelled") { _ = try QrConfigCrypto.decrypt(payload: payload, passphrase: password, shouldCancel: {true}) }
var parts = payload.split(separator: ".").map(String.init)
parts[4].replaceSubrange(parts[4].startIndex...parts[4].startIndex, with: parts[4].first == "A" ? "B" : "A")
expectError("decrypt_failed") { _ = try QrConfigCrypto.decrypt(payload: parts.joined(separator: "."), passphrase: password) }
print("iOS QR fixed-vector and rejection checks passed")
