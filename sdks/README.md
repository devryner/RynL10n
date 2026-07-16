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

- 런타임 의존성 0. 해싱은 CryptoKit(Apple), 문자열 정규화는 `precomposedStringWithCanonicalMapping`(NFC).
- 공개 API: `RynL10nClient(bundle:store:context:)` · `t(_:args:locale:)`(동기) · `onCatalogUpdated` · `refresh(manifest:)` · `status()`.
- 빌드·테스트: `cd sdks/ios && swift test` (12개: 골든 8 + 시나리오 A/B/C + 충돌 검사).

```swift
let client = RynL10nClient(bundle: bakedSnapshot, store: cdnStore,
                           context: .init(appVersion: "3.2.1"))
client.onCatalogUpdated { info in /* UI 리렌더 */ }
client.refresh(manifest: manifest)          // 원격 오버레이 적용
let s = client.t("pay.button", locale: "ja") // 동기 — 항상 번들 fallback
```

## Android (`sdks/android`, Kotlin/JVM)

- 순수 Kotlin/JVM 공통 코어 — **Android SDK/AGP 없이 JVM에서 테스트 가능**. 해싱은 `MessageDigest`, NFC는 `java.text.Normalizer`.
- 직렬화는 kotlinx.serialization. 공개 API는 iOS와 대칭(`RynL10nClient.t/onCatalogUpdated/refresh/status`).
- 빌드·테스트: `cd sdks/android && gradle test` (12개, 동일 골든 벡터).
- Android 특화 바인딩(`Context.getString` 래퍼, Compose `stringResource`, `StateFlow`)은 AGP 필요 → 별도 모듈로 후속.

## 플랫폼 공통 매핑 (기획서 절)

| 계층 | 기획서 | iOS 파일 | Android 파일 |
| --- | --- | --- | --- |
| JCS + SHA-256 | 11.1 | `Serialize.swift` | `Serialize.kt` |
| SemVer 부분집합 | 11.3 | `SemVer.swift` | `SemVer.kt` |
| 매칭·충돌·라우팅 | 4.3/8.2/11.3 | `Matching.swift` | `Matching.kt` |
| 2계층 resolve·포맷 가드 | 3.1 | `Resolve.swift` `Placeholder.swift` | `Resolve.kt` `Placeholder.kt` |
| 런타임 클라이언트 | 6.1/6.4 | `RynL10n.swift` | `RynL10n.kt` |

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
`snapshot.json`+`rynl10n.lock`이 자동 포함된다(커밋할 파일도, 잊어버릴 릴리스 단계도 없음).

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

- 실제 Xcode 앱 타깃·AGP 앱 모듈에서의 end-to-end 통합(위젯 렌더·리소스 병합)은 각 플랫폼 앱 프로젝트에서.
- 카나리 실제 활성화(rollout<100)는 8.4 프라이버시 법무 승인 대기 — 코드 완비, 안전 기본값 rollout 100.
