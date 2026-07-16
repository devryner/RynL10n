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

## M1 남은 작업

- **빌드타임 자동 번들링 플러그인 (6.3, 차별점 ①)**: SPM build tool plugin(iOS) / Gradle task(Android).
  빌드마다 현재 릴리스 스냅샷 fetch → 번들 리소스로 bake + 네이티브 포맷 변환(5.3) → base 해시를 lockfile에 기록.
- **네이티브 포맷 변환 (5.3)**: 내부 표준(ICU+CLDR) → `.xcstrings`/`strings.xml`/`JSON`/`.arb`.
- **Android 플랫폼 바인딩**: AGP 모듈 + Compose/StateFlow 어댑터.
