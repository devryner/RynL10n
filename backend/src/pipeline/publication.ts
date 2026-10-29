/** DB 커밋 전 manifest가 교체된 채 중단돼도 실제 직전 배포본으로 복구한다. */
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import type { Manifest } from "../../../src/core/types.ts";

export function recoverPublications(repo: Repo, store: ArtifactStore, projectId?: string): void {
  for (const pending of repo.listPublicationRecoveries()) {
    if (projectId !== undefined && pending.projectId !== projectId) continue;
    if (pending.previousManifestJson === null) store.deleteManifest(pending.projectId);
    else store.writeManifest(pending.projectId, JSON.parse(pending.previousManifestJson) as Manifest);
    // 복원 실패 시 표식을 남긴다. 다음 시도도 같은 배포본을 복구해야 한다.
    repo.transaction(() => {
      if (pending.jobId !== null) repo.finishJob(pending.jobId, "failed", { error: "게시 중단 — 이전 manifest 복원" });
      repo.clearPublicationRecovery(pending.projectId);
    });
  }
}

/**
 * 복구 표식은 별도 커밋, 삭제는 게시 트랜잭션과 함께 커밋한다.
 * 따라서 manifest 교체 직후 중단되면 SQLite가 되돌린 표식으로 이전 파일을 복원할 수 있다.
 * 불변 산출물은 실패해도 남겨 둔다 — 이전 manifest는 그 파일을 참조하지 않는다.
 * 단일 관리 쓰기 프로세스용이다. 다른 프로세스의 진행 중 표식을 복구해서는 안 된다.
 */
export function publishAtomically<T>(
  repo: Repo, store: ArtifactStore, projectId: string,
  work: () => { manifest: Manifest; result: T },
  jobId?: string,
): T {
  recoverPublications(repo, store, projectId);
  const previous = store.readManifest(projectId);
  repo.recordPublicationRecovery(projectId, previous === undefined ? null : JSON.stringify(previous), jobId);
  try {
    return repo.transaction(() => {
      const { manifest, result } = work();
      repo.clearPublicationRecovery(projectId);
      // 모든 실패 가능한 SQL 뒤에 파일을 교체한다. COMMIT 실패도 아래 복구가 처리한다.
      store.writeManifest(projectId, manifest);
      return result;
    });
  } catch (error) {
    try { recoverPublications(repo, store, projectId); }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "게시 실패 후 manifest 복구 실패 — 저장소 복원 후 재시도하세요");
    }
    throw error;
  }
}
