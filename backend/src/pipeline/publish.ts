/**
 * 산출물 빌더 파이프라인 (7.4) + publish/롤백(8.1/8.2/8.3).
 * DB(SoT) → 스냅샷/델타/manifest. **M0 참조 빌더를 그대로 재사용** → 골든 벡터로 검증된 결정성 공유.
 */
import { randomUUID } from "node:crypto";
import {
  buildSnapshot, buildDelta, compileManifest,
  publishWithAutoClose, assertNoConflicts, RangeConflictError,
  type ReleaseRecord,
} from "../../../src/builder/builder.ts";
import type { Manifest, Snapshot, TranslationValue } from "../../../src/core/types.ts";
import type { Repo, ReleaseRow } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { type Metrics, METRIC } from "../observability/metrics.ts";
import type { Notifier } from "../observability/notifier.ts";

export { RangeConflictError };
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what: string) { super(`없음: ${what}`); this.name = "NotFoundError"; }
}

/**
 * 게시해도 **아무 값도 안 나가는** 릴리스(422). 쓰기 전에 거부한다.
 *
 * SDK는 매칭된 릴리스의 base가 bake된 번들과 다르면 받아온 스냅샷으로 번들을 **통째로 갈아끼운다**
 * (`client.refresh`). 그래서 빈 스냅샷을 게시하면 그 버전대 앱에서 번역이 전부 사라지고 화면에는
 * `⟪key⟫`가 남는다 — 되돌리려면 롤백까지 가야 하는데, 그런 릴리스를 게시해서 얻는 것은 없다.
 *
 * 0인 이유는 둘이고 고칠 자리가 달라 `reason`으로 나눈다: 키를 안 담았거나(`noKeys`), 담은 키에
 * 지원 로케일 번역이 하나도 없다(`noTranslations`).
 */
export class EmptyReleaseError extends Error {
  readonly status = 422;
  readonly reason: "noKeys" | "noTranslations";
  constructor(releaseId: string, keyCount: number) {
    super(keyCount === 0
      ? `릴리스 ${releaseId}에 담긴 키가 없습니다 — 게시하면 그 버전대 앱의 번역이 전부 사라집니다. 키를 먼저 담으세요`
      : `릴리스 ${releaseId}에 키 ${keyCount}개가 담겼지만 지원 로케일 번역이 하나도 없습니다 — 게시하면 그 버전대 앱의 번역이 전부 사라집니다`);
    this.name = "EmptyReleaseError";
    this.reason = keyCount === 0 ? "noKeys" : "noTranslations";
  }
}

function toRecord(r: ReleaseRow): ReleaseRecord {
  return {
    id: r.id, versionMatch: r.versionMatch, state: r.state,
    base: r.base ?? "", overlay: r.overlay ?? r.base ?? "", rollout: r.rollout,
  };
}

/** 서빙 중(published·superseded)이고 base가 있는 릴리스만 manifest 레코드로. */
function servingRecords(repo: Repo, projectId: string): ReleaseRecord[] {
  return repo.listReleases(projectId)
    .filter((r) => (r.state === "published" || r.state === "superseded") && r.base)
    .map(toRecord);
}

/** DB의 서빙 릴리스로 manifest를 재생성해 스토리지에 게시하고 이력에 기록(롤백 보존 창). */
function buildAndPublishManifest(repo: Repo, store: ArtifactStore, projectId: string): Manifest {
  const project = repo.getProject(projectId)!;
  const manifest = compileManifest({
    project: project.id, defaultLocale: project.defaultLocale,
    updatedAt: new Date().toISOString(), records: servingRecords(repo, projectId),
  });
  store.writeManifest(projectId, manifest);
  // 이력 기록은 updatedAt를 뺀 정규화로 seq 판단하지 않고 단순 누적(보존 창 20).
  repo.recordManifest(projectId, JSON.stringify(manifest));
  return manifest;
}

/** 스냅샷 안의 번역 엔트리 수. 키 하나가 로케일 둘에 있으면 배포 변경도 둘이므로 2로 센다. */
function snapshotEntryCount(locales: Record<string, Record<string, TranslationValue>>): number {
  return Object.values(locales).reduce((sum, catalog) => sum + Object.keys(catalog).length, 0);
}

/**
 * publish 직전 비교 기준. 같은 릴리스 재게시는 rollback까지 반영된 현재 overlay, 한 번도 게시하지
 * 않은 신규 릴리스는 같은 매칭 전략의 직전 릴리스(생성 seq 기준)다. 첫 게시면 undefined.
 *
 * 기준 릴리스는 있는데 스냅샷을 못 읽으면 `snapshot`이 비어서 온다. 미리보기(`releaseChanges`)는
 * 그걸 404로 말하고, publish는 base 유실 방어가 따로 있어 빠진 키 경고만 건너뛴다.
 */
function baselineOf(repo: Repo, store: ArtifactStore, projectId: string, release: ReleaseRow):
  { readonly release: ReleaseRow; readonly snapshot: Snapshot | undefined } | undefined {
  const previous = release.overlay
    ? release
    : repo.listReleases(projectId)
      .filter((candidate) =>
        candidate.seq < release.seq && candidate.overlay &&
        candidate.versionMatch.strategy === release.versionMatch.strategy)
      .at(-1);
  if (!previous?.overlay) return undefined;
  return { release: previous, snapshot: store.readSnapshot(projectId, previous.id, previous.overlay) };
}

/**
 * 기준 스냅샷에 있었는데 새 스냅샷에 없는 키 이름(중복 제거·정렬).
 *
 * **막지 않고 알리기만 한다.** 재게시에서는 이런 삭제가 생길 수 없다 — 릴리스에서 키를 빼는 경로도,
 * 번역·로케일을 지우는 경로도 없다. 그래서 여기 잡히는 것은 신규 릴리스가 직전 버전대 릴리스보다
 * 키를 덜 담은 경우뿐인데, 그건 실수(그 버전대 앱에 `⟪key⟫`)일 수도 새 앱 버전에서 기능을 걷어낸
 * 정상(새 앱은 그 키를 부르지 않는다)일 수도 있다. 서버에는 둘을 가를 근거가 없다.
 */
function droppedKeyNames(baseline: Snapshot, next: Snapshot): string[] {
  const names = new Set<string>();
  for (const op of buildDelta(baseline, next).ops) if (op.op === "delete") names.add(op.key);
  return [...names].sort();
}

export type ReleaseChangeType = "added" | "changed" | "deleted";
export interface ReleaseChange {
  readonly type: ReleaseChangeType;
  readonly key: string;
  readonly locale: string;
  readonly before?: TranslationValue;
  readonly after?: TranslationValue;
}
export interface ReleaseChanges {
  readonly releaseId: string;
  /** null이면 비교할 게시본이 없다 — 이 매칭 전략의 첫 게시다. */
  readonly baseline: { readonly releaseId: string; readonly hash: string; readonly entries: number } | null;
  readonly target: { readonly releaseId: string; readonly hash: string; readonly entries: number };
  readonly summary: Record<ReleaseChangeType, number> & { readonly total: number };
  readonly changes: readonly ReleaseChange[];
}

/**
 * publish 직전 현재 DB 카탈로그와 현장에 걸린 마지막 불변 스냅샷을 비교한다.
 * 판정은 publish가 쓰는 `buildSnapshot`·`buildDelta`를 그대로 재사용한다 — UI용 diff를 따로
 * 구현하면 미리보기와 실제 delta가 갈리는 순간이 생긴다. 비교 기준도 publish와 같은 `baselineOf`다.
 */
export function releaseChanges(repo: Repo, store: ArtifactStore, projectId: string, releaseId: string): ReleaseChanges {
  const project = repo.getProject(projectId);
  if (!project) throw new NotFoundError(`project ${projectId}`);
  const release = repo.getRelease(projectId, releaseId);
  if (!release) throw new NotFoundError(`release ${releaseId}`);

  const target = buildSnapshot({
    release: releaseId,
    defaultLocale: project.defaultLocale,
    locales: repo.catalogForRelease(projectId, releaseId),
  });
  const base = baselineOf(repo, store, projectId, release);
  if (base && !base.snapshot) {
    throw new NotFoundError(`snapshot ${base.release.id}/${base.release.overlay}`);
  }
  const baseline = base?.snapshot;

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
    baseline: baseline && base
      ? { releaseId: base.release.id, hash: baseline.base, entries: snapshotEntryCount(baseline.locales) }
      : null,
    target: { releaseId, hash: target.base, entries: snapshotEntryCount(target.locales) },
    summary,
    changes,
  };
}

export interface PublishResult {
  readonly releaseId: string;
  readonly base: string;
  readonly overlay: string;
  readonly manifest: Manifest;
  /** 직전 게시본에 있었는데 이번 카탈로그에 없는 키 — 막지 않은 경고다(`droppedKeyNames` 주석). */
  readonly droppedKeys: readonly string[];
}

/**
 * 릴리스 publish (7.4/8.1/8.2):
 *  1) 버전 범위 충돌·자동 상한 닫힘 검증(쓰기 전) — 409면 중단
 *  2) 나갈 번역이 0개면 중단(쓰기 전) — 422
 *  3) 카탈로그 → 스냅샷/델타 산출물 생성 + 포인터 갱신
 *  4) 서빙 릴리스로 manifest 재게시 + 이력 기록
 */
export function publishRelease(repo: Repo, store: ArtifactStore, projectId: string, releaseId: string, actor: string): PublishResult {
  const project = repo.getProject(projectId);
  if (!project) throw new NotFoundError(`project ${projectId}`);
  const release = repo.getRelease(projectId, releaseId);
  if (!release) throw new NotFoundError(`release ${releaseId}`);

  // 1) 검증(쓰기 전): 자동 상한 닫힘 후 충돌 검사.
  const others = repo.listReleases(projectId)
    .filter((r) => r.id !== releaseId && (r.state === "published" || r.state === "superseded"))
    .map(toRecord);
  const incomingShell: ReleaseRecord = { id: releaseId, versionMatch: release.versionMatch, state: "published", base: "", overlay: "" };
  const autoClosed = publishWithAutoClose(others, incomingShell);
  assertNoConflicts(autoClosed); // 겹치면 RangeConflictError(409)

  // 2) 나갈 것이 있는가. 아래 자동 상한 닫힘 반영부터가 쓰기라 그 앞에서 멈춘다 — 거절된 publish가
  //    이전 릴리스의 범위만 줄여 놓고 끝나면 그 위 버전대 앱은 매칭 릴리스를 잃고 번들로 떨어진다.
  const catalog = repo.catalogForRelease(projectId, releaseId);
  const newSnap = buildSnapshot({ release: releaseId, defaultLocale: project.defaultLocale, locales: catalog });
  if (snapshotEntryCount(newSnap.locales) === 0) {
    throw new EmptyReleaseError(releaseId, repo.listReleaseKeys(projectId, releaseId).length);
  }
  const baseline = baselineOf(repo, store, projectId, release)?.snapshot;
  const droppedKeys = baseline ? droppedKeyNames(baseline, newSnap) : [];

  // 자동 상한 닫힘으로 바뀐 이전 릴리스를 DB에 반영(superseded 전이 + 범위 축소).
  for (const rec of autoClosed) {
    if (rec.id === releaseId) continue;
    const orig = others.find((o) => o.id === rec.id);
    if (orig && (orig.versionMatch.value !== rec.versionMatch.value || orig.state !== rec.state)) {
      repo.updateReleaseVersionMatch(projectId, rec.id, rec.versionMatch);
      repo.updateReleaseState(projectId, rec.id, rec.state);
    }
  }

  // 3) 산출물 생성.
  if (release.base === null) {
    // 최초 publish: base=overlay=newSnap.
    store.writeSnapshot(projectId, releaseId, newSnap);
    repo.updateReleasePointers(projectId, releaseId, newSnap.base, newSnap.base);
  } else if (newSnap.base !== release.overlay) {
    // 편집 반영: base→newSnap 델타 사전 생성(클라이언트 diff 없음).
    const baseSnap = store.readSnapshot(projectId, releaseId, release.base);
    store.writeSnapshot(projectId, releaseId, newSnap);
    if (baseSnap) {
      const delta = buildDelta(baseSnap, newSnap);
      store.writeDelta(projectId, releaseId, delta);
      repo.setReleaseOverlay(projectId, releaseId, newSnap.base);
    } else {
      // base 스냅샷 유실 방어: 재베이스라인.
      repo.updateReleasePointers(projectId, releaseId, newSnap.base, newSnap.base);
    }
  }
  if (release.state === "draft") repo.updateReleaseState(projectId, releaseId, "published");

  // 4) manifest 재게시.
  const manifest = buildAndPublishManifest(repo, store, projectId);
  repo.audit(projectId, actor, "publish", { releaseId, base: newSnap.base });

  const updated = repo.getRelease(projectId, releaseId)!;
  return { releaseId, base: updated.base!, overlay: updated.overlay!, manifest, droppedKeys };
}

export interface PublishJobDeps {
  readonly repo: Repo;
  readonly store: ArtifactStore;
  readonly metrics: Metrics;
  readonly notifier: Notifier;
}

/**
 * publish를 잡 기록·메트릭·실시간 알림으로 감싼 **단일 진입점**. 관리 API 라우트와 MCP
 * `publish_release` 도구가 둘 다 이 함수를 부른다 — 표면마다 잡/메트릭 처리를 따로 쓰면
 * 어느 한쪽으로 게시된 publish가 대시보드 잡 목록·지표에서 빠지는 순간이 생긴다.
 */
export function publishReleaseJob(
  deps: PublishJobDeps, projectId: string, releaseId: string, actor: string,
): PublishResult & { readonly jobId: string } {
  const jobId = randomUUID();
  deps.repo.createJob(jobId, projectId, "publish");
  const started = performance.now();
  try {
    const result = publishRelease(deps.repo, deps.store, projectId, releaseId, actor);
    deps.repo.finishJob(jobId, "done", { base: result.base, overlay: result.overlay });
    deps.metrics.inc(METRIC.publishTotal, { result: "success" });
    deps.metrics.observe(METRIC.publishDuration, (performance.now() - started) / 1000);
    deps.notifier.emit(projectId); // 실시간 푸시 신호(manifest 변경)
    return { ...result, jobId };
  } catch (e) {
    deps.repo.finishJob(jobId, "failed", { error: (e as Error).message });
    // 빈 릴리스는 서버 고장이 아니라 입력 거절이다 — error에 섞으면 오류율 경보가 사람의 실수로 울린다.
    const result = e instanceof RangeConflictError ? "conflict" : e instanceof EmptyReleaseError ? "empty" : "error";
    deps.metrics.inc(METRIC.publishTotal, { result });
    throw e;
  }
}

/**
 * 롤백 (8.3): 릴리스의 overlay 포인터를 이전 target으로 되돌리고 manifest 재게시.
 * 산출물 불변이라 이전 델타/스냅샷이 그대로 남아 즉시·무손실.
 */
export function rollbackRelease(repo: Repo, store: ArtifactStore, projectId: string, releaseId: string, previousOverlay: string, actor: string): Manifest {
  const release = repo.getRelease(projectId, releaseId);
  if (!release) throw new NotFoundError(`release ${releaseId}`);
  // previousOverlay는 base(델타 없음) 또는 이전에 게시된 target이어야 한다.
  const valid = previousOverlay === release.base || store.readSnapshot(projectId, releaseId, previousOverlay) !== undefined
    || store.readSnapshot(projectId, releaseId, release.base ?? "") !== undefined;
  if (!valid) throw new NotFoundError(`rollback target ${previousOverlay}`);
  repo.setReleaseOverlay(projectId, releaseId, previousOverlay);
  const manifest = buildAndPublishManifest(repo, store, projectId);
  repo.audit(projectId, actor, "rollback", { releaseId, to: previousOverlay });
  return manifest;
}
