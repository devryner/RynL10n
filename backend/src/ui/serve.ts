/**
 * 대시보드(어드민 앱) 정적 자산 서빙 — 기획서 9.2 코어 ③.
 * 관리 플레인에서만 서빙한다(배포 플레인은 산출물 전용, 4.1).
 *
 * 경로는 **고정 허용 목록**이라 사용자 입력이 파일 경로로 흘러갈 수 없다(경로 순회 불가).
 * 빌드 스텝 없음 — 소스 그대로 내려가는 바닐라 HTML/CSS/JS(외부 런타임 의존성 0 원칙 유지).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Asset {
  readonly file: string;
  readonly type: string;
}

const ASSETS: Record<string, Asset> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/ui/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const cache = new Map<string, string>();

/** 허용 목록에 있는 경로면 자산 본문을 돌려준다. 그 외에는 undefined(→ 일반 라우팅으로). */
export function uiAsset(path: string): { body: string; type: string } | undefined {
  const hit = ASSETS[path];
  if (!hit) return undefined;
  let body = cache.get(hit.file);
  if (body === undefined) {
    try {
      body = readFileSync(join(import.meta.dirname, hit.file), "utf8");
    } catch {
      return undefined; // 자산 누락 시 대시보드만 비활성, API는 영향 없음.
    }
    cache.set(hit.file, body);
  }
  return { body, type: hit.type };
}
