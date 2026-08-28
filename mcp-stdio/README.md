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
| `descriptions` | | 키 설명 사이드카 경로. **iOS만 반영** (아래) |
| `strict` | | 커버리지 갭·base 불일치에서 실패(빌드의 `--strict`와 같은 판정) |
| `stableName` | | 빌드가 `--stable-name`으로 돌면 true |

돌려주는 것: 릴리스·base·키 수·로케일 · 파일별 `추가`/`변경`/`동일` · 직전 lockfile과 다음
lockfile · **카탈로그 diff**(로케일별 set/delete + 예시 20건) · 커버리지 갭·base 무결성 경고.

**판정을 새로 쓰지 않는다.** 커버리지 갭·base 무결성은 `bake()`가, 카탈로그 diff는 `buildDelta()`가,
네이티브 산출물은 `convert`가 낸다. 여기서 다시 구현하면 미리보기와 실제 빌드가 갈라지는 순간
도구가 거짓말을 시작한다(HTTP 표면의 `resolve_preview`와 같은 규칙).

## 알아 둘 것 셋

**① 경로 규약은 bake CLI를 그대로 따른다.** 어긋나면 "변경 없음"이라 답해 놓고 빌드가 다른 파일을
덮어쓴다.

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

**③ `descriptions`는 iOS에만 반영된다.** Android bake CLI(`sdks/android/src/cli/.../BakeCli.kt`)에는
`--descriptions` 플래그 자체가 없어 주석 없이 굽는다. 미리보기가 주석을 넣으면 "변경"이라 답하고
빌드는 안 바꾸므로, **CLI의 실제 동작을 따른다.**

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
npm run test:mcp-stdio       # 27개
npm run typecheck:mcp-stdio
```

- `bake-preview.test.ts` — 경로 규약이 CLI와 같은가 · **아무것도 쓰지 않는가**(미리보기 전후
  바이트 대조) · 판정을 코어에서 가져오는가 · `.xcstrings` 의미 비교 · 첫 빌드에서 카탈로그
  diff를 부풀리지 않는가.
- `protocol.test.ts` — 프레이밍 + **관리 플레인과의 대조**.
- `stdio.test.ts` — 실제 프로세스 왕복. 개행 프레이밍 · stdout 오염 없음 · 청크가 줄 중간에서
  끊겨도 살아남는가 · 깨진 JSON 뒤에도 서버가 사는가.
