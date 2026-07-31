# RynL10n iOS SDK — 앱 적용 가이드

기존 iOS 앱에 RynL10n을 붙이는 전체 절차. 서버 준비 → 빌드 연결 → 런타임 연결 순서로 진행한다.
알고리즘·골든 벡터 등 SDK 내부는 [`../README.md`](../README.md), 서버 운영은
[`../../OPERATIONS.md`](../../OPERATIONS.md)를 참조한다.

**요구 사항**: Swift 6 / Xcode 16+ / iOS 15+.

---

## 0. 그림

```
빌드타임 ─ RynL10nBakePlugin ─→ snapshot.json + rynl10n.lock ─→ 앱 번들 (fallback, 항상 완전)
런타임  ─ RemoteDeliveryStore ─→ manifest → 델타/스냅샷      ─→ 오버레이 (키 단위 덮어쓰기)
```

두 계층이 독립이라 **원격이 실패해도 화면은 번들 값으로 정상 동작한다.** SDK는 배포 플레인(정적 파일)만
읽고 관리 API는 절대 호출하지 않는다.

---

## 1. 서버에 프로젝트 만들기

서버를 아직 안 띄웠다면 `docker compose up`(또는 `npm run backend`). 대시보드는
<http://localhost:8787>, 배포 플레인은 <http://localhost:8788>.

대시보드에서 프로젝트·키·번역을 넣고 릴리스를 publish하면 된다. curl로도 동일하다:

```bash
API=http://localhost:8787
AUTH='Authorization: Bearer dev-admin-token'   # 운영 토큰으로 교체
JSON='content-type: application/json'

curl -X POST $API/projects -H "$AUTH" -H "$JSON" \
  -d '{"id":"myapp","name":"My App","defaultLocale":"en","locales":["en","ko"]}'

curl -X PUT $API/projects/myapp/keys/home.title -H "$AUTH" -H "$JSON" \
  -d '{"description":"홈 탭 상단 제목"}'
curl -X PUT $API/projects/myapp/translations/home.title/en -H "$AUTH" -H "$JSON" -d '{"value":"Home"}'
curl -X PUT $API/projects/myapp/translations/home.title/ko -H "$AUTH" -H "$JSON" -d '{"value":"홈"}'

# 릴리스 = 앱 버전 범위 매핑. semver-range는 명시적 하한·상한이 필수다.
curl -X POST $API/projects/myapp/releases -H "$AUTH" -H "$JSON" \
  -d '{"name":"1.x","versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},
       "keys":["home.title"]}'          # → {"id":"R1","state":"draft"}

curl -X POST $API/projects/myapp/releases/R1/publish -H "$AUTH"
curl http://localhost:8788/myapp/manifest.json    # SDK가 읽는 경로 그대로
```

> **`versionMatch`는 앱의 `CFBundleShortVersionString` 기준이다.** 여기서 정한 범위에 앱 버전이
> 들어가지 않으면 런타임은 번들만 쓴다(원격 갱신이 조용히 무시되는 가장 흔한 원인).

---

## 2. 패키지 추가

Xcode: **File → Add Package Dependencies…** → 저장소 URL 입력 → `RynL10n` 라이브러리를 앱 타깃에 추가.

SwiftPM 패키지라면:

```swift
dependencies: [.package(url: "<저장소 URL>", from: "0.1.0")],
targets: [
    .target(name: "App", dependencies: [.product(name: "RynL10n", package: "RynL10n")])
]
```

---

## 3. 빌드타임 번들링 연결 (차별점 ①)

번들은 **네트워크가 없어도 모든 키가 채워져 있게** 만드는 안전망이다. 빌드마다 자동으로 굽는다.

### 3-a. vendored 스냅샷 배치

앱 타깃 소스 트리에 `rynl10n/release-snapshot.json`을 둔다. 내용은 서버에서 받는다:

```bash
curl -H "$AUTH" $API/projects/myapp/releases/R1/snapshot \
  > YourApp/rynl10n/release-snapshot.json
```

**Xcode에서 이 파일을 앱 타깃 멤버십에 포함시켜야 한다** — 플러그인이 타깃의 입력 파일 목록에서 찾는다.

### 3-b. 플러그인 붙이기

| 환경 | 방법 |
| --- | --- |
| **Xcode 앱 타깃** | 타깃 → **Build Phases → Run Build Tool Plug-ins** → `+` → `RynL10nBakePlugin` |
| **SwiftPM 타깃** | `Package.swift`의 타깃에 `plugins: [.plugin(name: "RynL10nBakePlugin", package: "RynL10n")]` 한 줄 |

빌드하면 로그에 `[rynl10n] bake 완료: release=… base=… keys=…`가 찍히고
`snapshot.json` + `rynl10n.lock`이 앱 번들 리소스로 들어간다. **커밋할 산출물은 없다.**

vendored 스냅샷이 없거나 타깃 멤버십에 없으면 플러그인은 **조용히 아무 일도 하지 않는다**(빌드는 성공).
번들이 비면 4단계의 `Snapshot.baked(in:)`이 안내 메시지와 함께 실패하므로 그때 알아채면 된다.

### 3-c. CI에서 최신 스냅샷으로 굽기

vendored 파일을 매번 갱신하기 싫으면 CI가 서버에서 직접 받아 굽는다. **서버가 죽어 있으면 마지막
캐시로 진행**하므로 빌드가 서버 가용성에 묶이지 않는다.

```bash
swift run rynl10n-bake \
  --fetch "$API/projects/myapp/releases/R1/snapshot" --token "$TOKEN" \
  --cache .rynl10n-cache.json \
  --descriptions "$API/projects/myapp/releases/R1/descriptions" \
  --emit-native ./Generated
```

`--emit-native`는 `Localizable.xcstrings`도 함께 방출한다 — `String(localized:)`를 쓰는 기존 코드에
fallback을 주고 싶을 때만 쓰면 된다(선택). 대시보드에 적은 **키 설명이 `.xcstrings`의 `comment`로
구워져** Xcode에서 번역하는 사람에게 맥락이 전달된다.

---

## 4. 런타임 연결

### 4-a. 클라이언트 만들기

앱 시작 시 한 번. 번들 로드는 동기라 스플래시에서 네트워크를 기다릴 일이 없다.

```swift
import RynL10n

enum L10n {
    static let client: RynL10nClient = {
        // Xcode 앱 타깃이면 .main, SwiftPM 타깃이면 .module.
        let bundled = try! Snapshot.baked(in: .main)

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String

        return RynL10nClient(
            bundle: bundled,
            store: remote,
            context: .init(appVersion: version)
        )
    }()

    static let remote = RemoteDeliveryStore(
        baseURL: URL(string: "https://cdn.example.com")!,   // 배포 플레인/CDN 루트
        project: "myapp"
    )
}
```

> `try!`는 예제를 짧게 쓴 것이다. 실제로는 `catch`에서 로그를 남기고 진행하되, 번들이 없으면 번역이
> 전부 `⟪key⟫`로 나오므로 **디버그 빌드에서는 크래시시키는 편**이 초기 설정 실수를 빨리 잡는다.

### 4-b. 조회

```swift
Text(L10n.client.t("home.title"))
Text(L10n.client.t("cart.items", args: ["n": .int(count)]))   // CLDR 복수형
Text(L10n.client.t("home.title", locale: "ja"))               // 로케일 강제
```

`t`는 **동기**다. 항상 번들 fallback이 있으므로 블로킹 네트워크가 없다.
미해결 키는 `⟪key⟫`로 표면화된다(조용한 빈 문자열 금지).

### 4-c. 원격 갱신 — 언제 부르나

`update(_:)`가 한 사이클을 전부 처리한다: manifest 조회(ETag) → **내 앱 버전에 맞는 릴리스 선택** →
필요한 산출물만 다운로드 → 원자적 스왑. 이미 가진 산출물은 다시 받지 않는다(내용해시 URL = 영구 캐시).

기본 시점은 **앱 시작 직후**와 **포그라운드 복귀**다.

```swift
// SwiftUI
.task { try? await L10n.remote.update(L10n.client) }
.onReceive(NotificationCenter.default.publisher(
    for: UIApplication.willEnterForegroundNotification)) { _ in
    Task { try? await L10n.remote.update(L10n.client) }
}
```

```swift
// UIKit — AppDelegate
func applicationDidBecomeActive(_ application: UIApplication) {
    Task { try? await L10n.remote.update(L10n.client) }
}
```

`try?`로 삼켜도 되는 이유: 실패는 **이전 상태 유지**를 뜻할 뿐 화면이 깨지지 않는다.
네트워크가 끊겨 있으면 마지막으로 받은 manifest·산출물 캐시로 진행하고, 캐시조차 없으면
`DeliveryError.unavailable`을 던진 뒤 번들 그대로 동작한다.

### 4-d. SwiftUI 자동 리렌더

`RynL10nObservable`이 카탈로그 갱신 때 `version`을 올려 뷰를 다시 그린다.

```swift
@main
struct MyApp: App {
    @StateObject private var l10n = RynL10nObservable(client: L10n.client)

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(l10n)
                .task { try? await L10n.remote.update(L10n.client) }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var l10n: RynL10nObservable
    var body: some View {
        Text(l10n.t("home.title"))   // client.t 가 아니라 l10n.t — 이래야 갱신 시 다시 그려진다
    }
}
```

`update(_:)`는 스왑과 리스너 통지를 **메인 액터에서** 수행하므로 `@Published` 갱신이 안전하다.

---

## 5. 번역 고치고 배포하기

대시보드에서 값을 고치고 publish하면 끝이다. 앱은 다음 `update(_:)` 때 델타를 받아 반영한다.

```bash
curl -X PUT $API/projects/myapp/translations/home.title/ko -H "$AUTH" -H "$JSON" \
  -d '{"value":"홈 화면"}'
curl -X POST $API/projects/myapp/releases/R1/publish -H "$AUTH"
```

문제가 생기면 롤백은 포인터 되돌리기라 즉시·무손실이다:

```bash
curl -X POST $API/projects/myapp/releases/R1/rollback -H "$AUTH" -H "$JSON" \
  -d '{"to":"<이전 overlay 해시>"}'
```

---

## 6. 동작 확인 (실행 가능한 예제)

[`../../examples/ios-consumer`](../../examples/ios-consumer)가 위 전 과정을 담고 있다.
플러그인 연결 → 번들 로드 → 원격 갱신까지 한 파일에서 볼 수 있다.

```bash
cd examples/ios-consumer
swift run Consumer                                            # 오프라인 — 번들만
RYNL10N_ENDPOINT=http://localhost:8788 RYNL10N_PROJECT=myapp \
  swift run Consumer                                          # 원격 오버레이까지
```

실제 서버를 상대로 확인한 출력(번역을 `홈` → `홈 화면`으로 고쳐 publish한 뒤):

```
[rynl10n] 구워진 번들: release=R42 base=6143bdb72ca86f17 keys=2 locales=["en", "ko"]
[번들만]
  home.title  en=Home  ko=홈
[rynl10n] 카탈로그 갱신: release=R1 overlay=e45f6f4cd7855581
[rynl10n] 원격 갱신 적용됨 — release=R1 base=287ae5478dee71eb
[오버레이 후]
  home.title  en=Home  ko=홈 화면
```

---

## 7. 문제 해결

| 증상 | 원인 | 확인 |
| --- | --- | --- |
| 모든 값이 `⟪key⟫` | 번들이 비었음 | 빌드 로그에 `[rynl10n] bake 완료`가 있는지, `Snapshot.baked` 에러 메시지 |
| `BakedError.notFound` | 플러그인 미연결 / vendored 스냅샷이 타깃 멤버십 밖 | Build Phases → Run Build Tool Plug-ins, 파일 Target Membership |
| 번들 값만 나오고 원격이 안 붙음 | 앱 버전이 릴리스 범위 밖 | `client.status().selection`이 `bundle-only`면 그것. manifest의 `versionMatch` 확인 |
| 특정 키만 옛 값 | 포맷 안전 가드 | 오버레이의 플레이스홀더 서명이 번들과 다르면 그 키만 번들로 fallback(크래시 방지). 서버에서 키 `placeholders` 확인 |
| `DeliveryError.badStatus(404)` | 배포 플레인 경로/프로젝트 ID 불일치 | `curl $CDN/{project}/manifest.json` |
| 값이 안 바뀜 (서버는 바뀜) | manifest ETag 캐시 | manifest는 짧은 TTL. 즉시 확인하려면 `remote.clearCache()` |

`RynL10nClient(telemetry: "aggregate")`로 켜면 `drainTelemetry()`가 익명 집계 카운트
(`overlayApplied` / `formatGuardRejected` / `keyUnresolved` / `deltaFailed`)를 돌려준다.
값·키명·기기 식별자는 포함되지 않는다.

---

## 8. 검증 범위 (정직하게)

- **검증됨**: SwiftPM 경로 전체(플러그인 bake → 번들 로드 → 실서버 대상 manifest·스냅샷·델타 수신 →
  오버레이 적용). `swift test` 34개 통과 — 골든 벡터 정합 + 원격 배포 12개(캐싱·ETag·오프라인 폴백 포함).
- **미검증**: **Xcode 앱 타깃(`.xcodeproj`)에서의 실제 빌드.** 플러그인에 `XcodeBuildToolPlugin`
  구현을 추가했고(Xcode 타깃은 이 프로토콜이 없으면 플러그인이 붙지 않는다) 3-b의 절차는 그에 맞춰
  썼지만, 이 저장소에 Xcode 프로젝트가 없어 실제 앱 빌드로는 확인하지 못했다. 위젯 렌더·리소스 병합도
  마찬가지다. 처음 붙일 때 빌드 로그에 `[rynl10n] bake 완료`가 찍히는지부터 확인할 것.
