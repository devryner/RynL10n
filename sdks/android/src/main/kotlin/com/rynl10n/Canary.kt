package com.rynl10n

import java.security.MessageDigest

/**
 * 카나리 버킷팅 — 기획서 8.4. hash(installId+releaseId) mod 100 < rollout%.
 * SHA-256 앞 32비트 → mod 100. 전 언어 결정적. installId=기기 로컬 익명 난수(서버 미전송).
 * 안전 기본값 = rollout 100(전체). installId 없으면 rollout<100에서 보수적으로 미수신.
 */
object Canary {
    fun bucket(installId: String, releaseId: String): Int {
        val bytes = MessageDigest.getInstance("SHA-256").digest("$installId:$releaseId".toByteArray(Charsets.UTF_8))
        val u32 = ((bytes[0].toLong() and 0xFF) shl 24) or ((bytes[1].toLong() and 0xFF) shl 16) or
            ((bytes[2].toLong() and 0xFF) shl 8) or (bytes[3].toLong() and 0xFF)
        return (u32 % 100).toInt()
    }

    fun inRollout(rollout: Int, installId: String?, releaseId: String): Boolean {
        if (rollout >= 100) return true
        if (rollout <= 0) return false
        if (installId == null) return false
        return bucket(installId, releaseId) < rollout
    }
}
