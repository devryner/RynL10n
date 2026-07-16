/**
 * 산출물 재생성 (재해 복구) — 기획서 9.4.
 * "산출물은 DB에서 재생성 가능(결정적 빌드)" — 스토리지 유실 시 DB(SoT)만으로 복원한다.
 *
 * 각 서빙 릴리스의 현재 카탈로그로 스냅샷을 재빌드하고 base=overlay로 재베이스라인한다.
 * (base 스냅샷은 과거 상태라 현재 DB에서 복원 불가 → 현재 상태로 재베이스라인. 2계층 구조 덕분에
 *  구버전 앱은 base 변경 시 풀 스냅샷을 받아 번역 공백 없음.) 같은 DB → 같은 산출물(결정적).
 */
import { buildSnapshot, compileManifest, type ReleaseRecord } from "../../../src/builder/builder.ts";
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import type { Manifest } from "../../../src/core/types.ts";

export function rebuildAllArtifacts(repo: Repo, store: ArtifactStore, projectId: string): Manifest {
  const project = repo.getProject(projectId);
  if (!project) throw new Error(`없는 프로젝트: ${projectId}`);

  const records: ReleaseRecord[] = [];
  for (const r of repo.listReleases(projectId)) {
    if (r.state === "draft" || r.state === "archived") continue;
    const catalog = repo.catalogForRelease(projectId, r.id);
    const snap = buildSnapshot({ release: r.id, defaultLocale: project.defaultLocale, locales: catalog });
    store.writeSnapshot(projectId, r.id, snap);
    repo.updateReleasePointers(projectId, r.id, snap.base, snap.base); // 재베이스라인
    records.push({ id: r.id, versionMatch: r.versionMatch, state: r.state, base: snap.base, overlay: snap.base, rollout: r.rollout });
  }

  const manifest = compileManifest({
    project: project.id, defaultLocale: project.defaultLocale,
    updatedAt: new Date().toISOString(), records,
  });
  store.writeManifest(projectId, manifest);
  repo.audit(projectId, "system", "rebuild", { releases: records.length });
  return manifest;
}
