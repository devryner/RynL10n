# RynL10n — M0 스파이크

**2계층 resolve + 버전 격리 정적 manifest 라우팅 PoC.** 기획서(SoT)에서 가장 어려운 핵심인
4.3(버전 격리)을 먼저 검증하기 위한 스파이크다. 플랫폼 SDK(iOS/Android)는 M1이며, 여기서는
알고리즘·결정적 직렬화·매칭 규칙을 **런타임 의존성 0의 TypeScript 참조 구현**으로 증명한다.

## 실행

```bash
npm install        # devDep: typescript, @types/node (런타임 의존성 없음)
npm test           # node --test — 유닛 + 시나리오 통합 (39 tests)
npm run typecheck  # tsc --noEmit (strict + erasableSyntaxOnly)
npm run demo       # 시나리오 A/C 콘솔 재현
```

- Node ≥ 23.6 (네이티브 TS 타입 스트리핑). 해싱은 `node:crypto`, NFC는 `String.normalize`.

## 구조 — 기획서 절에 1:1 매핑

| 모듈 | 기획서 | 내용 |
| --- | --- | --- |
| `src/serialize/jcs.ts` | 11.1 | RFC 8785 JCS + 문자열 NFC 정규화. **수동 직렬화**로 키 순서 통제 |
| `src/serialize/hash.ts` | 11.1 | SHA-256 소문자 hex, 16 hex 파일 식별자 절단, 충돌 시 20 hex, 해시 입력에서 `base`·`createdAt` 제외 |
| `src/core/types.ts` | 5 / 11 | Snapshot · Delta · Manifest · VersionMatch 등 스키마 타입 |
| `src/core/placeholder.ts` | 3.1 / 5.3 | 플레이스홀더 서명 추출 + 포맷 안전 가드 |
| `src/core/semver.ts` | 11.3 | node-semver **부분집합** (비교자 + 공백 AND). `\|\|`·`^`·`~`·x-range·hyphen-range **파싱 거부** |
| `src/core/matching.ts` | 4.3 / 8.2 | 범위→구간 환원, publish 충돌 검사(409), 클라이언트 릴리스 판정 |
| `src/core/resolve.ts` | 3.1 | 2계층 resolve, 로케일 우선 fallback, tombstone, 포맷 가드, ICU/CLDR 복수형 포맷팅 |
| `src/builder/builder.ts` | 7.4 / 8.1–8.3 | snapshot/델타/manifest 생성, 자동 상한 닫힘+supersede, 롤백 |
| `src/client/client.ts` | 4.3 / 6.4 | manifest 라우팅 + 델타 적용 + 원자적 스왑 + `onCatalogUpdated` |

## 검증된 핵심 불변식

- **결정성 (11.1)**: 같은 (릴리스, 콘텐츠) → 같은 바이트열 → 같은 해시. 키 순서·NFC(조합형/완성형) 무관.
- **버전 격리 (4.3)**: 신규 키는 도입 릴리스에만 존재 → 구버전 앱에 미노출. 클라이언트가 manifest만으로 자기 릴리스 자체 선택(서버 라우팅 없음).
- **2계층 resolve (3.1)**: 오버레이 → 번들, 키 단위 override. 로케일 우선(더 구체적 로케일의 기존 값 > 덜 구체적 로케일의 최신 값).
- **포맷 안전 가드 (3.1)**: 오버레이 플레이스홀더 서명이 번들과 불일치하면 그 키만 번들로 fallback → 런타임 크래시 차단.
- **롤백 (8.3)**: manifest overlay 포인터를 이전 target으로 되돌리기. 산출물 불변이라 즉시·무손실.
- **범위 충돌 (8.2/11.3)**: 겹치는 semver 범위 동시 published → 409. 신규 하한 지정 시 이전 릴리스 상한 자동 닫힘 + superseded.

## 스파이크에서 드러난 스펙 조정 지점

1. **superseded 릴리스의 라우팅 (8.1 ↔ 11.3)** — 11.3은 클라이언트 후보를 `state=="published"`만으로
   기술하지만, 8.1은 superseded 산출물이 구버전 앱에 계속 서빙된다고 못박는다. 자동 상한 닫힘 후 이전
   릴리스가 superseded가 되므로, `published`만 후보로 두면 구버전 앱이 번들 전용으로 떨어진다(격리 목적엔
   맞지만 최신 오버레이를 못 받음). **본 스파이크는 `selectRelease`가 `published`·`superseded`를 모두
   후보로 두고 `draft`·`archived`만 제외한다.** → 기획서 11.3 문구를 "archived/draft 제외"로 정정 제안.

## 스파이크 범위 밖 (프로덕션에서 보강)

- JCS 숫자: 현재 정수만 지원(스키마 불변식). 임의 number는 RFC 8785 §3.2.2.3(Ryū) 전량 구현 필요.
- CLDR 복수형: en/ko/ja/zh 계열 최소 규칙만. 전량 CLDR 규칙 + 완전한 ICU 파서는 SDK에서.
- 플랫폼 bake(.xcstrings/strings.xml/JSON/.arb 변환, 5.3) · 관리 API 서버 · 인증/RBAC(7.3) · 실제 CDN I/O.
- `nearest-lower` vs `bundle-only` 프로젝트 기본값: 기획서 잠정 `bundle-only`(번역 공백 0 우선)를 기본으로 채택.
