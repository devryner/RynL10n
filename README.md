# RynL10n

**앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라.**

빌드타임에 자동으로 구운 번들(fallback)과 런타임 원격 오버레이의 **2계층 구조**로,
항상 완전한 번역을 보장하면서 스토어 심사 없이 즉시 갱신합니다.

```
번들(빌드타임, 완전한 스냅샷)  ←  항상 존재하는 안전망
오버레이(런타임, 변경분만)     ←  키 단위로 즉시 덮어쓰기
```

- **오타 하나 고치려고 앱 심사를 다시 받지 않습니다** — 대시보드에서 수정 → publish → 수 분 내 전 기기 반영.
- **네트워크가 끊겨도 빈 문자열이 없습니다** — 모든 키는 빌드에 포함된 번들이 fallback을 보장합니다.
- **완전한 셀프호스팅** — `docker compose up` 한 줄, Apache-2.0 단일 라이선스, 기능 게이팅 없음.

## 왜 RynL10n인가

| | 일반적인 OTA 번역 서비스 | RynL10n |
| --- | --- | --- |
| 번들링 | 번역 파일을 수동 다운로드·커밋 | **빌드 플러그인 한 줄** — 빌드마다 자동 bake, 커밋할 파일 없음 |
| 셀프호스팅 | 없거나 유료/제한 | **완전 오픈소스** (Apache-2.0 단일, 전 기능 포함) |
| 서버 장애 시 | 번역 조회 불가 위험 | 배포 플레인은 정적 파일 + CDN — **관리 서버가 죽어도 서빙 지속** |
| 런타임 안전성 | 잘못된 플레이스홀더로 크래시 가능 | **포맷 안전 가드** — 서명 불일치 키만 번들로 자동 fallback |
| 롤백 | 재배포 필요 | 불변 산출물 + 포인터 되돌리기 — **즉시·무손실** |

## 지원 플랫폼

| 플랫폼 | SDK | 빌드타임 자동 번들링 | 반응형 바인딩 |
| --- | --- | --- | --- |
| iOS | Swift 6 / SPM (`sdks/ios`) | SPM build tool plugin | SwiftUI Combine |
| Android | Kotlin / Gradle (`sdks/android`) | Gradle task | StateFlow |
| Web | TypeScript (`sdks/web`) | 번들러 연동 | React 어댑터 |
| Flutter | 순수 Dart (`sdks/flutter`) | build hook | ValueListenable |

SDK 표면은 세 가지가 전부입니다:

```
RynL10n.configure(projectKey, endpoint, options)
t(key, args)                 // 동기 — 번들 fallback이 항상 있어 블로킹 네트워크 없음
onCatalogUpdated(listener)   // 원격 갱신 알림
```

## 빠른 시작

### 1. 서버 실행 (셀프호스트)

```bash
docker compose up   # 관리 API :8787 + 배포 플레인 :8788
```

최소 사양 2 vCPU / 4GB면 충분합니다. 읽기 트래픽은 정적 파일 + CDN이 흡수하므로
앱 사용자가 늘어도 관리 서버 증설이 필요 없습니다.

### 2. 앱에 플러그인 한 줄 추가

빌드 플러그인이 빌드마다 현재 릴리스 스냅샷을 받아 플랫폼 네이티브 포맷
(`.xcstrings` / `strings.xml` / JSON / `.arb`)으로 자동 bake하고, base 해시를
lockfile에 기록해 CI 재현성을 보장합니다. 서버에 접근할 수 없으면 마지막 캐시로
빌드를 계속하며, 완전 폐쇄망을 위한 vendored 모드도 지원합니다.

### 3. 번역 수정 → publish

관리 API(또는 대시보드)에서 번역을 수정하고 publish하면 실행 중인 앱이
오버레이를 받아 즉시 반영합니다. 문제가 생기면 롤백 한 번으로 이전 상태로
무손실 복귀합니다.

## 아키텍처 핵심

- **플레인 분리** — 쓰기 경로(관리 API + DB + 빌더)와 읽기 경로(오브젝트 스토리지 + CDN, 정적 파일만)를 완전히 분리. SDK는 관리 API를 절대 호출하지 않습니다.
- **버전 격리** — 릴리스를 앱 버전 범위에 매핑하고, 클라이언트가 정적 manifest만으로 자기 릴리스를 스스로 선택합니다(서버 라우팅 없음). 신규 키가 구버전 앱에 노출되지 않습니다.
- **결정적 직렬화** — RFC 8785(JCS) + NFC 정규화 + SHA-256 내용해시. 같은 콘텐츠는 항상 같은 바이트열이므로 불변 캐싱·무손실 롤백·DB만으로 전체 산출물 재생성(재해복구)이 성립합니다.
- **골든 벡터 계약** — TypeScript 참조 구현이 기대 출력을 언어 무관 JSON으로 방출하고, 4개 SDK가 이를 로드해 바이트·해시·동작 정합을 기계 검증합니다.

## 저장소 구성

```
src/                  결정적 코어 참조 구현 (TypeScript, 런타임 의존성 0)
backend/              관리 백엔드 (REST API + 산출물 빌더)
sdks/                 ios · android · web · flutter SDK
fixtures/golden/      크로스언어 계약 골든 벡터
examples/             SPM 플러그인 소비 예제 등
docker-compose.yml    단일 노드 셀프호스트
```

## 개발

Node ≥ 23.6 (네이티브 타입 스트리핑 — 빌드 스텝 없음). 코어·백엔드 모두 외부 런타임 의존성이 없습니다.

```bash
npm test                 # 코어 참조 구현 테스트
npm run test:backend     # 관리 백엔드 테스트
npm run gen:golden       # 골든 벡터 재생성 (스키마/알고리즘 변경 시)
swift test               # sdks/ios
gradle test              # sdks/android
node --test "test/*.test.ts"   # sdks/web
dart test                # sdks/flutter
```

## 라이선스

[Apache-2.0](LICENSE) — SDK·서버·어드민 전체 단일 라이선스. 기능 게이팅이나
엔터프라이즈 전용 기능 없이 코어만으로 기능적으로 완전한 제품입니다.
