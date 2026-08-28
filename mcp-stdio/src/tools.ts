/**
 * 이 서버가 내놓는 도구 표.
 *
 * 관리 플레인의 `MCP_TOOLS`와 **다른 축이다**: 저쪽은 카탈로그(DB)를 보고, 여기는 이 저장소의
 * 파일을 본다. 경계를 이렇게 긋는 이유는 stdio가 관리 API에 쓰기를 시작하면 HTTP 서버 일을
 * 대신하게 되고 인증 축이 하나 더 생기기 때문이다. 에이전트가 둘 다 붙여 두면 워크플로가
 * 이어진다 — 여기서 "빌드에 무엇이 구워지나"를 보고, 저기서 카탈로그를 고친다.
 */
import type { StdioTool } from "./protocol.ts";
import { bakePreview, summarize as summarizeBake, type Platform } from "./tools/bake-preview.ts";
import { lockfileStatus, summarize as summarizeLockfile } from "./tools/lockfile-status.ts";

export const SERVER_INFO = { name: "rynl10n-stdio", version: "0.0.0" } as const;

export const TOOLS: readonly StdioTool[] = [
  {
    name: "bake_preview",
    title: "빌드 산출물 미리보기(쓰기 없음)",
    description:
      "다음 빌드가 구울 번들·lockfile·네이티브 산출물을 계산해 **디스크의 현재 산출물과 비교한다. 아무것도 쓰지 않는다.** " +
      "빌드 플러그인이 굽는 것과 같은 코어를 돌리므로 결과가 실제 빌드와 갈라지지 않는다. " +
      "카탈로그 수준으로 무엇이 바뀌는지(로케일별 set/delete)와 기본 로케일 커버리지 갭·base 무결성 경고도 함께 돌려준다. " +
      "빌드를 돌리기 전에 '이 변경이 앱에 무엇을 넣는가'를 묻는 자리에 쓴다.",
    inputSchema: {
      type: "object",
      required: ["snapshot", "outDir"],
      properties: {
        snapshot: {
          type: "string",
          description: "스냅샷 JSON 경로. vendored 스냅샷이거나 빌드 플러그인이 남긴 캐시 파일(`--cache`).",
        },
        outDir: {
          type: "string",
          description: "bake 산출물 디렉토리 — `rynl10n-bake`에 넘기는 out-dir와 같은 값. 산출물은 그 아래 `rynl10n/`에 놓인다.",
        },
        platform: {
          type: "string",
          enum: ["ios", "android"],
          description:
            "네이티브 산출물까지 비교할 플랫폼(빌드가 `--emit-native`로 도는 경우). 생략하면 번들·lockfile만 본다. " +
            "Web·Flutter는 bake CLI가 네이티브를 방출하지 않아(번들 JSON만) 해당 값이 없다.",
        },
        descriptions: {
          type: "string",
          description:
            "키 설명 사이드카 경로(선택). **iOS에만 반영된다** — Android bake CLI에는 설명 플래그가 없어 주석 없이 굽는다. " +
            "읽지 못하면 주석 없이 계속한다(bake CLI와 같은 실패 정책).",
        },
        strict: {
          type: "boolean",
          description: "true면 커버리지 갭·base 불일치에서 실패한다(빌드의 --strict와 같은 판정). 기본은 경고만.",
        },
        stableName: {
          type: "boolean",
          description: "빌드가 `--stable-name`으로 돈다면 true. 번들 파일명이 내용해시 대신 `snapshot.json`이 된다.",
        },
      },
    },
    run: (args: any) => {
      const input = {
        snapshot: requireString(args, "snapshot"),
        outDir: requireString(args, "outDir"),
        ...(typeof args.platform === "string" ? { platform: args.platform as Platform } : {}),
        ...(typeof args.descriptions === "string" ? { descriptions: args.descriptions } : {}),
        ...(args.strict === true ? { strict: true } : {}),
        ...(args.stableName === true ? { stableName: true } : {}),
      };
      if (input.platform !== undefined && input.platform !== "ios" && input.platform !== "android") {
        throw new Error(`platform은 "ios" 또는 "android"여야 한다: ${String(args.platform)}`);
      }
      const result = bakePreview(input);
      return { summary: summarizeBake(result), data: result };
    },
  },
  {
    name: "lockfile_status",
    title: "구워진 번들 상태 진단(쓰기 없음)",
    description:
      "지금 이 빌드에 어느 릴리스·base가 구워져 있는지 lockfile로 확인하고, **앱이 실제로 그 번들을 집는지**까지 대조한다. " +
      "`--stable-name` 없이 구우면 `snapshot-<base>.json`이 쌓이는데 그때 Android는 파일명 최소값(최신이 아니다)을, " +
      "iOS는 순서가 보장되지 않는 것을 집는다 — 앱이 스테일 카탈로그를 들고 조용히 돈다. " +
      "'새 번역이 왜 안 보이지'를 묻는 자리에 먼저 쓴다. 다음 빌드가 무엇을 바꿀지는 bake_preview가 본다.",
    inputSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        outDir: {
          type: "string",
          description: "bake 산출물 디렉토리 — `rynl10n-bake`에 넘긴 out-dir(또는 Android의 assets 루트). 그 아래 `rynl10n/`도 함께 본다.",
        },
      },
    },
    run: (args: any) => {
      const result = lockfileStatus({ outDir: requireString(args, "outDir") });
      return { summary: summarizeLockfile(result), data: result };
    },
  },
];

function requireString(args: any, name: string): string {
  const v = args?.[name];
  if (typeof v !== "string" || v === "") throw new Error(`${name}이(가) 필요하다`);
  return v;
}
