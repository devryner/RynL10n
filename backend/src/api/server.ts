/**
 * 관리 API (쓰기 경로) — 기획서 7.1 / 11.2.
 * REST + JSON, 리소스는 데이터 모델 엔티티에 대응. 에러 코드: 422/409/404/403/401/202/207.
 * SDK 런타임은 이 API를 절대 호출하지 않음(플레인 분리) — 배포 산출물만 읽는다.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { publishRelease, rollbackRelease, RangeConflictError, NotFoundError } from "../pipeline/publish.ts";
import { buildDelta, buildSnapshot } from "../../../src/builder/builder.ts";
import { authenticate, authorize, AuthError, tokenHash, ROLES, SURFACES, type Capability, type PrincipalResolver, type Principal, type Role, type Surface } from "../auth/rbac.ts";
import { signature } from "../../../src/core/placeholder.ts";
import { parseRange } from "../../../src/core/semver.ts";
import { parseIntRange } from "../../../src/core/intrange.ts";
import { isPluralMap, type TranslationValue, type VersionMatch, type ReleaseState } from "../../../src/core/types.ts";
import { Metrics, METRIC } from "../observability/metrics.ts";
import { Notifier } from "../observability/notifier.ts";
import { ingest, releaseHealth } from "../observability/telemetry.ts";
import { rebuildAllArtifacts } from "../admin/rebuild.ts";
import type { ProjectExport } from "../db/repo.ts";
import { uiAsset } from "../ui/serve.ts";
import { handleMcpMessage, listMcpTools } from "../mcp/server.ts";

import { HttpError, SignatureMismatchError, BadRequestError, ConflictError } from "./errors.ts";
import { requireTranslationImport } from "./translation-import.ts";

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
  /** MCP 표면의 노출 여부와 Origin 정책 — 대시보드 안내 화면이 읽는다. */
  readonly mcp: { readonly enabled: boolean; readonly allowedOrigins: readonly string[] };
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
/** 버전 매칭 전략 3종(4.3) — 값 문법이 전략마다 다르므로 파서도 함께 고른다. */
const VERSION_MATCH_STRATEGIES: Record<string, ((v: string) => unknown) | null> = {
  "semver-range": parseRange,
  "integer-range": parseIntRange,
  "exact-label": null, // 라벨은 자유 문자열 — 파싱할 문법이 없다.
};

/**
 * 버전 매칭 규칙 검증.
 *
 * **값이 실제로 파싱되는지까지 본다.** 전략만 보고 통과시키면 파싱 불가한 범위식이 draft로
 * 저장됐다가 publish 시점에 파서가 던져 500 `internal`이 된다 — 그 릴리스는 영영 게시할 수
 * 없는데 사용자는 자기 입력이 문제라는 걸 알 방법이 없다. 고칠 수 있는 사람에게, 고칠 수 있는
 * 시점에(=입력한 자리에서) 400으로 돌려준다.
 */
function requireVersionMatch(vm: any): VersionMatch {
  const parse = Object.prototype.hasOwnProperty.call(VERSION_MATCH_STRATEGIES, vm?.strategy)
    ? VERSION_MATCH_STRATEGIES[vm.strategy]
    : undefined;
  if (parse === undefined) {
    throw new BadRequestError(`versionMatch.strategy는 ${Object.keys(VERSION_MATCH_STRATEGIES).join(" · ")} 중 하나`);
  }
  if (typeof vm.value !== "string") throw new BadRequestError("versionMatch.value 필요");
  if (parse !== null) {
    try { parse(vm.value); } catch (e) {
      throw new BadRequestError(`versionMatch.value가 ${vm.strategy} 문법이 아닙니다: ${(e as Error).message}`);
    }
  }
  return { strategy: vm.strategy, value: vm.value };
}
/** 릴리스 상태 4종(4.3 라이프사이클) — import 본문 검증용 런타임 목록. */
const RELEASE_STATES: readonly string[] = ["draft", "published", "superseded", "archived"];

/** 사용자 role 검증(7.3) — rbac.ROLES가 단일 원천. */
function requireRole(v: unknown): Role {
  if (!(ROLES as readonly unknown[]).includes(v)) throw new BadRequestError(`role은 ${ROLES.join(" · ")} 중 하나`);
  return v as Role;
}

/** 토큰 표면 검증(7.3) — 'all' | 'mcp'. */
function requireSurface(v: unknown): Surface {
  if (!(SURFACES as readonly unknown[]).includes(v)) throw new BadRequestError(`surface는 ${SURFACES.join(" · ")} 중 하나`);
  return v as Surface;
}

/**
 * 프로젝트 스코프 검증 — '*'(전체) 또는 프로젝트 id 배열.
 * 존재하는 프로젝트인지는 **일부러 보지 않는다**: 프로젝트를 만들기 전에 CI 토큰부터 준비하는
 * 흐름(스코프 선지정)이 실제로 있고, 스코프는 어차피 매 요청 authorize에서 판정된다.
 */
function requireProjectScope(v: unknown): "*" | string[] {
  if (v === undefined || v === "*") return "*";
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "")) {
    return v.map((x: string) => x.trim());
  }
  throw new BadRequestError("projects는 '*' 또는 비지 않은 프로젝트 id 배열");
}

/** 스냅샷 안의 번역 엔트리 수. 키 하나가 로케일 둘에 있으면 배포 변경도 둘이므로 2로 센다. */
function snapshotEntryCount(locales: Record<string, Record<string, TranslationValue>>): number {
  return Object.values(locales).reduce((sum, catalog) => sum + Object.keys(catalog).length, 0);
}

type ReleaseChangeType = "added" | "changed" | "deleted";
interface ReleaseChange {
  readonly type: ReleaseChangeType;
  readonly key: string;
  readonly locale: string;
  readonly before?: TranslationValue;
  readonly after?: TranslationValue;
}

/**
 * publish 직전 현재 DB 카탈로그와 현장에 걸린 마지막 불변 스냅샷을 비교한다.
 * 판정은 publish가 쓰는 `buildSnapshot`·`buildDelta`를 그대로 재사용한다 — UI용 diff를 따로
 * 구현하면 미리보기와 실제 delta가 갈리는 순간이 생긴다.
 *
 * 처음 게시하는 신규 릴리스는 같은 매칭 전략의 직전 릴리스(생성 seq 기준)를 기준으로 삼는다.
 * 같은 릴리스를 재게시할 때는 rollback까지 반영된 현재 overlay가 기준이다.
 */
function releaseChanges(repo: Repo, store: ArtifactStore, projectId: string, releaseId: string): unknown {
  const project = repo.getProject(projectId);
  if (!project) throw new NotFoundError(`project ${projectId}`);
  const release = repo.getRelease(projectId, releaseId);
  if (!release) throw new NotFoundError(`release ${releaseId}`);

  const target = buildSnapshot({
    release: releaseId,
    defaultLocale: project.defaultLocale,
    locales: repo.catalogForRelease(projectId, releaseId),
  });
  const previous = release.overlay
    ? release
    : repo.listReleases(projectId)
      .filter((candidate) =>
        candidate.seq < release.seq && candidate.overlay &&
        candidate.versionMatch.strategy === release.versionMatch.strategy)
      .at(-1);
  const baseline = previous?.overlay
    ? store.readSnapshot(projectId, previous.id, previous.overlay)
    : undefined;
  if (previous?.overlay && !baseline) {
    throw new NotFoundError(`snapshot ${previous.id}/${previous.overlay}`);
  }

  // 첫 릴리스도 현재 엔트리를 모두 "추가"로 보여 준다. 이 임시 스냅샷은 비교 입력일 뿐 저장되지 않는다.
  const empty = {
    schemaVersion: 1 as const,
    release: releaseId,
    base: "unpublished",
    defaultLocale: project.defaultLocale,
    locales: {},
  };
  const delta = buildDelta(baseline ?? empty, target);
  const changes: ReleaseChange[] = delta.ops.map((op) => {
    const before = baseline?.locales[op.locale]?.[op.key];
    if (op.op === "delete") {
      return { type: "deleted", key: op.key, locale: op.locale, before: before! };
    }
    return {
      type: before === undefined ? "added" : "changed",
      key: op.key,
      locale: op.locale,
      ...(before === undefined ? {} : { before }),
      after: op.value,
    };
  });
  const summary: Record<ReleaseChangeType, number> & { total: number } = {
    added: 0, changed: 0, deleted: 0, total: changes.length,
  };
  for (const change of changes) summary[change.type] += 1;

  return {
    releaseId,
    baseline: baseline && previous
      ? { releaseId: previous.id, hash: baseline.base, entries: snapshotEntryCount(baseline.locales) }
      : null,
    target: { releaseId, hash: target.base, entries: snapshotEntryCount(target.locales) },
    summary,
    changes,
  };
}

/** 사용자 관리는 인스턴스 수준이라 audit_log의 project_id 자리에 이 마커를 쓴다. */
const INSTANCE_SCOPE = "*";

/**
 * import 본문이 export 산출물인지 확인한다(9.2).
 *
 * 검사 범위는 `Repo.importProject`가 **실제로 역참조하는 필드 전부**다 — 존재만이 아니라
 * 타입까지 본다. node:sqlite는 문자열·숫자·null 외의 값을 바인딩하면 TypeError를 던지므로,
 * 여기서 걸러내지 않으면 엉뚱한 JSON이 그대로 500 `internal`로 새어 나가 사용자는 원인을
 * 알 수 없다 — 잘못된 파일은 사용자가 고칠 수 있는 오류이므로 400이어야 한다.
 * (importProject의 트랜잭션은 그런 경우에도 상태를 되돌리지만, 상태가 깨끗한 것과
 *  사용자가 무엇을 고쳐야 하는지 아는 것은 다른 문제다.)
 */
function requireProjectExport(body: any): ProjectExport {
  const bad = (m: string) => { throw new BadRequestError(`export 형식이 아닙니다: ${m}`); };
  /** 값이 있는 문자열. SQLite 바인딩은 문자열·숫자·null만 받으므로 타입까지 봐야 500을 막는다. */
  const str = (v: unknown) => typeof v === "string" && v !== "";
  /** 있으면 문자열, 없으면(undefined·null) 통과 — 구 export의 결측 필드를 허용하는 자리. */
  const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";

  const p = body?.project;
  if (!str(p?.id) || !str(p?.name) || !str(p?.defaultLocale)) bad("project.id · project.name · project.defaultLocale 필요(문자열)");
  for (const f of ["locales", "keys", "releases"] as const) {
    if (!Array.isArray(body[f])) bad(`${f} 배열 필요`);
  }
  for (const l of body.locales) {
    if (!str(l?.tag)) bad("locales[].tag 필요");
    if (!optStr(l.fallbackParent)) bad(`locales[${l.tag}].fallbackParent는 문자열이거나 null`);
  }
  for (const k of body.keys) {
    if (!str(k?.name)) bad("keys[].name 필요");
    // signature는 빈 문자열이 정상이다(플레이스홀더 없는 키) — 존재가 아니라 타입만 본다.
    if (typeof k.signature !== "string") bad(`keys[${k.name}].signature 필요(문자열)`);
    if (!optStr(k.description)) bad(`keys[${k.name}].description은 문자열`);
    if (!Array.isArray(k.translations)) bad(`keys[${k.name}].translations 배열 필요`);
    for (const t of k.translations) {
      if (!str(t?.locale)) bad(`keys[${k.name}].translations[].locale 필요`);
      if (typeof t.value !== "string" && (t.value === null || typeof t.value !== "object")) {
        bad(`keys[${k.name}].translations[${t.locale}].value 필요(string 또는 복수형 맵)`);
      }
      if (!str(t.state)) bad(`keys[${k.name}].translations[${t.locale}].state 필요`);
    }
  }
  // 릴리스의 키 참조는 이름 기반이라(id 비의존) keys[]에 없는 이름은 조용히 버려진다 —
  // 복원이 말없이 반쪽이 되는 것보다 파일을 거절하는 편이 낫다(조용한 손실 금지).
  const keyNames = new Set(body.keys.map((k: any) => k.name));
  for (const r of body.releases) {
    if (!str(r?.id) || !str(r.name)) bad("releases[].id · releases[].name 필요");
    requireVersionMatch(r.versionMatch);
    if (!RELEASE_STATES.includes(r.state)) bad(`releases[${r.id}].state는 ${RELEASE_STATES.join("·")} 중 하나`);
    if (!optStr(r.base) || !optStr(r.overlay)) bad(`releases[${r.id}].base · overlay는 문자열이거나 null`);
    if (r.rollout !== undefined && !(Number.isInteger(r.rollout) && r.rollout >= 0 && r.rollout <= 100)) {
      bad(`releases[${r.id}].rollout은 0~100 정수`);
    }
    if (!Array.isArray(r.keys)) bad(`releases[${r.id}].keys 배열 필요`);
    for (const name of r.keys) {
      if (!str(name)) bad(`releases[${r.id}].keys[]는 키 이름(문자열)`);
      if (!keyNames.has(name)) bad(`releases[${r.id}].keys의 "${name}"가 keys[]에 없습니다`);
    }
  }
  return body as ProjectExport;
}


const routes: Route[] = [
  // 세션 확인 — 대시보드 로그인 검증 + 배포 플레인 주소 전달. 모든 역할(read).
  route("GET", "/me", "read", ({ principal, deliveryBaseUrl, mcp }) => {
    return {
      status: 200,
      body: {
        actor: principal!.actor,
        role: principal!.role,
        projects: principal!.projects === "*" ? "*" : [...principal!.projects],
        deliveryBaseUrl,
        // MCP 표면의 존재·정책. 대시보드가 "켜져 있는지"부터 모르면 아무도 세팅하지 않는다.
        // 허용 Origin은 비밀이 아니라 정책이라 read로 열어 둔다(배포 플레인 주소와 같은 성격).
        mcp: { enabled: mcp.enabled, allowedOrigins: [...mcp.allowedOrigins] },
      },
    };
  }),

  /**
   * MCP 도구 목록 — **관리 API 라우트지 JSON-RPC 전송이 아니다.** 대시보드가 쓰는 자리다.
   *
   * 대시보드가 `POST /mcp`를 직접 부르지 못하기 때문에 필요하다: 브라우저 요청에는 Origin이
   * 붙고, MCP Origin 가드의 안전 기본값은 "Origin 붙은 요청 전부 거부"다. 목록을 UI에 하드코딩하면
   * 서버와 어긋나므로, 같은 `MCP_TOOLS` 배열을 관리 API 쪽으로도 한 번 더 내보낸다.
   * 권한 필터도 `tools/list`와 같아서 보이는 것이 곧 쓸 수 있는 것이다.
   */
  route("GET", "/mcp/tools", "read", ({ principal }) => {
    return { status: 200, body: { tools: listMcpTools(principal!) } };
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

  // 프로젝트 삭제 — Admin. 되돌릴 수 없다(DB + 산출물).
  //
  // published 릴리스가 하나라도 있으면 409로 막는다. 산출물이 사라지면 현장의 SDK는
  // manifest를 못 받고 구운 번들로 되돌아간다 — 2계층 resolve(3.1) 덕에 앱이 죽지는 않지만
  // 원격 갱신이 조용히 끊긴다. 그 전환은 실수로 일어나면 안 되므로 archive를 먼저 요구한다.
  route("DELETE", "/projects/:p", "admin", ({ params, repo, store, principal }) => {
    const id = params.p!;
    if (!repo.getProject(id)) throw new NotFoundError(`project ${id}`);

    const releases = repo.listReleases(id);
    const published = releases.filter((r) => r.state === "published").map((r) => r.id);
    if (published.length) {
      throw new ConflictError(
        `published 릴리스가 있어 삭제할 수 없습니다: ${published.join(", ")} — 먼저 archive 하세요`,
      );
    }

    const removed = { keys: repo.listKeyDetails(id).length, releases: releases.length, locales: repo.listLocales(id).length };
    // 감사 로그는 프로젝트와 함께 지워지므로, 삭제 사실은 지우기 **전에** 남겨도 사라진다.
    // 삭제 자체의 기록은 구조화 로그(9.3)와 이 응답이 담당한다.
    repo.audit(id, principal!.actor, "project.delete", removed);
    // 산출물을 먼저 지운다 — DB만 지우고 실패하면 배포 플레인이 유령 프로젝트를 계속 서빙한다.
    store.deleteProject(id);
    repo.deleteProject(id);
    return { status: 200, body: { id, deleted: true, removed } };
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
    // 빈 문자열은 값이 아니라 "아직 확정 안 됨" 센티널이다(아래 번역 PUT이 `=== ""`로 그렇게 읽는다).
    // 값으로 받아주면 `{"signature":""}` 한 번으로 확정된 서명이 풀려, 그 다음 번역이 어떤
    // 플레이스홀더든 새 서명으로 확정해버린다 — 위 문단이 막으려던 무력화를 우회하는 경로가 된다.
    const givenSignature = typeof body?.signature === "string" && body.signature !== "" ? body.signature : undefined;
    const signature = givenSignature ?? existing?.signature ?? "";
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

  // 기존 프로젝트에 키·번역 JSON 일괄 upsert — Translator+. 전체 검증 후 단일 트랜잭션 적용.
  route("POST", "/projects/:p/translations/import", "edit_translation", ({ params, body, repo }) => {
    if (!repo.getProject(params.p!)) throw new NotFoundError(`project ${params.p}`);
    const normalized = requireTranslationImport(body, repo, params.p!);
    repo.importTranslations(params.p!, normalized.data);
    return {
      status: 200,
      body: {
        createdKeys: normalized.createdKeys,
        updatedKeys: normalized.updatedKeys,
        translations: normalized.translations,
      },
    };
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

  // 출시 전 변경사항 — 현재 DB 카탈로그와 마지막 게시본(신규 릴리스는 직전 릴리스)을 비교. Viewer+.
  route("GET", "/projects/:p/releases/:r/changes", "read", ({ params, repo, store }) => {
    return { status: 200, body: releaseChanges(repo, store, params.p!, params.r!) };
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

  // 텔레메트리 열람 — Viewer+. 익명 집계 행만 반환하며 원문·키·기기 식별자는 저장·노출하지 않는다.
  route("GET", "/projects/:p/telemetry", "read", ({ params, repo }) => {
    if (!repo.getProject(params.p!)) throw new NotFoundError(`project ${params.p}`);
    return { status: 200, body: { telemetry: repo.listTelemetry(params.p!) } };
  }),

  // 배포 건전성(카나리 8.4 입력) — Viewer+
  route("GET", "/projects/:p/releases/:r/health", "read", ({ params, repo }) => {
    return { status: 200, body: releaseHealth(repo, params.p!, params.r!) };
  }),

  // 데이터 이식성 export(9.2) / 백업(9.4) — Admin
  route("GET", "/projects/:p/export", "admin", ({ params, repo }) => {
    return { status: 200, body: repo.exportProject(params.p!) };
  }),
  /**
   * import — Admin (빈 프로젝트로 복원).
   *
   * 이미 있는 id로 복원하려는 것이 가장 흔한 실수다(백업을 원본 위에 되돌리기). **덮어쓰지 않고
   * 409로 막는다** — import는 병합이 아니라 신규 생성이라, 기존 프로젝트를 조용히 건드리는 쪽이
   * 훨씬 위험하다. 사용자는 `project.id`를 바꿔 복사본으로 복원하거나 기존 것을 먼저 지우면 된다.
   */
  route("POST", "/projects/import", "admin", ({ body, repo }) => {
    const data = requireProjectExport(body);
    if (repo.getProject(data.project.id)) {
      throw new ConflictError(`이미 있는 프로젝트입니다: ${data.project.id} — 다른 ID로 복원하거나 기존 프로젝트를 먼저 삭제하세요`);
    }
    repo.importProject(data);
    return { status: 201, body: { id: data.project.id } };
  }),

  // 산출물 재생성(재해 복구, 9.4) — Maintainer+
  route("POST", "/projects/:p/rebuild", "manage_release", ({ params, repo, store }) => {
    const manifest = rebuildAllArtifacts(repo, store, params.p!);
    return { status: 200, body: { rebuilt: manifest.releases.length } };
  }),

  // ── 사용자 관리(7.3) — 전부 Admin. 사용자는 인스턴스 수준이라 프로젝트 스코프(:p)가 없고,
  //    export/import(9.2)에도 포함되지 않는다. 모든 변경은 audit_log에 남는다.

  // 사용자 목록 — 토큰은 id·label·발급 시각만(해시·평문 미노출).
  route("GET", "/users", "admin", ({ repo }) => {
    return { status: 200, body: { users: repo.listUsers() } };
  }),

  // 사용자 생성 — 중복 id는 409(import와 같은 규칙: 조용한 덮어쓰기 금지).
  route("POST", "/users", "admin", ({ body, repo, principal }) => {
    if (typeof body?.id !== "string" || !body.id.trim()) throw new BadRequestError("id 필요");
    if (typeof body?.name !== "string" || !body.name.trim()) throw new BadRequestError("name 필요");
    const id = body.id.trim();
    const role = requireRole(body.role);
    const projects = requireProjectScope(body.projects);
    if (repo.getUser(id)) throw new ConflictError(`이미 있는 사용자입니다: ${id}`);
    repo.createUser(id, body.name.trim(), role, projects);
    repo.audit(INSTANCE_SCOPE, principal!.actor, "user.create", { id, role, projects });
    return { status: 201, body: repo.getUser(id) };
  }),

  // 사용자 수정(역할·스코프·비활성·이름) — 마지막 활성 admin의 강등·비활성은 409.
  // 스스로 잠그는 사고를 막는다(부트스트랩 env 토큰은 별도 생존 수단이지만 프로덕션에선 회전 대상이다).
  route("PATCH", "/users/:id", "admin", ({ params, body, repo, principal }) => {
    const user = repo.getUser(params.id!);
    if (!user) throw new NotFoundError(`user ${params.id}`);
    const patch: { name?: string; role?: Role; projects?: "*" | string[]; disabled?: boolean } = {};
    if (body?.role !== undefined) patch.role = requireRole(body.role);
    if (body?.projects !== undefined) patch.projects = requireProjectScope(body.projects);
    if (body?.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") throw new BadRequestError("disabled는 boolean");
      patch.disabled = body.disabled;
    }
    if (body?.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw new BadRequestError("name은 비지 않은 문자열");
      patch.name = body.name.trim();
    }
    const losesAdmin = user.role === "admin" && !user.disabled &&
      ((patch.role !== undefined && patch.role !== "admin") || patch.disabled === true);
    if (losesAdmin && repo.countActiveAdmins() <= 1) {
      throw new ConflictError("마지막 admin은 강등·비활성화할 수 없습니다 — 다른 admin을 먼저 만드세요");
    }
    repo.updateUser(params.id!, patch);
    repo.audit(INSTANCE_SCOPE, principal!.actor, "user.update", { id: params.id, ...patch });
    return { status: 200, body: repo.getUser(params.id!) };
  }),

  // 사용자 삭제 — 토큰은 FK CASCADE로 함께 폐기(즉시 401). 마지막 활성 admin은 409.
  route("DELETE", "/users/:id", "admin", ({ params, repo, principal }) => {
    const user = repo.getUser(params.id!);
    if (!user) throw new NotFoundError(`user ${params.id}`);
    if (user.role === "admin" && !user.disabled && repo.countActiveAdmins() <= 1) {
      throw new ConflictError("마지막 admin은 삭제할 수 없습니다 — 다른 admin을 먼저 만드세요");
    }
    repo.deleteUser(params.id!);
    repo.audit(INSTANCE_SCOPE, principal!.actor, "user.delete", { id: params.id });
    return { status: 200, body: { id: params.id, deleted: true } };
  }),

  // 토큰 발급 — **평문은 이 응답이 유일한 노출**이고 DB에는 sha256 해시만 남는다.
  // 잃어버리면 되찾는 게 아니라 폐기 후 재발급한다(회전이 기본 동작).
  route("POST", "/users/:id/tokens", "admin", ({ params, body, repo, principal }) => {
    if (!repo.getUser(params.id!)) throw new NotFoundError(`user ${params.id}`);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    // 최소 권한(7.3). 값이 있으면 유효해야 한다 — 오타가 조용히 'all'로 넓어지면 안 된다.
    const surface = body?.surface === undefined ? "all" : requireSurface(body.surface);
    const maxRole = body?.maxRole == null || body.maxRole === "" ? null : requireRole(body.maxRole);
    const tokenId = randomUUID();
    const token = `rl10n_${randomBytes(24).toString("base64url")}`;
    repo.addUserToken(params.id!, tokenId, tokenHash(token), label, surface, maxRole);
    repo.audit(INSTANCE_SCOPE, principal!.actor, "user.token.issue", { user: params.id, tokenId, label, surface, maxRole });
    return { status: 201, body: { id: tokenId, token, label, surface, maxRole } };
  }),

  // 토큰 폐기 — DB 조회 기반 인증이라 폐기 즉시 401(세션 캐시 없음).
  route("DELETE", "/users/:id/tokens/:tokenId", "admin", ({ params, repo, principal }) => {
    if (!repo.deleteUserToken(params.id!, params.tokenId!)) throw new NotFoundError(`token ${params.tokenId}`);
    repo.audit(INSTANCE_SCOPE, principal!.actor, "user.token.revoke", { user: params.id, tokenId: params.tokenId });
    return { status: 200, body: { id: params.tokenId, revoked: true } };
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
  /** 토큰 해석기 — 인메모리 TokenRegistry 또는 DB 기반 DbTokenRegistry(사용자 관리 연동). */
  readonly tokens: PrincipalResolver;
  readonly metrics?: Metrics;
  readonly notifier?: Notifier;
  readonly log?: (entry: Record<string, unknown>) => void;
  /** 대시보드에 알려줄 배포 플레인 base URL. 미지정 시 상대 경로 규약(:8788)을 클라이언트가 추정. */
  readonly deliveryBaseUrl?: string;
  /** 대시보드(정적 자산) 서빙 여부. 기본 true — 테스트·헤드리스 배포에서 끌 수 있다. */
  readonly serveDashboard?: boolean;
  /** MCP 도구 표면(`POST /mcp`) 노출 여부. 기본 true — 인증은 관리 API와 같은 Bearer + RBAC. */
  readonly serveMcp?: boolean;
  /** `POST /mcp`가 받아들일 브라우저 Origin 목록. 기본 빈 목록 = Origin이 붙은 요청 전부 거부. */
  readonly mcpAllowedOrigins?: readonly string[];
}

/** 구조화 JSON 로그(9.3) 기본 구현. */
function defaultLog(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

/** node:http 요청 핸들러 타입 — 다른 서버에 마운트할 때 쓰는 표면. */
export type ManagementHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * 요청 핸들러 생성 — 서버를 직접 만들지 않으므로 **다른 node:http 서버에 얹을 수 있다**.
 *
 * 관리 플레인 앞에 자체 계층(예: 별도 어드민 앱, 리버스 프록시 대체 라우팅)을 두려는 소비자를 위한
 * 표면이다. 관리 API는 CORS를 내보내지 않으므로(교차 오리진으로 열 이유가 없다) 그런 소비자는
 * 같은 오리진에서 이 핸들러로 위임하게 된다. 프레임워크 의존성 없음. metrics/log 주입 가능.
 */
export function createManagementHandler(deps: ServerDeps): ManagementHandler {
  const metrics = deps.metrics ?? new Metrics();
  const notifier = deps.notifier ?? new Notifier();
  const log = deps.log ?? defaultLog;
  const deliveryBaseUrl = deps.deliveryBaseUrl ?? "";
  const serveDashboard = deps.serveDashboard ?? true;
  const serveMcp = deps.serveMcp ?? true;
  const mcpAllowedOrigins = deps.mcpAllowedOrigins ?? [];
  return async (req: IncomingMessage, res: ServerResponse) => {
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

    // MCP 도구 표면(JSON-RPC 2.0 / Streamable HTTP). 라우트 테이블 밖에 두는 이유는
    // 알림에 **본문 없는 202**로 답해야 하고 배치 요청은 배열로 돌려줘야 하기 때문이다 —
    // 둘 다 `{status, body}` 규약으로는 표현되지 않는다.
    if (serveMcp && path === "/mcp") {
      if (req.method !== "POST") {
        // 서버→클라이언트 스트림(GET)과 세션 종료(DELETE)는 제공하지 않는다 — stateless 표면.
        res.writeHead(405, { "content-type": "application/json", allow: "POST" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "POST만 지원합니다(stateless 전송)" } }));
      }
      try {
        // Origin 가드. MCP 클라이언트는 브라우저가 아니라 Origin을 보내지 않는다 — 그래서
        // Origin이 **붙어 있다는 것 자체가** 브라우저에서 왔다는 뜻이고, 허용 목록에 없으면 끊는다.
        // (DNS rebinding에서는 Host도 공격자 도메인이라 Host 비교로는 못 걸러낸다. 명시 목록이라야 한다.)
        // 지금도 Bearer가 필수라 실제 악용 경로는 막혀 있지만, 방어선이 하나뿐인 상태를 없앤다.
        const origin = req.headers.origin;
        if (typeof origin === "string" && origin !== "" && !mcpAllowedOrigins.includes(origin)) {
          throw new AuthError(403, `허용되지 않은 Origin: ${origin}`);
        }
        const principal = authenticate(deps.tokens, req.headers.authorization);
        const body = await readBody(req);
        const batch = Array.isArray(body);
        const out = (batch ? body : [body])
          .map((m) => handleMcpMessage({ repo: deps.repo, store: deps.store }, principal, m))
          .filter((r) => r !== null);
        if (out.length === 0) { res.writeHead(202).end(); return; } // 알림만 온 경우
        return send(200, batch ? out : out[0]);
      } catch (e) {
        const err = e as { status?: number; message?: string };
        const status = typeof err.status === "number" ? err.status : 500;
        const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "internal";
        return send(status, { error: { code, message: err.message ?? "error" } });
      }
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
        // 표면 제한(7.3): MCP 전용 토큰은 여기까지 오면 안 된다. 토큰 평문이 에이전트 설정
        // 파일에 놓이는 값이라, 새어도 관리 API 전체가 딸려가지 않게 경로 자체를 끊는다.
        if (principal.surface === "mcp") {
          throw new AuthError(403, "MCP 전용 토큰은 POST /mcp 외의 관리 API에 접근할 수 없습니다");
        }
        authorize(principal, match.cap, match.projectParam ? params[match.projectParam] : undefined);
      }

      const body = req.method === "GET" ? {} : await readBody(req);
      const result = match.handler({
        params, body, principal, repo: deps.repo, store: deps.store, metrics, notifier, deliveryBaseUrl,
        mcp: { enabled: serveMcp, allowedOrigins: mcpAllowedOrigins },
      });
      send(result.status, result.body ?? null);
    } catch (e) {
      const err = e as { status?: number; message?: string; name?: string };
      const status = typeof err.status === "number" ? err.status : 500;
      const code = err.name === "AuthError" ? (status === 401 ? "unauthorized" : "forbidden")
        : err instanceof RangeConflictError ? "range_conflict"
        : status === 422 ? "signature_mismatch"
        : status === 409 ? "conflict"
        : status === 404 ? "not_found"
        : status === 400 ? "bad_request" : "internal";
      send(status, { error: { code, message: err.message ?? "error" } });
    }
  };
}

/** node:http 서버 생성. 단일 노드 기동 경로 — 동작은 createManagementHandler와 동일하다. */
export function createManagementServer(deps: ServerDeps) {
  return createServer(createManagementHandler(deps));
}

export { HttpError, Metrics };
