import Foundation
import CryptoKit

/// 카나리 버킷팅 — 기획서 8.4. hash(installId+releaseId) mod 100 < rollout%.
/// SHA-256 앞 32비트 → mod 100. 전 언어 결정적. installId=기기 로컬 익명 난수(서버 미전송).
/// 안전 기본값 = rollout 100(전체). installId 없으면 rollout<100에서 보수적으로 미수신.
public enum Canary {
    public static func bucket(installId: String, releaseId: String) -> Int {
        let digest = SHA256.hash(data: Data("\(installId):\(releaseId)".utf8))
        let bytes = Array(digest)
        let u32 = (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16) | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
        return Int(u32 % 100)
    }

    public static func inRollout(_ rollout: Int, installId: String?, releaseId: String) -> Bool {
        if rollout >= 100 { return true }
        if rollout <= 0 { return false }
        guard let installId else { return false }
        return bucket(installId: installId, releaseId: releaseId) < rollout
    }
}
