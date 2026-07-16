import Foundation
import XCTest
@testable import RynL10n

/// M0 TS 참조 구현과의 정합성 검증 — fixtures/golden/*.json.
/// 이 테스트가 통과하면 Swift SDK가 참조 구현과 바이트/해시/동작 단위로 일치한다.
final class GoldenTests: XCTestCase {

    func testSerialize() throws {
        struct Case: Decodable { let name: String; let value: JSONValue; let canonical: String; let sha256: String; let fileId16: String }
        struct File: Decodable { let cases: [Case] }
        let f = try Golden.load("serialize.json", as: File.self)
        for c in f.cases {
            XCTAssertEqual(JCS.canonicalString(c.value), c.canonical, "canonical: \(c.name)")
            XCTAssertEqual(ContentHash.sha256Hex(c.value), c.sha256, "sha256: \(c.name)")
            XCTAssertEqual(ContentHash.fileId(c.sha256), c.fileId16, "fileId: \(c.name)")
        }
    }

    func testNFC() throws {
        struct Case: Decodable { let name: String; let composed: String; let decomposed: String; let sha256: String }
        struct File: Decodable { let cases: [Case] }
        let f = try Golden.load("nfc.json", as: File.self)
        for c in f.cases {
            XCTAssertEqual(ContentHash.sha256Hex(.object(["v": .string(c.composed)])), c.sha256, "composed: \(c.name)")
            XCTAssertEqual(ContentHash.sha256Hex(.object(["v": .string(c.decomposed)])), c.sha256, "decomposed: \(c.name)")
        }
    }

    func testSnapshotHash() throws {
        struct Input: Decodable { let release: String; let defaultLocale: String; let locales: JSONValue }
        struct Case: Decodable { let name: String; let input: Input; let canonical: String; let fullHash: String; let base16: String }
        struct File: Decodable { let cases: [Case] }
        let f = try Golden.load("snapshot-hash.json", as: File.self)
        for c in f.cases {
            let obj: JSONValue = .object([
                "release": .string(c.input.release),
                "defaultLocale": .string(c.input.defaultLocale),
                "locales": c.input.locales,
            ])
            XCTAssertEqual(JCS.canonicalString(obj), c.canonical, "canonical: \(c.name)")
            let full = ContentHash.snapshotHash(release: c.input.release, defaultLocale: c.input.defaultLocale, locales: c.input.locales)
            XCTAssertEqual(full, c.fullHash, "fullHash: \(c.name)")
            XCTAssertEqual(ContentHash.fileId(full), c.base16, "base16: \(c.name)")
        }
    }

    func testDeltaApplication() throws {
        struct CaseWrap: Decodable { let from: Snapshot; let to: Snapshot; let delta: Delta }
        struct File: Decodable { let `case`: CaseWrap }
        let f = try Golden.load("delta.json", as: File.self)
        let (from, to, delta) = (f.case.from, f.case.to, f.case.delta)
        XCTAssertEqual(delta.from, from.base)
        XCTAssertEqual(delta.to, to.base)
        // 델타를 from 위에 오버레이로 적용 → set은 오버레이에서 to 값이, delete는 tombstone.
        let overlay = OverlayLayer.from(delta: delta)
        for op in delta.ops {
            let r = Resolve.resolveValue(bundle: from, overlay: overlay, key: op.key, locale: op.locale)
            if op.op == "set" {
                XCTAssertEqual(r.source, "overlay", "set 적용: \(op.locale)/\(op.key)")
                XCTAssertTranslationEqual(r.value, op.value)
            } else {
                // tombstone: from 값이 그 로케일에서 가려짐(오버레이 소스가 아님)
                XCTAssertNotEqual(r.matchedLocale, op.locale, "tombstone 가림: \(op.locale)/\(op.key)")
            }
        }
    }

    func testResolve() throws {
        struct OverlayInput: Decodable { let locale: String; let key: String; let value: TranslationValue?; let tombstone: Bool? }
        struct Expected: Decodable { let value: TranslationValue?; let source: String; let matchedLocale: String?; let guardFallback: Bool }
        struct Case: Decodable { let name: String; let overlay: [OverlayInput]; let key: String; let locale: String; let expected: Expected }
        struct File: Decodable { let bundle: Snapshot; let cases: [Case] }
        let f = try Golden.load("resolve.json", as: File.self)
        for c in f.cases {
            let overlay = OverlayLayer()
            for e in c.overlay {
                if e.tombstone == true { overlay.tombstone(e.locale, e.key) }
                else if let v = e.value { overlay.set(e.locale, e.key, v) }
            }
            let r = Resolve.resolveValue(bundle: f.bundle, overlay: overlay, key: c.key, locale: c.locale)
            XCTAssertEqual(r.source, c.expected.source, "source: \(c.name)")
            XCTAssertEqual(r.matchedLocale, c.expected.matchedLocale, "matchedLocale: \(c.name)")
            XCTAssertEqual(r.guardFallback, c.expected.guardFallback, "guardFallback: \(c.name)")
            XCTAssertTranslationEqual(r.value, c.expected.value, "value: \(c.name)")
        }
    }

    func testFormat() throws {
        struct Case: Decodable { let name: String; let value: TranslationValue; let locale: String; let args: [String: JSONValue]; let expected: String }
        struct File: Decodable { let cases: [Case] }
        let f = try Golden.load("format.json", as: File.self)
        for c in f.cases {
            XCTAssertEqual(Resolve.format(c.value, locale: c.locale, args: c.args), c.expected, "format: \(c.name)")
        }
    }

    func testSemver() throws {
        struct Sat: Decodable { let version: String; let range: String; let matchPrerelease: Bool?; let expected: Bool }
        struct Rej: Decodable { let range: String; let expectedThrow: Bool }
        struct File: Decodable { let satisfies: [Sat]; let reject: [Rej] }
        let f = try Golden.load("semver.json", as: File.self)
        for c in f.satisfies {
            let got = try SemVerParser.versionInRange(c.version, c.range, matchPrerelease: c.matchPrerelease ?? false)
            XCTAssertEqual(got, c.expected, "satisfies: \(c.version) in \(c.range)")
        }
        for c in f.reject {
            if c.expectedThrow {
                XCTAssertThrowsError(try SemVerParser.parseRange(c.range), "reject: \(c.range)")
            }
        }
    }

    func testRouting() throws {
        struct Ctx: Decodable { let appVersion: String?; let releaseLabel: String?; let matchPrerelease: Bool?; let fallbackPolicy: String? }
        struct Expected: Decodable { let kind: String; let releaseId: String? }
        struct Case: Decodable { let name: String; let releases: [ManifestRelease]; let ctx: Ctx; let expected: Expected }
        struct File: Decodable { let cases: [Case] }
        let f = try Golden.load("routing.json", as: File.self)
        for c in f.cases {
            let policy: FallbackPolicy = c.ctx.fallbackPolicy == "nearest-lower" ? .nearestLower : .bundleOnly
            let ctx = Matching.ClientContext(appVersion: c.ctx.appVersion, releaseLabel: c.ctx.releaseLabel,
                                             matchPrerelease: c.ctx.matchPrerelease ?? false, fallbackPolicy: policy)
            let sel = Matching.selectRelease(c.releases, ctx)
            XCTAssertEqual(sel.kind, c.expected.kind, "kind: \(c.name)")
            XCTAssertEqual(sel.releaseId, c.expected.releaseId, "releaseId: \(c.name)")
        }
    }
}
