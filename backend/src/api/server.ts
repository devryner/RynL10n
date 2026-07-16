/**
 * 관리 API (쓰기 경로) — 기획서 7.1 / 11.2.
 * REST + JSON, 리소스는 데이터 모델 엔티티에 대응. 에러 코드: 422/409/404/403/401/202/207.
 * SDK 런타임은 이 API를 절대 호출하지 않음(플레인 분리) — 배포 산출물만 읽는다.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { publishRelease, rollbackRelease, RangeConflictError, NotFoundError } from "../pipeline/publish.ts";
import { authenticate, authorize, AuthError, type Capability, type TokenRegistry, type Principal } from "../auth/rbac.ts";
import { signature } from "../../../src/core/placeholder.ts";
import { isPluralMap, type TranslationValue, type VersionMatch, type ReleaseState } from "../../../src/core/types.ts";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
class SignatureMismatchError extends HttpError { constructor(m: string) { super(422, m); } }
class BadRequestError extends HttpError { constructor(m: string) { super(400, m); } }

interface Ctx {
  readonly params: Record<string, string>;
  readonly body: any;
  readonly principal: Principal;
  readonly repo: Repo;
  readonly store: ArtifactStore;
}
type Handler = (ctx: Ctx) => { status: number; body?: unknown };

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: string[];
  readonly cap: Capability;
  readonly projectParam: string | undefined;
  readonly handler: Handler;
}

function route(method: string, template: string, cap: Capability, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + template.replace(/:([A-Za-z]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$",
  );
  return { method, pattern, keys, cap, projectParam: template.includes(":p") ? "p" : undefined, handler };
}

// ── 핸들러 헬퍼 ──────────────────────────────────────────────────────────────
function requireValue(body: any): TranslationValue {
  if (typeof body?.value === "string") return body.value;
  if (body?.value && typeof body.value === "object") return body.value as TranslationValue;
  throw new BadRequestError("value(string 또는 복수형 맵) 필요");
}
function requireVersionMatch(vm: any): VersionMatch {
  if (vm?.strategy !== "semver-range" && vm?.strategy !== "exact-label") throw new BadRequestError("versionMatch.strategy 유효하지 않음");
  if (typeof vm.value !== "string") throw new BadRequestError("versionMatch.value 필요");
  return { strategy: vm.strategy, value: vm.value };
}

const routes: Route[] = [
  // 프로젝트 생성 — Admin
  route("POST", "/projects", "admin", ({ body, repo }) => {
    if (!body?.id || !body?.name || !body?.defaultLocale) throw new BadRequestError("id, name, defaultLocale 필요");
    repo.createProject(body.id, body.name, body.defaultLocale, body.locales ?? []);
    return { status: 201, body: { id: body.id, state: "created" } };
  }),

  // 키 upsert — Translator+
  route("PUT", "/projects/:p/keys/:key", "edit_translation", ({ params, body, repo }) => {
    const id = repo.upsertKey(params.p!, params.key!, body?.signature ?? "", !!body?.isPlural);
    return { status: 200, body: { id, name: params.key } };
  }),

  // 번역 편집 — Translator+ (422 서명 불일치)
  route("PUT", "/projects/:p/translations/:key/:locale", "edit_translation", ({ params, body, repo }) => {
    const value = requireValue(body);
    const keyRow = repo.getKeyByName(params.p!, params.key!);
    if (!keyRow) throw new NotFoundError(`key ${params.key}`);
    const sig = signature(value);
    if (keyRow.signature === "") {
      repo.upsertKey(params.p!, params.key!, sig, isPluralMap(value)); // 최초 값이 서명 확정
    } else if (keyRow.signature !== sig) {
      throw new SignatureMismatchError(`플레이스홀더 서명 불일치: 기대 "${keyRow.signature}" 실제 "${sig}"`);
    }
    const state = body?.state ?? "draft";
    repo.putTranslation(params.p!, keyRow.id, params.locale!, value, state);
    const t = repo.getTranslation(keyRow.id, params.locale!)!;
    return { status: 200, body: { key: params.key, locale: params.locale, value: t.value, state: t.state, updatedAt: t.updatedAt } };
  }),

  // 릴리스 생성 — Maintainer+
  route("POST", "/projects/:p/releases", "manage_release", ({ params, body, repo }) => {
    if (!body?.name) throw new BadRequestError("name 필요");
    const vm = requireVersionMatch(body.versionMatch);
    const id = body.id ?? `R${repo.nextSeq(params.p!)}`;
    repo.createRelease(params.p!, id, body.name, vm, "draft");
    for (const name of body.keys ?? []) {
      const k = repo.getKeyByName(params.p!, name);
      if (k) repo.addReleaseKey(params.p!, id, k.id);
    }
    return { status: 201, body: { id, state: "draft" } };
  }),

  // 릴리스에 키 추가 — Maintainer+
  route("POST", "/projects/:p/releases/:r/keys", "manage_release", ({ params, body, repo }) => {
    if (!repo.getRelease(params.p!, params.r!)) throw new NotFoundError(`release ${params.r}`);
    const added: string[] = [];
    for (const name of body?.keys ?? []) {
      const k = repo.getKeyByName(params.p!, name);
      if (k) { repo.addReleaseKey(params.p!, params.r!, k.id); added.push(name); }
    }
    return { status: 200, body: { added } };
  }),

  // publish — Maintainer+ (202 잡 / 409 충돌)
  route("POST", "/projects/:p/releases/:r/publish", "manage_release", ({ params, repo, store, principal }) => {
    const jobId = randomUUID();
    repo.createJob(jobId, params.p!, "publish");
    try {
      const result = publishRelease(repo, store, params.p!, params.r!, principal.actor);
      repo.finishJob(jobId, "done", { base: result.base, overlay: result.overlay });
      return { status: 202, body: { jobId } };
    } catch (e) {
      repo.finishJob(jobId, "failed", { error: (e as Error).message });
      throw e;
    }
  }),

  // 릴리스 상태·범위 변경 — Maintainer+
  route("PATCH", "/projects/:p/releases/:r", "manage_release", ({ params, body, repo }) => {
    if (!repo.getRelease(params.p!, params.r!)) throw new NotFoundError(`release ${params.r}`);
    if (body?.state) repo.updateReleaseState(params.p!, params.r!, body.state as ReleaseState);
    if (body?.versionMatch) repo.updateReleaseVersionMatch(params.p!, params.r!, requireVersionMatch(body.versionMatch));
    return { status: 200, body: repo.getRelease(params.p!, params.r!) };
  }),

  // 롤백 — Maintainer+ (8.3)
  route("POST", "/projects/:p/releases/:r/rollback", "manage_release", ({ params, body, repo, store, principal }) => {
    if (!body?.to) throw new BadRequestError("to(이전 overlay target) 필요");
    rollbackRelease(repo, store, params.p!, params.r!, body.to, principal.actor);
    return { status: 200, body: { ok: true, to: body.to } };
  }),

  // 백포트 — Maintainer+ (200/207)
  route("POST", "/projects/:p/translations/:key/backport", "manage_release", ({ params, body, repo }) => {
    const key = repo.getKeyByName(params.p!, params.key!);
    if (!key) throw new NotFoundError(`key ${params.key}`);
    const releaseIds: string[] = body?.releaseIds ?? [];
    const applied: string[] = []; const failed: string[] = [];
    for (const rid of releaseIds) {
      if (repo.getRelease(params.p!, rid)) { repo.addReleaseKey(params.p!, rid, key.id); applied.push(rid); }
      else failed.push(rid);
    }
    return { status: failed.length ? 207 : 200, body: { applied, failed } };
  }),

  // 잡 조회 — Viewer+
  route("GET", "/projects/:p/jobs/:jobId", "read", ({ params, repo }) => {
    const job = repo.getJob(params.jobId!);
    if (!job) throw new NotFoundError(`job ${params.jobId}`);
    return { status: 200, body: job };
  }),

  // 릴리스 목록 — Viewer+
  route("GET", "/projects/:p/releases", "read", ({ params, repo }) => {
    return { status: 200, body: { releases: repo.listReleases(params.p!) } };
  }),

  // 배포 manifest 조회(진단용 read-through) — Viewer+
  route("GET", "/projects/:p/manifest", "read", ({ params, store }) => {
    const m = store.readManifest(params.p!);
    if (!m) throw new NotFoundError(`manifest ${params.p}`);
    return { status: 200, body: m };
  }),
];

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new BadRequestError("JSON 파싱 실패"); }
}

export interface ServerDeps {
  readonly repo: Repo;
  readonly store: ArtifactStore;
  readonly tokens: TokenRegistry;
}

/** node:http 서버 생성. 프레임워크 의존성 없음. */
export function createManagementServer(deps: ServerDeps) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body ?? null);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!match) return send(404, { error: { code: "not_found", message: `${req.method} ${path}` } });

      const m = match.pattern.exec(path)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });

      const principal = authenticate(deps.tokens, req.headers.authorization);
      authorize(principal, match.cap, match.projectParam ? params[match.projectParam] : undefined);

      const body = req.method === "GET" ? {} : await readBody(req);
      const result = match.handler({ params, body, principal, repo: deps.repo, store: deps.store });
      send(result.status, result.body ?? null);
    } catch (e) {
      const err = e as { status?: number; message?: string; name?: string };
      const status = typeof err.status === "number" ? err.status : 500;
      const code = err.name === "AuthError" ? (status === 401 ? "unauthorized" : "forbidden")
        : err instanceof RangeConflictError ? "range_conflict"
        : status === 422 ? "signature_mismatch"
        : status === 404 ? "not_found"
        : status === 400 ? "bad_request" : "internal";
      send(status, { error: { code, message: err.message ?? "error" } });
    }
  });
}

export { HttpError };
