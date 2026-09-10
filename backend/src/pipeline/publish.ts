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
import type { Manifest } from "../../../src/core/types.ts";
import type { Repo, ReleaseRow } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { type Metrics, METRIC } from "../observability/metrics.ts";
import type { Notifier } from "../observability/notifier.ts";

export { RangeConflictError };
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what: string) { super(`없음: ${what}`); this.name = "NotFoundError"; }
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

export interface PublishResult {
  readonly releaseId: string;
  readonly base: string;
  readonly overlay: string;
  readonly manifest: Manifest;
}

/**
 * 릴리스 publish (7.4/8.1/8.2):
 *  1) 버전 범위 충돌·자동 상한 닫힘 검증(쓰기 전) — 409면 중단
 *  2) 카탈로그 → 스냅샷/델타 산출물 생성 + 포인터 갱신
 *  3) 서빙 릴리스로 manifest 재게시 + 이력 기록
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

  // 자동 상한 닫힘으로 바뀐 이전 릴리스를 DB에 반영(superseded 전이 + 범위 축소).
  for (const rec of autoClosed) {
    if (rec.id === releaseId) continue;
    const orig = others.find((o) => o.id === rec.id);
    if (orig && (orig.versionMatch.value !== rec.versionMatch.value || orig.state !== rec.state)) {
      repo.updateReleaseVersionMatch(projectId, rec.id, rec.versionMatch);
      repo.updateReleaseState(projectId, rec.id, rec.state);
    }
  }

  // 2) 산출물 생성.
  const catalog = repo.catalogForRelease(projectId, releaseId);
  const newSnap = buildSnapshot({ release: releaseId, defaultLocale: project.defaultLocale, locales: catalog });

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

  // 3) manifest 재게시.
  const manifest = buildAndPublishManifest(repo, store, projectId);
  repo.audit(projectId, actor, "publish", { releaseId, base: newSnap.base });

  const updated = repo.getRelease(projectId, releaseId)!;
  return { releaseId, base: updated.base!, overlay: updated.overlay!, manifest };
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
    deps.metrics.inc(METRIC.publishTotal, { result: e instanceof RangeConflictError ? "conflict" : "error" });
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
