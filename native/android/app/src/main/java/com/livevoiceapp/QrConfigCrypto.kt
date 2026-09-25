package com.livevoiceapp

import android.util.Base64
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

internal data class QrConnection(
    val endpoint: String,
    val model: String,
    val auth: String,
    val apiKey: String,
)

internal data class QrConfig(
    val version: Int,
    val voice: QrConnection?,
    val backend: QrConnection?,
)

internal class QrCryptoException(
    val code: String,
) : Exception(code)

/**
 * Android's android.util.Base64 is available on the project's minSdk (24),
 * while java.util.Base64 is not available until API 26.  Keeping this tiny
 * adapter here lets JVM tests install their JDK codec without putting an API
 * 26 reference in the application bytecode.
 */
internal interface QrBase64Codec {
  fun decode(value: String): ByteArray
  fun encode(value: ByteArray): String
}

internal object QrBase64 {
  @Volatile
  var testCodec: QrBase64Codec? = null

  private val androidCodec = object : QrBase64Codec {
    override fun decode(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE)

    override fun encode(value: ByteArray): String = Base64.encodeToString(
        value,
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )
  }

  fun decode(value: String): ByteArray = (testCodec ?: androidCodec).decode(value)

  fun encode(value: ByteArray): String = (testCodec ?: androidCodec).encode(value)
}

/**
 * Protocol v1 decoder shared by the React Native bridge and JVM tests.
 *
 * This is deliberately implemented with Android/JCA primitives rather than a
 * JavaScript crypto package.  In particular, PBKDF2 is written over the exact
 * UTF-8 password bytes so a Unicode password cannot depend on a provider's
 * PBEKeySpec character encoding convention.
 */
internal object QrConfigCrypto {
  private const val VERSION = "LV1"
  private const val ITERATIONS = 600_000
  private const val SALT_BYTES = 16
  private const val NONCE_BYTES = 12
  private const val TAG_BYTES = 16
  private const val KEY_BYTES = 32
  private const val MAX_PAYLOAD_LENGTH = 1_800
  private const val MAX_ENDPOINT_LENGTH = 512
  private const val MAX_MODEL_LENGTH = 256
  private const val MAX_KEY_LENGTH = 4_096
  private const val MIN_PASSCODE_LENGTH = 1
  private const val MAX_PASSCODE_LENGTH = 256

  private val BASE64_URL = Regex("^[A-Za-z0-9_-]+$")
  private val VERSION_PATTERN = Regex("^LV[0-9]+$")
  private val INTEGER_PATTERN = Regex("^[0-9]+$")

  /**
   * Decode a configuration. The callback is polled during PBKDF2 so the
   * bridge can cancel a long operation without waiting for 600,000 rounds.
   */
  fun decrypt(
      payload: String,
      passphrase: String,
      shouldCancel: () -> Boolean = { false },
  ): QrConfig {
    val envelope = parseEnvelope(payload)
    val password = validatePassphrase(passphrase)
    val key = try {
      deriveKey(password.toByteArray(StandardCharsets.UTF_8), envelope.salt, shouldCancel)
    } catch (error: QrCryptoException) {
      throw error
    } catch (_: Throwable) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    }

    val plaintext = try {
      if (shouldCancel()) throw QrCryptoException(ERROR_CANCELLED)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
          Cipher.DECRYPT_MODE,
          SecretKeySpec(key, "AES"),
          GCMParameterSpec(TAG_BYTES * 8, envelope.nonce),
      )
      cipher.updateAAD(envelope.aad)
      cipher.doFinal(envelope.ciphertext)
    } catch (error: QrCryptoException) {
      throw error
    } catch (_: GeneralSecurityException) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    } catch (_: RuntimeException) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    } finally {
      key.fill(0)
    }

    val json = try {
      if (shouldCancel()) throw QrCryptoException(ERROR_CANCELLED)
      StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(plaintext))
          .toString()
    } catch (error: QrCryptoException) {
      throw error
    } catch (_: Throwable) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    } finally {
      plaintext.fill(0)
    }

    return try {
      parsePlaintext(json)
    } catch (error: QrCryptoException) {
      // A successfully authenticated but incompatible plaintext is still a
      // protocol/schema failure, never a provider or JSON exception leak.
      throw error
    } catch (_: Throwable) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    }
  }

  /** Validate only the public envelope before the UI asks for a passphrase. */
  fun validatePayload(payload: String) {
    parseEnvelope(payload)
  }

  private fun parseEnvelope(payload: String): Envelope {
    if (payload.length > MAX_PAYLOAD_LENGTH) {
      throw QrCryptoException(ERROR_PAYLOAD_TOO_LARGE)
    }
    if (payload.isEmpty() || payload.any { it.code > 0x7f || it.code <= 0x1f || it.code in 0x7f..0x9f }) {
      throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    }

    val parts = payload.split('.')
    if (parts.size != 5) throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    val version = parts[0]
    val kdf = parts[1]
    if (version != VERSION) {
      throw QrCryptoException(if (VERSION_PATTERN.matches(version)) ERROR_UNSUPPORTED_VERSION else ERROR_INVALID_PAYLOAD)
    }
    if (kdf != ITERATIONS.toString()) {
      throw QrCryptoException(if (INTEGER_PATTERN.matches(kdf)) ERROR_UNSUPPORTED_VERSION else ERROR_INVALID_PAYLOAD)
    }
    val saltPart = parts[2]
    val noncePart = parts[3]
    if (saltPart.length != 22 || noncePart.length != 16) {
      throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    }
    val salt = decodeBase64Url(saltPart, SALT_BYTES)
    val nonce = decodeBase64Url(noncePart, NONCE_BYTES)
    val ciphertext = decodeBase64Url(parts[4], null)
    if (ciphertext.size < TAG_BYTES) throw QrCryptoException(ERROR_INVALID_PAYLOAD)

    return Envelope(
        salt = salt,
        nonce = nonce,
        ciphertext = ciphertext,
        aad = parts.subList(0, 4).joinToString(".").toByteArray(StandardCharsets.UTF_8),
    )
  }

  private fun decodeBase64Url(value: String, expectedLength: Int?): ByteArray {
    if (value.isEmpty() || !BASE64_URL.matches(value) || value.length % 4 == 1) {
      throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    }
    val padded = value + "=".repeat((4 - value.length % 4) % 4)
    val decoded = try {
      QrBase64.decode(padded)
    } catch (_: IllegalArgumentException) {
      throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    }
    val canonical = QrBase64.encode(decoded)
    if (canonical != value || (expectedLength != null && decoded.size != expectedLength)) {
      throw QrCryptoException(ERROR_INVALID_PAYLOAD)
    }
    return decoded
  }

  private fun validatePassphrase(value: String): String {
    validateText(value, ERROR_INVALID_PASSPHRASE, MAX_PASSCODE_LENGTH)
    val length = value.codePointCount(0, value.length)
    if (length < MIN_PASSCODE_LENGTH || isAllJsWhitespace(value)) {
      throw QrCryptoException(ERROR_INVALID_PASSPHRASE)
    }
    return value
  }

  private fun validateText(value: String, code: String, maximum: Int) {
    if (value.isEmpty() || value.codePointCount(0, value.length) > maximum || isAllJsWhitespace(value)) {
      throw QrCryptoException(code)
    }
    var index = 0
    while (index < value.length) {
      val current = value[index]
      if (current.isHighSurrogate()) {
        if (index + 1 >= value.length || !value[index + 1].isLowSurrogate()) {
          throw QrCryptoException(code)
        }
      } else if (current.isLowSurrogate()) {
        throw QrCryptoException(code)
      }
      val point = value.codePointAt(index)
      if (point <= 0x1f || point in 0x7f..0x9f) {
        throw QrCryptoException(code)
      }
      index += if (point > 0xffff) 2 else 1
    }
  }

  private fun normalizeEndpoint(value: String): String {
    validateText(value, ERROR_INVALID_ENDPOINT, MAX_ENDPOINT_LENGTH)
    if (value != trimJs(value) || value.contains('?') || value.contains('#')) {
      throw QrCryptoException(ERROR_INVALID_ENDPOINT)
    }
    val parsed = try {
      URI(value)
    } catch (_: Throwable) {
      throw QrCryptoException(ERROR_INVALID_ENDPOINT)
    }
    if (
        !parsed.isAbsolute ||
        !parsed.scheme.equals("https", ignoreCase = true) ||
        parsed.host.isNullOrEmpty() ||
        parsed.userInfo != null ||
        parsed.rawQuery != null ||
        parsed.rawFragment != null
    ) {
      throw QrCryptoException(ERROR_INVALID_ENDPOINT)
    }
    return value.trimEnd('/')
  }

  private fun normalizeModel(value: String): String {
    validateText(value, ERROR_INVALID_MODEL, MAX_MODEL_LENGTH)
    return value
  }

  private fun validateApiKey(value: String): String {
    validateText(value, ERROR_INVALID_KEY, MAX_KEY_LENGTH)
    if (isClearlyMaskedKey(value)) throw QrCryptoException(ERROR_INVALID_KEY)
    return value
  }

  private fun isClearlyMaskedKey(value: String): Boolean {
    if (value.any { it == '\u2026' || it == '\u2022' || it == '\u00b7' || it == '\u2588' || it == '\uff0a' || it == '*' } ||
        value.contains(Regex("\\.{3,}"))) {
      return true
    }
    if (value.matches(Regex("(?i)^(masked|redacted|hidden|removed|secret)$"))) return true
    return value.length >= 4 && value.matches(Regex("^[xX*._\\-#]+$"))
  }

  private fun parsePlaintext(json: String): QrConfig {
    val root = try {
      JSONObject(json)
    } catch (_: Throwable) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    }
    requireExactKeys(root, setOf("version", "connections"), ERROR_INVALID_CONFIG)
    val version = root.opt("version")
    if (version !is Number || version.toDouble() != 1.0) {
      if (version is Number) throw QrCryptoException(ERROR_UNSUPPORTED_VERSION)
      throw QrCryptoException(ERROR_INVALID_CONFIG)
    }
    val connections = root.opt("connections")
    if (connections !is JSONObject) throw QrCryptoException(ERROR_INVALID_CONFIG)
    val names = jsonKeys(connections)
    if (names.isEmpty() || names.any { it != "voice" && it != "backend" }) {
      throw QrCryptoException(ERROR_INVALID_CONFIG)
    }
    val voice = if (connections.has("voice")) {
      parseConnection(connections.opt("voice"))
    } else {
      null
    }
    val backend = if (connections.has("backend")) {
      parseConnection(connections.opt("backend"))
    } else {
      null
    }
    if (voice == null && backend == null) throw QrCryptoException(ERROR_INVALID_CONFIG)
    return QrConfig(version = 1, voice = voice, backend = backend)
  }

  private fun parseConnection(value: Any?): QrConnection {
    if (value !is JSONObject) throw QrCryptoException(ERROR_INVALID_CONFIG)
    requireExactKeys(value, setOf("endpoint", "model", "auth", "apiKey"), ERROR_INVALID_CONFIG)
    val endpoint = requireString(value, "endpoint", ERROR_INVALID_ENDPOINT)
    val model = requireString(value, "model", ERROR_INVALID_MODEL)
    val auth = requireString(value, "auth", ERROR_INVALID_CONFIG)
    val apiKey = requireString(value, "apiKey", ERROR_INVALID_KEY)
    if (auth != "bearer" && auth != "api-key") throw QrCryptoException(ERROR_INVALID_CONFIG)
    return QrConnection(
        endpoint = normalizeEndpoint(endpoint),
        model = normalizeModel(model),
        auth = auth,
        apiKey = validateApiKey(apiKey),
    )
  }

  private fun requireString(value: JSONObject, key: String, code: String): String {
    val item = value.opt(key)
    if (item !is String) throw QrCryptoException(code)
    return item
  }

  private fun requireExactKeys(value: JSONObject, expected: Set<String>, code: String) {
    if (jsonKeys(value) != expected) throw QrCryptoException(code)
  }

  private fun jsonKeys(value: JSONObject): Set<String> {
    val result = mutableSetOf<String>()
    val iterator = value.keys()
    while (iterator.hasNext()) result += iterator.next()
    return result
  }

  /** Match the ECMAScript String.trim() whitespace set used by pc-config. */
  private fun trimJs(value: String): String {
    var start = 0
    while (start < value.length) {
      val point = value.codePointAt(start)
      if (!isJsWhitespace(point)) break
      start += if (point > 0xffff) 2 else 1
    }
    var end = value.length
    while (end > start) {
      val point = value.codePointBefore(end)
      if (!isJsWhitespace(point)) break
      end -= if (point > 0xffff) 2 else 1
    }
    return value.substring(start, end)
  }

  private fun isAllJsWhitespace(value: String): Boolean = trimJs(value).isEmpty()

  private fun isJsWhitespace(point: Int): Boolean = when (point) {
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d,
    0x0020, 0x00a0, 0x1680,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff -> true
    in 0x2000..0x200a -> true
    else -> false
  }

  private fun deriveKey(
      password: ByteArray,
      salt: ByteArray,
      shouldCancel: () -> Boolean,
  ): ByteArray {
    val mac = try {
      Mac.getInstance("HmacSHA256")
    } catch (_: GeneralSecurityException) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    }
    try {
      mac.init(SecretKeySpec(password, "HmacSHA256"))
      val result = ByteArray(KEY_BYTES)
      val block = ByteArray(salt.size + 4)
      salt.copyInto(block, 0)
      block[salt.size + 3] = 1
      mac.update(block)
      var u = mac.doFinal()
      u.copyInto(result, 0)
      var round = 1
      while (round < ITERATIONS) {
        if ((round and 0x7ff) == 0 && shouldCancel()) {
          throw QrCryptoException(ERROR_CANCELLED)
        }
        u = mac.doFinal(u)
        for (index in result.indices) result[index] = (result[index].toInt() xor u[index].toInt()).toByte()
        round += 1
      }
      return result
    } catch (error: QrCryptoException) {
      throw error
    } catch (_: GeneralSecurityException) {
      throw QrCryptoException(ERROR_DECRYPT_FAILED)
    } finally {
      password.fill(0)
    }
  }

  private data class Envelope(
      val salt: ByteArray,
      val nonce: ByteArray,
      val ciphertext: ByteArray,
      val aad: ByteArray,
  )

  const val ERROR_INVALID_CONFIG = "invalid_config"
  const val ERROR_INVALID_ENDPOINT = "invalid_endpoint"
  const val ERROR_INVALID_MODEL = "invalid_model"
  const val ERROR_INVALID_KEY = "invalid_key"
  const val ERROR_INVALID_PASSPHRASE = "invalid_passphrase"
  const val ERROR_INVALID_PAYLOAD = "invalid_payload"
  const val ERROR_UNSUPPORTED_VERSION = "unsupported_version"
  const val ERROR_PAYLOAD_TOO_LARGE = "payload_too_large"
  const val ERROR_DECRYPT_FAILED = "decrypt_failed"
  const val ERROR_CANCELLED = "qr_cancelled"
}
