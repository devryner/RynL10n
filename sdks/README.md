# RynL10n SDK (M1 α)

iOS(Swift/SPM)·Android(Kotlin/JVM) 플랫폼 SDK. **조회 API + 런타임 로딩 + 버전 격리**를 제공하며,
코어 알고리즘은 M0 TS 참조 구현과 **골든 벡터(`fixtures/golden`)로 바이트·해시·동작 단위 정합성**을 보장한다.

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
# iOS — SPM 실행파일 (build tool plugin이 이 CLI를 래핑)
cd sdks/ios && swift run rynl10n-bake <snapshot.json> <out-dir> [--strict]

# Android — Gradle 태스크
cd sdks/android && gradle rynl10nBake -Psource=<snapshot.json> -Pout=<out-dir> [-Pstrict=true]

# 산출: <out-dir>/rynl10n/snapshot-<base>.json + <out-dir>/rynl10n/rynl10n.lock
```

> **fetch·캐시 fallback**: bake 코어는 순수 함수(입력=스냅샷 파일). 서버에서 현재 릴리스 스냅샷을
> fetch하고 실패 시 마지막 캐시로 진행하는 로직(6.3)은 이 CLI를 감싸는 플러그인/태스크 설정이 담당한다.
> vendored/airgap 모드(시나리오 C)는 커밋된 스냅샷 파일을 그대로 입력으로 쓴다.

## M1 남은 작업

- **플러그인 프로덕션화**: 위 CLI를 빌드 그래프에 자동 연결 — SPM build tool plugin(iOS), AGP preBuild 의존(Android). 서버 fetch + 마지막 캐시 fallback 배선.
- **네이티브 포맷 변환 (5.3, 선택)**: 내부 표준(ICU+CLDR) → `.xcstrings`/`strings.xml`/`JSON`/`.arb` (OS 표준 로컬라이제이션 fallback용 별도 산출물).
- **Android 플랫폼 바인딩**: AGP 모듈 + `Context.getString` 래퍼 + Compose `stringResource`/`StateFlow` 어댑터.
