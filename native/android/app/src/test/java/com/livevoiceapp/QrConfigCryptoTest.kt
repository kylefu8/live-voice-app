package com.livevoiceapp

import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class QrConfigCryptoTest {

  @org.junit.Before
  fun useJdkBase64ForJvmTests() {
    QrBase64.testCodec = object : QrBase64Codec {
      override fun decode(value: String): ByteArray = Base64.getUrlDecoder().decode(value)

      override fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    }
  }

  @org.junit.After
  fun clearJdkBase64Override() {
    QrBase64.testCodec = null
  }

  @Test
  fun fixedVectorMatchesPcConfig() {
    val decoded = QrConfigCrypto.decrypt(FIXED_VECTOR, "vector password ✨")
    assertEquals(1, decoded.version)
    assertEquals(
        QrConnection(
            endpoint = "https://voice.example.test/v1",
            model = "gpt-live-1",
            auth = "bearer",
            apiKey = "synthetic-voice-key-7f3a",
        ),
        decoded.voice,
    )
    assertEquals(
        QrConnection(
            endpoint = "https://backend.example.test/openai",
            model = "reasoning-mini",
            auth = "api-key",
            apiKey = "synthetic-backend-key-9c2b",
        ),
        decoded.backend,
    )
  }

  @Test
  fun preservesUtf8BytesWithoutUnicodeNormalization() {
    val decomposed = "cafe\u0301-口令"
    val decoded = QrConfigCrypto.decrypt(UNICODE_VECTOR, decomposed)
    assertEquals("gpt-live-1-练习✨", decoded.voice?.model)
    assertCode("decrypt_failed") {
      QrConfigCrypto.decrypt(UNICODE_VECTOR, "café-口令")
    }
  }

  @Test
  fun authenticatedCiphertextAndMetadataTamperingFails() {
    val ciphertext = FIXED_VECTOR.split('.').toMutableList()
    ciphertext[4] = (if (ciphertext[4][0] == 'A') "B" else "A") + ciphertext[4].substring(1)
    assertCode("decrypt_failed") {
      QrConfigCrypto.decrypt(ciphertext.joinToString("."), "vector password ✨")
    }

    val metadata = FIXED_VECTOR.split('.').toMutableList()
    metadata[3] = (if (metadata[3][0] == 'A') "B" else "A") + metadata[3].substring(1)
    assertCode("decrypt_failed") {
      QrConfigCrypto.decrypt(metadata.joinToString("."), "vector password ✨")
    }
  }

  @Test
  fun rejectsMalformedVersionEncodingAndSizeBeforeDecrypt() {
    assertCode("unsupported_version") {
      QrConfigCrypto.decrypt(FIXED_VECTOR.replaceFirst("LV1", "LV2"), "vector password ✨")
    }
    assertCode("invalid_payload") {
      QrConfigCrypto.decrypt(FIXED_VECTOR.replaceFirst("AAECAwQFBgcICQoLDA0ODw", "AAECAwQFBgcICQoLDA0OD="), "vector password ✨")
    }
    assertCode("payload_too_large") {
      QrConfigCrypto.decrypt("x".repeat(1_801), "vector password ✨")
    }
    assertCode("invalid_passphrase") {
      QrConfigCrypto.decrypt(FIXED_VECTOR, "    ")
    }
    assertCode("qr_cancelled") {
      QrConfigCrypto.decrypt(FIXED_VECTOR, "vector password ✨") { true }
    }
  }

  @Test
  fun validatesPlaintextSchemaAndSensitiveTextRules() {
    val unknownField = encryptJson(
        "{\"version\":1,\"connections\":{},\"extra\":true}",
        "schema password",
    )
    assertCode("invalid_config") {
      QrConfigCrypto.decrypt(unknownField, "schema password")
    }

    val invalidEndpoint = encryptJson(
        "{\"version\":1,\"connections\":{\"voice\":{\"endpoint\":\"http://voice.example\",\"model\":\"gpt-live-1\",\"auth\":\"bearer\",\"apiKey\":\"synthetic-key\"}}}",
        "schema password",
    )
    assertCode("invalid_endpoint") {
      QrConfigCrypto.decrypt(invalidEndpoint, "schema password")
    }

    val maskedKey = encryptJson(
        "{\"version\":1,\"connections\":{\"voice\":{\"endpoint\":\"https://voice.example\",\"model\":\"gpt-live-1\",\"auth\":\"bearer\",\"apiKey\":\"sk-...1234\"}}}",
        "schema password",
    )
    assertCode("invalid_key") {
      QrConfigCrypto.decrypt(maskedKey, "schema password")
    }
  }

  private fun assertCode(expected: String, operation: () -> Unit) {
    try {
      operation()
      fail("Expected $expected")
    } catch (error: QrCryptoException) {
      assertEquals(expected, error.code)
      assertEquals(expected, error.message)
    }
  }

  private fun encryptJson(json: String, passphrase: String): String {
    val salt = hex("404142434445464748494a4b4c4d4e4f")
    val nonce = hex("505152535455565758595a5b")
    val saltPart = Base64.getUrlEncoder().withoutPadding().encodeToString(salt)
    val noncePart = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce)
    val aad = "LV1.600000.$saltPart.$noncePart".toByteArray(StandardCharsets.UTF_8)
    val key = pbkdf2(passphrase.toByteArray(StandardCharsets.UTF_8), salt)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad)
    val encrypted = cipher.doFinal(json.toByteArray(StandardCharsets.UTF_8))
    val ciphertext = Base64.getUrlEncoder().withoutPadding().encodeToString(encrypted)
    return "LV1.600000.$saltPart.$noncePart.$ciphertext"
  }

  private fun pbkdf2(password: ByteArray, salt: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(password, "HmacSHA256"))
    val result = ByteArray(32)
    val block = salt + byteArrayOf(0, 0, 0, 1)
    mac.update(block)
    var u = mac.doFinal()
    u.copyInto(result)
    repeat(599_999) {
      u = mac.doFinal(u)
      for (index in result.indices) result[index] = (result[index].toInt() xor u[index].toInt()).toByte()
    }
    return result
  }

  private fun hex(value: String): ByteArray {
    require(value.length % 2 == 0)
    return ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  companion object {
    private const val FIXED_VECTOR =
        "LV1.600000.AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRob." +
            "j5R60yrRlSaxdED8c1tl7QG4YEp7TuEPRRJ93WxzNEFgBuYi25Msr2ibHg4f4qC53CYtgzwRymkXrDsCPD7THGGqVf5dBlAK9-3izwMm70N4n-YmDFXh-3RfSVXPsESSMuDWedRGUwqzpvFiozqBLdQFahOqldO-iIgQr36eL9rMqAaAa5HccOjeCzJKXQcE_NHPms-zYGbYDjFXuN4ZgUXYoXHdNxho6MFksaEKb83IOP2HR--dxki1j4SxCgtaHMu5kNbfmOhKsOEI3D4EUdDnacdSk1UNg3rD2z6o-ErZje6ISuSkGxiKTCcRO_SmnDJOQ64LNO1Pmk3XPaiO5lYkwrH-nTl55L9-vBCbJ4zD42BnXBEcOag64lwa6Sv5utUh5zJ-OGAQ5H0w82R1kycOIEZlvQME"

    private const val UNICODE_VECTOR =
        "LV1.600000.ICEiIyQlJicoKSorLC0uLw.MDEyMzQ1Njc4OTo7." +
            "W8Tc1EKiaurssUwUCEPs040UM4vCiAZhpHmukT7ouWRlcj-2eSYT630FfolYZGTbeptibRQ0f7tSoI0npp7Qgryt8gLwWFWyYK9a64SDCmyCq7_yUtx7us0xeS0a3GEqVNoCGAdPUlrekGrZ893DehDTi7VP8oDEKV_LCiRsFdy4bODBRjf3t7oIqoLq0lAQ5gocfyAHbfqkZWSfOPpeLNuexBjOtNlu-IBoH6nFybWf7BDG"
  }
}
