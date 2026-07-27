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
import { buildSnapshot } from "../../../src/builder/builder.ts";
import { authenticate, authorize, AuthError, type Capability, type TokenRegistry, type Principal } from "../auth/rbac.ts";
import { signature } from "../../../src/core/placeholder.ts";
import { isPluralMap, type TranslationValue, type VersionMatch, type ReleaseState } from "../../../src/core/types.ts";
import { Metrics, METRIC } from "../observability/metrics.ts";
import { Notifier } from "../observability/notifier.ts";
import { ingest, releaseHealth } from "../observability/telemetry.ts";
import { rebuildAllArtifacts } from "../admin/rebuild.ts";
import type { ProjectExport } from "../db/repo.ts";
import { uiAsset } from "../ui/serve.ts";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
class SignatureMismatchError extends HttpError { constructor(m: string) { super(422, m); } }
class BadRequestError extends HttpError { constructor(m: string) { super(400, m); } }

interface Ctx {
  readonly params: Record<string, string>;
  readonly body: any;
  readonly principal: Principal | null;
  readonly repo: Repo;
  readonly store: ArtifactStore;
  readonly metrics: Metrics;
  readonly notifier: Notifier;
  /** 대시보드가 산출물 링크를 만들 때 쓰는 배포 플레인 base URL(읽기 경로, 4.1). */
  readonly deliveryBaseUrl: string;
}
type Handler = (ctx: Ctx) => { status: number; body?: unknown };

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: string[];
  readonly cap: Capability | "public"; // public: 인증 없음(텔레메트리·메트릭)
  readonly projectParam: string | undefined;
  readonly handler: Handler;
}

function route(method: string, template: string, cap: Capability | "public", handler: Handler): Route {
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
  // 세션 확인 — 대시보드 로그인 검증 + 배포 플레인 주소 전달. 모든 역할(read).
  route("GET", "/me", "read", ({ principal, deliveryBaseUrl }) => {
    return {
      status: 200,
      body: {
        actor: principal!.actor,
        role: principal!.role,
        projects: principal!.projects === "*" ? "*" : [...principal!.projects],
        deliveryBaseUrl,
      },
    };
  }),

  // 프로젝트 생성 — Admin
  route("POST", "/projects", "admin", ({ body, repo }) => {
    if (!body?.id || !body?.name || !body?.defaultLocale) throw new BadRequestError("id, name, defaultLocale 필요");
    repo.createProject(body.id, body.name, body.defaultLocale, body.locales ?? []);
    return { status: 201, body: { id: body.id, state: "created" } };
  }),

  // 프로젝트 목록 — Viewer+. 토큰 스코프 밖 프로젝트는 노출하지 않음(7.3).
  route("GET", "/projects", "read", ({ repo, principal }) => {
    const all = repo.listProjects();
    const scope = principal!.projects;
    return { status: 200, body: { projects: scope === "*" ? all : all.filter((p) => scope.has(p.id)) } };
  }),

  // 프로젝트 상세(로케일 포함) — Viewer+
  route("GET", "/projects/:p", "read", ({ params, repo }) => {
    const project = repo.getProject(params.p!);
    if (!project) throw new NotFoundError(`project ${params.p}`);
    return { status: 200, body: { ...project, locales: repo.listLocales(params.p!) } };
  }),

  // 지원 로케일 추가 — Maintainer+. 미등록 로케일의 번역은 카탈로그에서 제외되므로(5.1) 필수 관리 지점.
  route("POST", "/projects/:p/locales", "manage_release", ({ params, body, repo }) => {
    if (!repo.getProject(params.p!)) throw new NotFoundError(`project ${params.p}`);
    if (typeof body?.tag !== "string" || !body.tag.trim()) throw new BadRequestError("tag(BCP 47) 필요");
    repo.addLocale(params.p!, body.tag.trim(), body?.fallbackParent ?? undefined);
    return { status: 200, body: { locales: repo.listLocales(params.p!) } };
  }),

  // 키 + 로케일별 번역 전체(대시보드 편집 그리드) — Viewer+
  route("GET", "/projects/:p/keys", "read", ({ params, repo }) => {
    if (!repo.getProject(params.p!)) throw new NotFoundError(`project ${params.p}`);
    return { status: 200, body: { keys: repo.listKeyDetails(params.p!) } };
  }),

  // 키 upsert — Translator+. 설명(5.1) 편집도 이 경로.
  route("PUT", "/projects/:p/keys/:key", "edit_translation", ({ params, body, repo }) => {
    const existing = repo.getKeyByName(params.p!, params.key!);
    // 서명·복수형은 **명시적으로 준 경우에만** 갱신한다. 설명만 고치려는 요청이 기존 서명을
    // 지워 포맷 안전 가드(3.1)를 무력화하면 안 된다.
    const signature = typeof body?.signature === "string" ? body.signature : existing?.signature ?? "";
    const isPlural = typeof body?.isPlural === "boolean" ? body.isPlural : existing?.isPlural ?? false;
    const id = repo.upsertKey(params.p!, params.key!, signature, isPlural);
    if (typeof body?.description === "string") repo.setKeyDescription(params.p!, params.key!, body.description);
    const row = repo.getKeyByName(params.p!, params.key!)!;
    return { status: 200, body: { id, name: params.key, signature: row.signature, isPlural: row.isPlural, description: row.description } };
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
  route("POST", "/projects/:p/releases/:r/publish", "manage_release", ({ params, repo, store, principal, metrics, notifier }) => {
    const jobId = randomUUID();
    repo.createJob(jobId, params.p!, "publish");
    const started = performance.now();
    try {
      const result = publishRelease(repo, store, params.p!, params.r!, principal!.actor);
      repo.finishJob(jobId, "done", { base: result.base, overlay: result.overlay });
      metrics.inc(METRIC.publishTotal, { result: "success" });
      metrics.observe(METRIC.publishDuration, (performance.now() - started) / 1000);
      notifier.emit(params.p!); // 실시간 푸시 신호(manifest 변경)
      return { status: 202, body: { jobId } };
    } catch (e) {
      repo.finishJob(jobId, "failed", { error: (e as Error).message });
      metrics.inc(METRIC.publishTotal, { result: e instanceof RangeConflictError ? "conflict" : "error" });
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
  route("POST", "/projects/:p/releases/:r/rollback", "manage_release", ({ params, body, repo, store, principal, notifier }) => {
    if (!body?.to) throw new BadRequestError("to(이전 overlay target) 필요");
    rollbackRelease(repo, store, params.p!, params.r!, body.to, principal!.actor);
    notifier.emit(params.p!); // 실시간 푸시 신호
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

  // 릴리스에 포함된 키 목록 — Viewer+
  route("GET", "/projects/:p/releases/:r/keys", "read", ({ params, repo }) => {
    if (!repo.getRelease(params.p!, params.r!)) throw new NotFoundError(`release ${params.r}`);
    return { status: 200, body: { keys: repo.listReleaseKeys(params.p!, params.r!) } };
  }),

  // published manifest 이력(롤백 대상 선택, 보존 창 8.3) — Viewer+
  route("GET", "/projects/:p/manifests", "read", ({ params, repo }) => {
    const history = repo.listManifestHistory(params.p!).map((h) => ({
      seq: h.seq,
      createdAt: h.createdAt,
      manifest: JSON.parse(h.manifestJson) as unknown,
    }));
    return { status: 200, body: { history } };
  }),

  // 현재 릴리스 스냅샷 조회(빌드 플러그인 fetch, 6.3) — Viewer+/머신 토큰. DB에서 결정적 빌드.
  route("GET", "/projects/:p/releases/:r/snapshot", "read", ({ params, repo }) => {
    const project = repo.getProject(params.p!);
    if (!project) throw new NotFoundError(`project ${params.p}`);
    if (!repo.getRelease(params.p!, params.r!)) throw new NotFoundError(`release ${params.r}`);
    const catalog = repo.catalogForRelease(params.p!, params.r!);
    return { status: 200, body: buildSnapshot({ release: params.r!, defaultLocale: project.defaultLocale, locales: catalog }) };
  }),

  // 릴리스 키들의 번역자용 설명(5.1) — 빌드 플러그인이 네이티브 주석으로 bake할 때 fetch.
  // 런타임 스냅샷과 **분리된 사이드카**다: 설명은 기기로 내려갈 데이터가 아니고,
  // 스냅샷에 넣으면 해시 입력이 바뀌어 골든 벡터 계약이 깨진다(11.1). Viewer+.
  route("GET", "/projects/:p/releases/:r/descriptions", "read", ({ params, repo }) => {
    if (!repo.getRelease(params.p!, params.r!)) throw new NotFoundError(`release ${params.r}`);
    const inRelease = new Set(repo.listReleaseKeys(params.p!, params.r!));
    const descriptions: Record<string, string> = {};
    for (const k of repo.listKeyDetails(params.p!)) {
      if (inRelease.has(k.name) && k.description) descriptions[k.name] = k.description;
    }
    return { status: 200, body: { release: params.r, descriptions } };
  }),

  // 배포 manifest 조회(진단용 read-through) — Viewer+
  route("GET", "/projects/:p/manifest", "read", ({ params, store }) => {
    const m = store.readManifest(params.p!);
    if (!m) throw new NotFoundError(`manifest ${params.p}`);
    return { status: 200, body: m };
  }),

  // 텔레메트리 수집(옵트인·익명·집계, 9.3) — 인증 없음, 엄격 스키마 검증(프라이버시 가드)
  route("POST", "/projects/:p/telemetry", "public", ({ body, repo, metrics }) => {
    const { accepted, rejected } = ingest(repo, metrics, body);
    return { status: 200, body: { accepted, rejected } };
  }),

  // 배포 건전성(카나리 8.4 입력) — Viewer+
  route("GET", "/projects/:p/releases/:r/health", "read", ({ params, repo }) => {
    return { status: 200, body: releaseHealth(repo, params.p!, params.r!) };
  }),

  // 데이터 이식성 export(9.2) / 백업(9.4) — Admin
  route("GET", "/projects/:p/export", "admin", ({ params, repo }) => {
    return { status: 200, body: repo.exportProject(params.p!) };
  }),
  // import — Admin (빈 프로젝트로 복원)
  route("POST", "/projects/import", "admin", ({ body, repo }) => {
    repo.importProject(body as ProjectExport);
    return { status: 201, body: { id: (body as ProjectExport).project.id } };
  }),

  // 산출물 재생성(재해 복구, 9.4) — Maintainer+
  route("POST", "/projects/:p/rebuild", "manage_release", ({ params, repo, store }) => {
    const manifest = rebuildAllArtifacts(repo, store, params.p!);
    return { status: 200, body: { rebuilt: manifest.releases.length } };
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
  readonly metrics?: Metrics;
  readonly notifier?: Notifier;
  readonly log?: (entry: Record<string, unknown>) => void;
  /** 대시보드에 알려줄 배포 플레인 base URL. 미지정 시 상대 경로 규약(:8788)을 클라이언트가 추정. */
  readonly deliveryBaseUrl?: string;
  /** 대시보드(정적 자산) 서빙 여부. 기본 true — 테스트·헤드리스 배포에서 끌 수 있다. */
  readonly serveDashboard?: boolean;
}

/** 구조화 JSON 로그(9.3) 기본 구현. */
function defaultLog(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

/** node:http 서버 생성. 프레임워크 의존성 없음. metrics/log 주입 가능. */
export function createManagementServer(deps: ServerDeps) {
  const metrics = deps.metrics ?? new Metrics();
  const notifier = deps.notifier ?? new Notifier();
  const log = deps.log ?? defaultLog;
  const deliveryBaseUrl = deps.deliveryBaseUrl ?? "";
  const serveDashboard = deps.serveDashboard ?? true;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const send = (status: number, body: unknown, contentType = "application/json") => {
      const payload = contentType === "application/json" ? JSON.stringify(body ?? null) : String(body);
      res.writeHead(status, { "content-type": contentType });
      res.end(payload);
      const durSec = (performance.now() - started) / 1000;
      metrics.inc(METRIC.apiRequests, { method: req.method ?? "?", status });
      metrics.observe(METRIC.apiDuration, durSec);
      if (status >= 500) log({ level: "error", method: req.method, path: req.url, status });
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Prometheus 스크레이프 엔드포인트(인증 없음, text 노출).
    if (req.method === "GET" && path === "/metrics") {
      return send(200, metrics.render(), "text/plain; version=0.0.4");
    }

    // 대시보드(어드민 앱 — 9.2 코어 ③). 관리 플레인에서만 서빙하며 배포 플레인은 정적 산출물 전용으로 유지(4.1).
    // 정적 자산 자체는 비밀이 아니라 인증 없이 내려가고, 모든 데이터 접근은 아래 라우트의 Bearer 토큰을 거친다.
    if (serveDashboard && req.method === "GET") {
      const asset = uiAsset(path);
      if (asset) return send(200, asset.body, asset.type);
    }

    // 실시간 푸시 SSE(옵트인, 인증 없음, manifest 변경 신호만) — M4/8.4.
    const sse = /^\/projects\/([^/]+)\/events$/.exec(path);
    if (req.method === "GET" && sse) {
      const projectId = decodeURIComponent(sse[1]!);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n\n"); // 재연결 힌트
      const unsub = notifier.subscribe(projectId, (seq) => {
        res.write(`event: manifest\ndata: {"seq":${seq}}\n\n`);
      });
      req.on("close", () => unsub());
      return;
    }

    try {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!match) return send(404, { error: { code: "not_found", message: `${req.method} ${path}` } });

      const m = match.pattern.exec(path)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });

      let principal: Principal | null = null;
      if (match.cap !== "public") {
        principal = authenticate(deps.tokens, req.headers.authorization);
        authorize(principal, match.cap, match.projectParam ? params[match.projectParam] : undefined);
      }

      const body = req.method === "GET" ? {} : await readBody(req);
      const result = match.handler({ params, body, principal, repo: deps.repo, store: deps.store, metrics, notifier, deliveryBaseUrl });
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

export { HttpError, Metrics };
