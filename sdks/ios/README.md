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

> **원격 참조 경로가 아직 존재하지 않는다**(6.5). SPM은 **저장소 루트의 `Package.swift`만** 패키지로
> 인식하는데 이 저장소는 `sdks/ios/Package.swift`다 — 그래서 `.package(url:)`은 태그를 달아도 통하지
> 않는다. 기획서가 확정한 해법은 `sdks/ios/`를 subtree push하는 **미러 저장소 `rynl10n-swift`**이며
> 아직 만들어지지 않았다. 지금 붙이는 길은 **로컬 경로 참조** 하나다(검증된 경로 —
> `examples/ios-consumer`가 이 방식).

로컬 체크아웃을 참조(권장):

```swift
dependencies: [.package(path: "../RynL10n/sdks/ios")],
targets: [
    .target(name: "App", dependencies: [.product(name: "RynL10n", package: "ios")])
]
```

Xcode에서는 **File → Add Package Dependencies… → Add Local…** 로 `sdks/ios` 디렉토리를 고른 뒤
`RynL10n` 라이브러리를 앱 타깃에 추가한다.

미러 저장소가 서고 `v0.1.0` 태그가 붙으면 아래가 정규 경로가 된다:

```swift
dependencies: [.package(url: "https://github.com/devryner/rynl10n-swift", from: "0.1.0")],
targets: [
    .target(name: "App", dependencies: [.product(name: "RynL10n", package: "rynl10n-swift")])
]
```

> 태그는 **삭제·재작성하지 않는다**(6.5). SPM은 레지스트리 심사가 없고 git 태그가 곧 버전이라,
> 앱의 `Package.resolved`가 커밋 해시를 고정하고 있어 조용히 깨진다.

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

### 4-c-1. 주기 폴링 — 켜 두면 알아서 따라간다

앱이 오래 떠 있는 동안에도 갱신을 받고 싶으면 폴링을 켠다. 즉시 한 번 돌고 간격마다 반복한다.

```swift
L10n.remote.startPolling(L10n.client, interval: 60)   // 기본 60초
```

배터리·트래픽 관리는 **앱이 정한다** — SDK가 생명주기를 가로채지 않는다. 백그라운드 전환 때 끄고
복귀할 때 켜는 것이 기본 패턴이다:

```swift
.onChange(of: scenePhase) { _, phase in
    if phase == .active { L10n.remote.startPolling(L10n.client) }
    else { L10n.remote.stopPolling() }
}
```

이미 가진 산출물은 다시 받지 않고(내용해시 URL), manifest는 ETag 조건부 요청이라 변경이 없으면
304 한 번으로 끝난다. 실패는 삼킨다 — 다음 주기에 다시 시도하면 되기 때문이다.

### 4-c-2. 실시간 푸시 — 폴링 지연을 없애고 싶을 때 (옵트인)

publish 즉시 반영되게 하려면 알림 채널을 붙인다. **프레임은 "manifest가 바뀌었다"는 신호뿐이고,
번역 데이터는 여전히 배포 플레인에서 받는다** — 데이터 경로는 정적으로 유지된다(플레인 분리).

```swift
let push = ServerPushChannel(
    endpoint: URL(string: "https://admin.example.com")!,   // 알림(관리) 플레인 — CDN이 아니다
    project: "myapp"
)
push.start(updating: L10n.client, via: L10n.remote)        // 신호 → 즉시 update
// 백그라운드 전환 등에서 push.stop()
```

**폴링과 함께 켜 두는 것이 정상 구성이다.** 푸시는 지연 단축용이고, 연결이 끊긴 구간(3초 → 최대 60초
백오프로 재연결)의 갱신은 폴링이 덮는다. 알림 플레인을 배치하지 않았다면 이 절은 통째로 건너뛰면 된다.

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

## 4-e. 배포 건전성 텔레메트리 (옵트인)

대시보드 **관측성** 탭과 `releases/{r}/health`(카나리 판정의 입력)를 채우는 익명 집계다.
두 번 옵트인해야 한다 — **수집**(클라이언트 옵션)과 **전송**(리포터 객체 생성).

```swift
let client = RynL10nClient(
    bundle: bundled, store: remote, context: .init(appVersion: version),
    telemetry: "aggregate"                                  // ① 수집 켜기(기본 "off")
)

let reporter = TelemetryReporter(
    endpoint: URL(string: "https://admin.example.com")!,    // 관리 플레인(업로드 경로)
    project: "myapp"
)
reporter.start(client, every: 300)                          // ② 5분마다 전송
// 백그라운드 전환처럼 확실히 올리고 싶은 시점: await reporter.flush(client)
```

올라가는 것은 서버가 정의한 **5개 필드가 전부**다(`projectId`·`releaseId`·`event`·`count`·
`appVersionBucket`). 그 외 필드는 서버가 배치째 거부하므로(프라이버시 가드) **키 이름·번역 값·기기
식별자는 구조적으로 나갈 수 없다.** 카나리 버킷에 쓰는 `installId`도 보내지 않는다.

| 이벤트 | 언제 | 읽는 법 |
| --- | --- | --- |
| `overlay_applied` | 원격 오버레이가 실제로 적용됨 | 카나리 분모 |
| `format_guard_rejected` | 플레이스홀더 서명 불일치로 그 키만 번들 fallback | 올라가면 배포 중단 신호 |
| `key_unresolved` | 어느 계층에서도 못 찾음(`⟪key⟫` 표면화) | 카탈로그 누락 |
| `delta_failed` | 델타 체크섬 불일치·미수신 | 산출물/캐시 문제 |

`appVersionBucket`은 개별 빌드가 아니라 **버전군**이다(`3.2.1` → `3.2`) — 그래야 익명 집계로 남는다.
전송에 실패하면 카운트를 되돌려 다음 주기에 다시 올린다(실패 구간이 사라지면 거부율이 실제보다 낮게 보인다).

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
  오버레이 적용). `swift test` **44개 통과**(2026-08-21 재실행) — Golden 8 · RemoteDelivery 12
  (캐싱·ETag·오프라인 폴백) · PushTelemetry 10(폴링·SSE·집계 전송) · Scenario 4 · M4 4 ·
  Convert 3 · Bake 2 · Observable 1.
- **미검증**: **패키지 게시.** 미러 저장소·태그가 아직 없어 원격 참조 경로 자체가 없다(2절 참조).
  로컬 경로 참조로는 전 구간 검증됨.
- **미검증**: **Xcode 앱 타깃(`.xcodeproj`)에서의 실제 빌드.** 플러그인에 `XcodeBuildToolPlugin`
  구현을 추가했고(Xcode 타깃은 이 프로토콜이 없으면 플러그인이 붙지 않는다) 3-b의 절차는 그에 맞춰
  썼지만, 이 저장소에 Xcode 프로젝트가 없어 실제 앱 빌드로는 확인하지 못했다. 위젯 렌더·리소스 병합도
  마찬가지다. 처음 붙일 때 빌드 로그에 `[rynl10n] bake 완료`가 찍히는지부터 확인할 것.
