import Foundation
import RynL10n

// 빌드타임 자동 번들링 → 런타임 로드 → 원격 오버레이까지의 전체 경로 시연 (기획서 3.2 / 6.1 / 6.3).
//
// 1) 빌드: RynL10nBakePlugin이 `rynl10n/release-snapshot.json`을 bake해
//    `snapshot.json` + `rynl10n.lock`을 이 타깃의 리소스 번들에 넣는다(커밋할 파일 없음).
// 2) 런타임: 그 번들을 로드해 RynL10nClient를 만들고 동기 조회한다.
// 3) 원격: RemoteDeliveryStore가 배포 플레인에서 manifest·델타를 받아 키 단위로 덮어쓴다.
//
// 3)을 켜려면 배포 플레인 주소를 넘긴다:
//   RYNL10N_ENDPOINT=http://localhost:8788 RYNL10N_PROJECT=demo swift run Consumer

let bundled: Snapshot
do {
    bundled = try Snapshot.baked(in: .module)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}

if let lock = BakedLockfile.baked(in: .module) {
    print("[rynl10n] 구워진 번들: release=\(lock.release) base=\(lock.base) keys=\(lock.keyCount) locales=\(lock.locales)")
}

let endpoint = ProcessInfo.processInfo.environment["RYNL10N_ENDPOINT"]
let project = ProcessInfo.processInfo.environment["RYNL10N_PROJECT"] ?? "demo"

// 배포 플레인이 지정되지 않으면 오프라인(번들만)으로 동작한다 — 그것만으로도 번역은 완전하다.
let remote = endpoint.flatMap(URL.init(string:)).map {
    RemoteDeliveryStore(baseURL: $0, project: project)
}

let client = RynL10nClient(
    bundle: bundled,
    store: remote ?? InMemoryDeliveryStore(),
    context: .init(appVersion: "1.2.0")   // 실제 앱은 Info.plist의 CFBundleShortVersionString
)

client.onCatalogUpdated { info in
    print("[rynl10n] 카탈로그 갱신: release=\(info.release) overlay=\(info.overlayTarget)")
}

func show(_ label: String) {
    print("""
    \(label)
      home.title  en=\(client.t("home.title"))  ko=\(client.t("home.title", locale: "ko"))
      cart.items  en=\(client.t("cart.items", args: ["n": .int(1)]))  \
    ko=\(client.t("cart.items", args: ["n": .int(3)], locale: "ko"))
    """)
}

show("[번들만]")

// 원격 오버레이 적용 — 실패해도 위 번들 값이 그대로 유지된다(화면은 절대 비지 않는다).
if let remote {
    do {
        let changed = try await remote.update(client)
        print("[rynl10n] 원격 갱신 \(changed ? "적용됨" : "변경 없음") — release=\(client.status().releaseId ?? "-") base=\(client.status().activeBase)")
        show("[오버레이 후]")
    } catch {
        print("[rynl10n] 원격 갱신 실패 → 번들로 계속: \(error)")
    }
} else {
    print("[rynl10n] RYNL10N_ENDPOINT 미지정 → 원격 갱신 생략(번들만으로 동작).")
}
