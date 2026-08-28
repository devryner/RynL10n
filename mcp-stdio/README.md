# `mcp-stdio` — 앱 개발자용 로컬 MCP 서버

**이 저장소가 아니라 소비자 앱 저장소에서 도는 것을 전제로 한 별개 서버다.** 에이전트가
서브프로세스로 띄우고, **인증이 없다**(그 사용자로 그 디렉토리에서 돈다). stdio인 이유는
**파일** 때문이다 — 관리 플레인 서버는 앱 저장소를 볼 수 없다.

```bash
npm run mcp:stdio          # 저장소 안에서 직접 (게시 전)
```

## 경계 — stdio = 파일 / HTTP = 카탈로그

관리 플레인의 MCP 표면(`POST /mcp`, `backend/src/mcp/`)과 **다른 축이다**. 저쪽은 카탈로그(DB)를
보고 여기는 앱 저장소의 파일을 본다. stdio가 관리 API에 쓰기를 시작하면 HTTP 서버 일을 대신하게
되고 인증 축이 하나 더 생긴다. 에이전트가 둘 다 붙여 두면 워크플로가 이어진다 — 여기서 "빌드에
무엇이 구워지나"를 보고, 저기서 `validate_translation` 뒤 카탈로그를 고친다.

## 도구

### `bake_preview` — 다음 빌드가 무엇을 구울 것인가 (쓰기 없음)

빌드 플러그인(SPM build tool plugin · Gradle task)이 빌드마다 스냅샷을 네이티브 산출물로 굽는데,
**그 결과를 빌드 전에 볼 자리가 지금 아무 데도 없다.** 빌드를 돌려 봐야 알고, 돌리고 나면 이미
덮어써져 있다. 이 도구는 같은 코어를 **쓰지 않고** 돌려 디스크의 현재 산출물과 비교한다.

| 인자 | 필수 | 뜻 |
| --- | --- | --- |
| `snapshot` | ✓ | 스냅샷 JSON 경로. vendored 스냅샷이거나 플러그인이 남긴 캐시(`--cache`) |
| `outDir` | ✓ | bake 산출물 디렉토리 — `rynl10n-bake`에 넘기는 out-dir와 같은 값 |
| `platform` | | `ios`·`android`. 빌드가 `--emit-native`로 돌 때만. 생략하면 번들·lockfile만 |
| `descriptions` | | 키 설명 사이드카 경로. 빌드가 `--descriptions`를 쓸 때만 (아래) |
| `strict` | | 커버리지 갭·base 불일치에서 실패(빌드의 `--strict`와 같은 판정) |
| `stableName` | | 빌드가 `--stable-name`으로 돌면 true |

돌려주는 것: 릴리스·base·키 수·로케일 · 파일별 `추가`/`변경`/`동일` · 직전 lockfile과 다음
lockfile · **카탈로그 diff**(로케일별 set/delete + 예시 20건) · 커버리지 갭·base 무결성 경고.

**판정을 새로 쓰지 않는다.** 커버리지 갭·base 무결성은 `bake()`가, 카탈로그 diff는 `buildDelta()`가,
네이티브 산출물은 `convert`가 낸다. 여기서 다시 구현하면 미리보기와 실제 빌드가 갈라지는 순간
도구가 거짓말을 시작한다(HTTP 표면의 `resolve_preview`와 같은 규칙).

### `lockfile_status` — 지금 무엇이 구워져 있고, 앱이 그걸 집는가 (쓰기 없음)

`bake_preview`가 **다음** 빌드를 보는 도구라면 이건 **지금** 상태를 보는 도구다. lockfile은 빌드가
의도한 릴리스·base의 유일한 기록이고(런타임은 안 읽는다 — 스냅샷 자신이 들고 있다), "의도한 것"과
"디스크에 있는 것"이 어긋났는지 볼 자리도 여기뿐이다. 인자는 `outDir` 하나.

**핵심은 SDK가 어느 파일을 집느냐다.** `--stable-name` 없이 구우면 `snapshot-<base>.json`이 빌드마다
**쌓이고**, 그때 로더는:

- Android `BakedBundle.locate` — `minByOrNull { it.name }`, **파일명 최소값**이지 최신이 아니다.
- iOS `Snapshot.bakedURL` — `bundle.urls(...)`의 `first(where:)`라 **순서가 보장되지 않는다.**

둘 다 조용하다. 앱은 스테일 카탈로그를 들고 멀쩡히 돌고 개발자는 왜 새 번역이 안 보이는지 모른다.
"새 번역이 왜 안 보이지"를 묻는 자리에 먼저 쓴다.

진단 코드 9종은 코드의 조기 반환 지점과 1:1이다 — `ok` · `lockfile_missing` ·
`lockfile_unreadable` · `bundle_missing` · `base_mismatch` · `base_integrity_failed` ·
`stale_candidates` · **`loads_stale_bundle`**(lockfile이 가리키는 번들이 옆에 있는데 로더가 안 집는
경우) · `ios_load_order_undefined`. 각 코드마다 그 원인을 실제로 만들어 대조하는 테스트가 있다.

## 알아 둘 것 셋

**① 경로 규약은 bake CLI·SDK 로더를 그대로 따른다.** 어긋나면 "변경 없음"이라 답해 놓고 빌드가
다른 파일을 덮어쓰거나, "앱이 이걸 집는다"고 답한 파일과 앱이 실제로 집는 파일이 달라진다 —
진단 도구가 낼 수 있는 최악의 오답이다.

```
<outDir>/rynl10n/snapshot-<base>.json            (--stable-name이면 snapshot.json)
<outDir>/rynl10n/rynl10n.lock
<outDir>/rynl10n/Localizable.xcstrings           (ios, --emit-native)
<outDir>/rynl10n/res/values[-<locale>]/strings.xml  (android, --emit-native)
```

**② `.xcstrings`는 바이트가 아니라 의미로 비교한다.** iOS bake CLI는 Foundation
`JSONEncoder(.prettyPrinted, .sortedKeys)`로 쓰는데 그 출력은 `"key" : value`(콜론 앞 공백)라
Node의 `JSON.stringify`와 **바이트가 절대 같아지지 않는다.** 바이트로 비교하면 내용이 똑같아도
매번 "변경"이라 답한다. Foundation 포맷을 흉내내는 건 더 나쁜 길이라 파싱해서 비교한다.
`strings.xml`은 굽는 쪽이 우리 생성기의 문자열을 그대로 쓰므로 바이트로 비교한다.

**③ `descriptions`는 빌드가 쓸 때만 준다.** 두 CLI 모두 `--descriptions`로 키 설명 주석을 굽지만
(iOS `.xcstrings` `comment` · Android `strings.xml` XML 주석), **빌드가 그 플래그 없이 돈다면
미리보기도 주면 안 된다** — 그 차이가 그대로 가짜 "변경"이 된다. 미리보기는 언제나 CLI의 실제
호출을 따라간다.

## 전송

**개행 구분 JSON**(MCP stdio). 한 줄이 메시지 하나이므로 청크가 줄 중간에서 끊길 수 있어 버퍼에
모아 개행에서만 자른다. **로그는 전부 stderr로 간다** — stdout에 한 줄이라도 섞이면 클라이언트의
프레임 해석이 깨진다.

프로토콜 구현은 관리 플레인과 **공유하지 않는다**. 그쪽 디스패처는 `McpDeps{repo, store}`·
`Principal`·`authorize`에 묶여 있고 여기는 DB도 인증도 없다. 대신 **갈리면 안 되는 결정**을
`test/protocol.test.ts`가 두 서버에서 함께 읽어 대조한다 — 프로토콜 리비전 협상 · 알 수 없는
도구는 JSON-RPC 에러 · **도구 실행 실패는 `isError` 결과**(프로토콜 에러로 올리면 대화가 끊긴다).
구현을 합치는 대신 계약을 고정하는 쪽이다.

## 게시

**아직 게시하지 않는다.** `private: true`이고 좌표(`@rynl10n/mcp`)만 잡아 뒀다. 게시하려면 Web
SDK와 같은 문제를 풀어야 한다 — 이 서버는 `../src/builder`를 상대경로로 부르므로 소스 배포가
성립하지 않고(`node_modules` 타입 스트리핑 거부·`node:crypto`), `prepack`의 `tsc` 빌드 산출물로
나가야 한다. 버전선은 SDK 4채널 lockstep과 **분리**한다 — 개발 도구지 SDK가 아니다.

## 테스트

```bash
npm run test:mcp-stdio       # 37개
npm run typecheck:mcp-stdio
```

- `bake-preview.test.ts` — 경로 규약이 CLI와 같은가 · **아무것도 쓰지 않는가**(미리보기 전후
  바이트 대조) · 판정을 코어에서 가져오는가 · `.xcstrings` 의미 비교 · 첫 빌드에서 카탈로그
  diff를 부풀리지 않는가.
- `lockfile-status.test.ts` — 진단 코드마다 그 원인을 실제로 만들어 대조 · **탐색 순서가 SDK
  로더와 같은가**(stable-name 우선 · 내용해시는 파일명 최소값 · `rynl10n/` 다음 루트).
- `protocol.test.ts` — 프레이밍 + **관리 플레인과의 대조**.
- `stdio.test.ts` — 실제 프로세스 왕복. 개행 프레이밍 · stdout 오염 없음 · 청크가 줄 중간에서
  끊겨도 살아남는가 · 깨진 JSON 뒤에도 서버가 사는가.
