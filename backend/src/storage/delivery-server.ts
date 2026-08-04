/**
 * 배포 플레인 정적 서버 (기획서 4.1 / 7.2 / 11.2) — CDN·오브젝트 스토리지의 stand-in.
 *
 * **읽기 전용이고 애플리케이션 로직이 없다.** 관리 API와 한 프로세스에 살 뿐 코드 경로는 완전히
 * 분리돼 있다(관리 서버가 죽어도 이 경로는 계속 서빙된다).
 *
 * 실제 CDN/S3가 공짜로 주는 두 가지를 참조 서버도 똑같이 준다 — 이게 없으면 SDK의 갱신 경로가
 * 조용히 반쪽이 된다:
 *
 * 1. **ETag + 조건부 요청(304)** — manifest는 짧은 TTL이라 폴링마다 재검증된다. validator가
 *    없으면 `if-none-match`가 성립할 수 없어 매번 전량 재다운로드가 된다.
 * 2. **CORS** — 브라우저 SDK(Web·Flutter Web)는 보통 배포 플레인과 다른 오리진에 있다.
 *    `Access-Control-Allow-Origin`이 없으면 응답 자체가 막히고, **`ETag`는 CORS 안전목록
 *    응답 헤더가 아니라** `Access-Control-Expose-Headers`로 노출하지 않으면 JS가 읽지 못한다
 *    (= 조건부 요청이 영영 성립하지 않는다). `if-none-match` 요청 헤더는 preflight를 유발하므로
 *    `Access-Control-Allow-Headers`에도 들어가야 한다.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

export interface DeliveryServerOptions {
  /** 산출물 루트(프로젝트 디렉토리들의 부모). */
  readonly root: string;
  /**
   * `Access-Control-Allow-Origin` 값. 기본 `*` — 배포 플레인은 **공개 읽기 전용 정적 파일**이라
   * 자격 증명을 쓰지 않는다(쿠키·인증 헤더 없음). 오리진을 좁히려면 명시한다.
   */
  readonly allowOrigin?: string;
}

/** 산출물 바이트의 강한 ETag. 내용해시라 같은 내용 → 같은 검증자(결정성, 11.1과 같은 원리). */
export function etagFor(data: Uint8Array): string {
  return `"${createHash("sha256").update(data).digest("hex").slice(0, 32)}"`;
}

/**
 * 요청 경로를 루트 밖으로 나가지 못하게 정규화한다.
 * pathname은 항상 `/`로 시작하므로 `normalize`가 루트를 넘는 `..`를 흡수한다.
 */
function safeRelativePath(url: string): string {
  const pathname = new URL(url, "http://x").pathname;
  return normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
}

export function createDeliveryServer(opts: DeliveryServerOptions): Server {
  const allowOrigin = opts.allowOrigin ?? "*";
  const cors: Record<string, string> = {
    "access-control-allow-origin": allowOrigin,
    // ETag를 노출하지 않으면 브라우저 SDK의 조건부 요청이 성립하지 않는다.
    "access-control-expose-headers": "ETag",
    "access-control-allow-headers": "If-None-Match",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-max-age": "86400",
  };

  return createServer(async (req, res) => {
    // preflight — `if-none-match`가 안전목록 요청 헤더가 아니라서 브라우저가 먼저 물어본다.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...cors, "content-type": "application/json", allow: "GET, HEAD, OPTIONS" });
      res.end(JSON.stringify({ error: { code: "method_not_allowed", message: req.method ?? "" } }));
      return;
    }

    const rel = safeRelativePath(req.url ?? "/");
    let data: Buffer;
    try {
      data = await readFile(join(opts.root, rel));
    } catch {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: rel } }));
      return;
    }

    const isManifest = rel.endsWith("manifest.json");
    const etag = etagFor(data);
    const headers: Record<string, string> = {
      ...cors,
      "content-type": "application/json",
      etag,
      // manifest는 짧은 TTL, 산출물은 내용해시라 영구 캐싱(4.4/7.2).
      "cache-control": isManifest ? "max-age=30, must-revalidate" : "public, max-age=31536000, immutable",
    };

    // 조건부 요청 — 약한 비교로 충분하다(우리는 강한 ETag만 발행한다).
    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && matchesEtag(ifNoneMatch, etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

/** `If-None-Match`는 `*` 또는 콤마로 나열된 검증자 목록이다(RFC 9110 §13.1.2). */
function matchesEtag(ifNoneMatch: string, etag: string): boolean {
  const candidates = ifNoneMatch.split(",").map((v) => v.trim());
  if (candidates.includes("*")) return true;
  return candidates.some((candidate) => stripWeak(candidate) === stripWeak(etag));
}

function stripWeak(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}
