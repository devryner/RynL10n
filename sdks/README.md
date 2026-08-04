# RynL10n SDK (M1 α)

iOS(Swift/SPM)·Android(Kotlin/JVM)·**Web(TS)**·**Flutter(Dart)** 플랫폼 SDK. **조회 API + 런타임 로딩 +
버전 격리 + 카나리 + 실시간 푸시**를 제공하며, 코어 알고리즘은 M0 TS 참조 구현과 **골든 벡터(`fixtures/golden`)로
4개 언어 모두 바이트·해시·동작 단위 정합성**을 보장한다. (Web=`sdks/web`, Flutter=`sdks/flutter`.)

## 정합성 전략 — 골든 벡터

M0 TS 참조 구현이 정규화·해시·resolve·매칭·포맷·라우팅의 기대 출력을 언어 무관 JSON으로 방출한다
(`tools/gen-golden.ts` → `fixtures/golden/*.json`). 각 플랫폼 SDK는 이 벡터를 로드해 자신의 구현이
참조와 일치하는지 검증한다. **한 알고리즘을 세 언어로 이식하되, 정합성은 기계적으로 증명된다.**

스키마·알고리즘이 바뀌면: `npm run gen:golden`으로 재생성 → 각 SDK 테스트 재실행.

## iOS (`sdks/ios`, Swift 6)

> **기존 앱에 붙이려면 [`ios/README.md`](ios/README.md)** — 서버 준비부터 Xcode 연결·런타임 갱신까지 단계별 가이드.

- 런타임 의존성 0. 해싱은 CryptoKit(Apple), 문자열 정규화는 `precomposedStringWithCanonicalMapping`(NFC).
- 공개 API: `RynL10nClient(bundle:store:context:)` · `t(_:args:locale:)`(동기) · `onCatalogUpdated` · `refresh(manifest:)` · `status()`.
- **번들 로드**: `Snapshot.baked(in:)` — 빌드 플러그인이 구운 `snapshot.json`을 리소스 번들에서 읽는다(`BakedLockfile.baked(in:)`은 진단용).
- **배포 플레인 접근**: `RemoteDeliveryStore(baseURL:project:)` — manifest(ETag·짧은 TTL) + 산출물(내용해시·영구 캐시)을
  HTTP로 받아 디스크에 캐싱한다. `update(_:)` 한 번이 조회→선택→다운로드→원자적 스왑 전체를 처리하며,
  오프라인이면 마지막 캐시로 진행한다. 동기 프로토콜(`DeliveryStore`) 조회는 **캐시만** 본다(네트워크 대기 없음).
- 빌드·테스트: `cd sdks/ios && swift test` (34개: 골든 + 시나리오 A/B/C + 충돌 검사 + 원격 배포 12).

```swift
let client = RynL10nClient(bundle: bakedSnapshot, store: cdnStore,
                           context: .init(appVersion: "3.2.1"))
client.onCatalogUpdated { info in /* UI 리렌더 */ }
client.refresh(manifest: manifest)          // 원격 오버레이 적용
let s = client.t("pay.button", locale: "ja") // 동기 — 항상 번들 fallback
```

## Android (`sdks/android`, Kotlin/JVM + AAR)

> **기존 앱에 붙이려면 [`android/README.md`](android/README.md)** — 서버 준비부터 bake 연결·런타임 갱신까지 단계별 가이드.

- 코어는 순수 Kotlin/JVM — **Android SDK/AGP 없이 JVM에서 테스트 가능**. 해싱은 `MessageDigest`, NFC는 `java.text.Normalizer`.
- 직렬화는 kotlinx.serialization. 공개 API는 iOS와 대칭(`RynL10nClient.t/onCatalogUpdated/refresh/status`).
- **번들 로드**: `BakedBundle.snapshot(dir)`(JVM) · `BakedBundle.fromAssets(context)`(AAR) — bake 산출물을 assets에서 읽는다.
- **배포 플레인 접근**: `RemoteDeliveryStore(baseUrl, project, cacheDir)` — manifest(ETag) + 산출물(내용해시·영구 캐시)을
  HTTP로 받아 디스크에 캐싱한다. `update(client)` 한 번이 조회→선택→다운로드→원자적 스왑 전체를 처리하며,
  오프라인이면 마지막 캐시로 진행한다. 동기 인터페이스(`DeliveryStore`) 조회는 **캐시만** 본다(네트워크 대기 없음).
  iOS와 동작이 대칭이나 스왑 스레드만 다르다 — 호출한 코루틴 컨텍스트에서 스왑하고, 통지는 `StateFlow`로 흐른다.
- **Android 바인딩**(`library/`, AAR): `RynL10n.configure/t/update` 파사드 · `Context.rynl10n(key)` · Compose `rynl10nString(key)`.
  Compose 런타임은 `compileOnly`라 Compose를 쓰지 않는 앱에 딸려 들어가지 않는다.
- 빌드·테스트: `cd sdks/android && ./gradlew test` (40개: 골든 + 시나리오 + **배포 플레인 9** + **번들 로더 8**) ·
  `./gradlew :library:assembleRelease` (AAR) · `./gradlew :library:publishToMavenLocal`.
- 툴체인: AGP 8.7.3 / Gradle 8.11.1(wrapper) / Kotlin 2.1.0 / minSdk 26.

## Web (`sdks/web`, TypeScript)

> 사용법은 [`web/README.md`](web/README.md).

- 코어 알고리즘은 **참조 구현(`../../src`)을 그대로 재사용** — 이식이 아니라 공유라 정합은 자동이다.
- 공개 API: `HttpRynL10n`(fetch/ETag 폴링 + SSE 푸시) · `createStore`(React `useSyncExternalStore` 계약).
- **번들 로드**: `BakedBundle.parse(raw)`(번들러 import 검증) · `BakedBundle.load("/assets")`(정적 자산 fetch,
  `rynl10n/snapshot.json` → `snapshot.json` 순). 잘못된 JSON은 런타임 깊은 곳이 아니라 이 관문에서 잡힌다.
- **배포 플레인 접근**: `HttpRynL10n.refresh()`가 조회→선택→다운로드→스왑 전체를 처리한다. 산출물은
  내용해시 URL이라 **영속 캐시**(기본 `localStorage`, `PersistentCache`로 교체 가능)에 그대로 둔다 →
  탭을 새로 열거나 오프라인으로 들어와도 마지막 카탈로그가 살아 있다. `clearCache()`로 비운다.
  `refresh()`는 폴링 루프 자리라 던지지 않고, 진단용 `loadManifest()`가 `DeliveryError`를 던진다.
- 빌드·테스트: `cd sdks/web && node --test "test/*.test.ts"` (23개: 폴링·푸시 + **앱 적용 경로 18**).

## Flutter (`sdks/flutter`, Dart)

> 사용법은 [`flutter/README.md`](flutter/README.md).

- 순수 Dart 코어라 `dart test`로 검증(Flutter 위젯 불요). NFC=`unorm_dart`, SHA-256=`crypto`.
- **번들 로드**: `parseBakedSnapshot(text)` — Flutter 자산은 문자열로 오므로(`rootBundle.loadString`)
  파싱이 아니라 **검증**이 요점. 파일 시스템 버전은 `loadBakedSnapshot(Directory)`.
- **배포 플레인 접근**: `RemoteDeliveryStore(baseUrl:project:fetch:cache:)` — `update(client)` 한 번이
  조회→선택→다운로드→원자적 스왑 전체를 처리하고, 오프라인이면 마지막 캐시로 진행한다.
- **`dart:io` 의존은 어댑터에만**: 코어는 `DeliveryFetch`·`ArtifactCache`를 주입받는 순수 Dart이고,
  기본 구현(`ioDeliveryFetch()`·`FileArtifactCache`)은 별도 진입점 `package:rynl10n/rynl10n_io.dart`에 있다
  → Flutter Web은 `package:http` 어댑터를 꽂으면 나머지 동작이 동일하다.
- 빌드·테스트: `cd sdks/flutter && dart pub get && dart test` (34개: 골든·시나리오 + **앱 적용 경로 19**).

## 플랫폼 공통 매핑 (기획서 절)

| 계층 | 기획서 | iOS 파일 | Android 파일 | Flutter 파일 |
| --- | --- | --- | --- | --- |
| JCS + SHA-256 | 11.1 | `Serialize.swift` | `Serialize.kt` | `jcs.dart` |
| SemVer 부분집합 | 11.3 | `SemVer.swift` | `SemVer.kt` | `semver.dart` |
| 매칭·충돌·라우팅 | 4.3/8.2/11.3 | `Matching.swift` | `Matching.kt` | `matching.dart` |
| 2계층 resolve·포맷 가드 | 3.1 | `Resolve.swift` `Placeholder.swift` | `Resolve.kt` `Placeholder.kt` | `resolve.dart` `placeholder.dart` |
| 런타임 클라이언트 | 6.1/6.4 | `RynL10n.swift` | `RynL10n.kt` | `client.dart` |
| 번들 로더 | 6.3 | `BakedBundle.swift` | `BakedBundle.kt` | `baked.dart` |
| 배포 플레인 HTTP | 6.4/7.2 | `RemoteDelivery.swift` | `RemoteDelivery.kt` | `delivery.dart` + `io_adapters.dart` |

> Web은 이식이 아니라 **참조 구현(`src/`)을 직접 import**하므로 이 표의 대응물이 없다.
> 앱 적용 경로만 자체 구현이다(`web/src/baked.ts` · `web/src/http.ts` · `web/src/cache.ts`).

## 빌드타임 자동 번들링 (6.3, 차별점 ①) ✅

빌드마다 현재 릴리스 스냅샷을 SDK 번들로 bake한다. **1차 산출물은 우리 스냅샷 JSON**(SDK의 2계층
resolve가 그대로 읽는 번들). bake 코어가 ① 기본 로케일 100% 커버리지 검증(strict 모드는 빌드 실패, 3.1)
② base 해시 무결성 확인 ③ 번들 리소스(`snapshot-<base>.json`) + lockfile(`rynl10n.lock`, release·base 기록)
방출을 담당한다. lockfile·번들은 JCS 정규화라 **결정적** — 같은 소스 → 같은 바이트(CI 재현성).

bake 코어(`Bake.swift`/`Bake.kt`)도 골든 벡터(`fixtures/golden/bake.json`)로 참조 구현과 정합. 실제로
**iOS·Android CLI가 같은 스냅샷에서 바이트 단위로 동일한 번들+lockfile을 방출**한다(크로스플랫폼 결정성 검증).

```bash
# vendored/에어갭 — 커밋된 스냅샷 파일 입력
cd sdks/ios && swift run rynl10n-bake <snapshot.json> <out-dir> [--strict] [--emit-native]
cd sdks/android && gradle rynl10nBake -Psource=<snapshot.json> -Pout=<out-dir>

# 서버 fetch(6.3) — 현재 릴리스 스냅샷을 받아 캐시에 저장, 실패 시 마지막 캐시로 진행
swift run rynl10n-bake --fetch <api>/projects/{p}/releases/{r}/snapshot --token <t> --cache <p> <out-dir>
gradle rynl10nBake -Pfetch=<url> -Ptoken=<t> -Pcache=<p> -Pout=<out-dir>

# 산출: <out-dir>/rynl10n/snapshot-<base>.json + <out-dir>/rynl10n/rynl10n.lock
```

> **fetch·캐시 fallback(6.3)**: `--fetch`는 관리 API의 릴리스 스냅샷 엔드포인트(`GET /projects/{p}/releases/{r}/snapshot`,
> DB에서 결정적 빌드)를 받아 `--cache`에 저장한다. **서버 접근 실패 시 마지막 캐시로 진행** → 빌드가 서버
> 가용성에 종속되지 않음. vendored/에어갭(시나리오 C)은 커밋된 스냅샷 파일을 그대로 입력으로 쓴다.
> 검증: iOS·Android CLI가 서버 fetch·캐시 fallback 모두에서 바이트 동일 산출물 생성.

### 빌드 그래프 자동 연결 (플러그인 한 줄, 차별점 ①)

**iOS — SPM build tool plugin.** 소비 패키지가 vendored 스냅샷(`Sources/<Target>/rynl10n/release-snapshot.json`)을
두고 플러그인 한 줄만 추가하면 `swift build`가 자동으로 bake해 **앱 리소스 번들에 포함**한다(에어갭·샌드박스 적합):

```swift
.executableTarget(
    name: "App",
    dependencies: [.product(name: "RynL10n", package: "ios")],
    plugins: [.plugin(name: "RynL10nBakePlugin", package: "ios")]   // ← 이 한 줄
)
```
검증: `examples/ios-consumer`를 `swift build`하면 `[rynl10n] bake 완료` 후 `Consumer_Consumer.bundle`에
`snapshot.json`+`rynl10n.lock`이 자동 포함되고, `swift run Consumer`가 그 번들을 로드해 조회까지 수행한다
(커밋할 파일도, 잊어버릴 릴리스 단계도 없음).

**Xcode 앱 타깃(`.xcodeproj`)** 은 `BuildToolPlugin`만으로는 플러그인이 붙지 않는다 → 플러그인이
`XcodeBuildToolPlugin`을 함께 구현하며, 타깃의 입력 파일에서 `rynl10n/release-snapshot.json`을 찾는다.
연결은 타깃 → Build Phases → **Run Build Tool Plug-ins**. (이 경로는 실제 Xcode 앱 빌드로는 미검증 —
`ios/README.md` §8 참조.)

**Android — Gradle 태스크(AGP preBuild 연결).** `rynl10nBake` 태스크를 앱 모듈의 `preBuild`에 의존시키고
출력을 `assets/`(또는 res)로 지정한다. CI에서는 `--fetch`로 최신 스냅샷을 받고, 앱 빌드는 로컬 캐시로 진행:

```kotlin
// 앱 build.gradle.kts
tasks.named("preBuild").configure { dependsOn(":rynl10nBake") }
// gradle rynl10nBake -Pfetch=<url> -Ptoken=<t> -Pcache=<p> -Pout=src/main/assets -PstableName=true
```

## 네이티브 포맷 변환 (5.3) ✅

내부 표준(ICU MessageFormat + CLDR 복수형 맵)을 플랫폼 네이티브 포맷으로 변환한다 — OS 표준
로컬라이제이션(`String(localized:)`/`getString`)에도 fallback을 제공하는 **선택 산출물**. `bake --emit-native`.

- **iOS `.xcstrings`** (Xcode String Catalog, 전 로케일 1파일): `stringUnit` / 복수형 `variations.plural`. `{name}` → `%1$@`·`%1$lld`.
- **Android `strings.xml`** (로케일별 `values-<locale>/`): `<string>` / `<plurals>`. `{name}` → `%1$s`·`%1$d`. 리소스명 sanitize(`cart.title`→`cart_title`), XML 이스케이프.
- **Web JSON / Flutter `.arb`**: TS 참조가 방출(`{name}` 보존 / ICU plural in-string + `@key` 메타).
- 손실 규칙(5.3): 미지원 CLDR 카테고리는 other 병합 + 경고. 이름 sanitize·변환 손실은 warnings로 표면화.

변환기(`Convert.swift`/`Convert.kt`)도 골든 벡터(`fixtures/golden/convert.json`)로 참조 구현과 정합
(Android는 strings.xml 정확 문자열, iOS는 .xcstrings 구조). `swift run rynl10n-bake ... --emit-native`,
`gradle rynl10nBake ... -PemitNative=true`로 실제 네이티브 파일 방출.

## 코어 파리티 (4개 언어)

TS·Swift·Kotlin·Dart 모두 동일 골든 벡터로 다음을 검증: JCS·해시·resolve·매칭·**정수 버전 매칭
(integer-range)**·**카나리 버킷팅(8.4)**·**텔레메트리 카운터(9.3, overlay_applied/format_guard_rejected/
key_unresolved/delta_failed)**. 클라이언트 `installId`(카나리)·`telemetry` 옵션 4개 언어 공통.

## 반응형 바인딩 (6.2)

- **iOS**: `RynL10nObservable`(Combine `ObservableObject`) — 갱신 시 `version` 증가 + `objectWillChange` 발화.
  `@StateObject var l10n = RynL10nObservable(client:)` 후 `Text(l10n.t("key"))`.
- **Android**: `RynL10nState`(kotlinx `StateFlow<Int>`) — 갱신 시 `version` 증가. Compose에서
  `state.version.collectAsState()`로 구독 → 리컴포지션. (Compose `stringResource` 얇은 래퍼는 앱 모듈.)
- **Web**: `createStore`(`useSyncExternalStore` 계약) — README 상단 참조.

## 남은 작업 (앱 환경 필요)

- 실제 Xcode 앱 타깃·Android 앱 모듈에서의 end-to-end 통합(위젯 렌더·리소스/assets 병합)은 각 플랫폼 앱 프로젝트에서.
  iOS는 SwiftPM 경로가 실서버 대상까지 검증됐고(`ios/README.md` §6), Xcode 타깃 경로는 코드만 준비된 상태.
  Android는 AAR 빌드·로컬 퍼블리시까지 검증됐고 앱 모듈 통합은 미검증(`android/README.md` §7).
- **Flutter Web**: 코어는 순수 Dart라 그대로 돌지만 기본 어댑터(`rynl10n_io.dart`)는 `dart:io`를 쓴다 →
  `package:http` 등으로 `DeliveryFetch`를 채우는 어댑터는 앱이 고른다(SDK가 HTTP 패키지를 강제하지 않는다).
- 카나리 실제 활성화(rollout<100)는 8.4 프라이버시 법무 승인 대기 — 코드 완비, 안전 기본값 rollout 100.
