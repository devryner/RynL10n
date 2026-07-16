/**
 * 산출물 스토리지 (배포 플레인) — 기획서 7.2 / 11.2.
 * 정적 파일 레이아웃: /{project}/manifest.json · /{project}/releases/{r}/snapshot-{hash}.json · delta-{base}-{target}.json
 * 스냅샷·델타는 내용해시 URL(불변). MinIO/S3 대체 가능 — 여기선 로컬 FS 구현.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalStringify } from "../../../src/serialize/jcs.ts";
import type { Snapshot, Delta, Manifest } from "../../../src/core/types.ts";

export interface ArtifactStore {
  writeSnapshot(project: string, releaseId: string, snap: Snapshot): string;
  writeDelta(project: string, releaseId: string, delta: Delta): string;
  writeManifest(project: string, manifest: Manifest): void;
  readSnapshot(project: string, releaseId: string, base: string): Snapshot | undefined;
  readManifest(project: string): Manifest | undefined;
}

function snapshotPath(releaseId: string, base: string): string {
  return `releases/${releaseId}/snapshot-${base}.json`;
}
function deltaPath(releaseId: string, from: string, to: string): string {
  return `releases/${releaseId}/delta-${from}-${to}.json`;
}

/** 로컬 FS 구현(단일 노드 셀프호스트 · 테스트). 스냅샷·델타는 JCS 정규화로 방출(결정적). */
export class FsArtifactStore implements ArtifactStore {
  private readonly root: string;
  constructor(root: string) { this.root = root; }

  private abs(project: string, rel: string): string {
    return join(this.root, project, rel);
  }
  private write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  writeSnapshot(project: string, releaseId: string, snap: Snapshot): string {
    const rel = snapshotPath(releaseId, snap.base);
    this.write(this.abs(project, rel), canonicalStringify(snap));
    return rel;
  }
  writeDelta(project: string, releaseId: string, delta: Delta): string {
    const rel = deltaPath(releaseId, delta.from, delta.to);
    this.write(this.abs(project, rel), canonicalStringify(delta));
    return rel;
  }
  writeManifest(project: string, manifest: Manifest): void {
    this.write(this.abs(project, "manifest.json"), canonicalStringify(manifest));
  }
  readSnapshot(project: string, releaseId: string, base: string): Snapshot | undefined {
    const p = this.abs(project, snapshotPath(releaseId, base));
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Snapshot;
  }
  readManifest(project: string): Manifest | undefined {
    const p = this.abs(project, "manifest.json");
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  }
}

/** SDK 런타임(배포 플레인 소비자)이 읽는 정적 파일 인터페이스 — 경로 기반. */
export interface DeliveryReader {
  getSnapshot(path: string): Snapshot | undefined;
  getDelta(path: string): Delta | undefined;
}

/** 인메모리 구현(테스트·SDK 소비 검증). */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly deltas = new Map<string, Delta>();
  private readonly manifests = new Map<string, Manifest>();
  private key(project: string, rel: string): string { return `${project}/${rel}`; }

  writeSnapshot(project: string, releaseId: string, snap: Snapshot): string {
    const rel = snapshotPath(releaseId, snap.base);
    this.snapshots.set(this.key(project, rel), snap);
    return rel;
  }
  writeDelta(project: string, releaseId: string, delta: Delta): string {
    const rel = deltaPath(releaseId, delta.from, delta.to);
    this.deltas.set(this.key(project, rel), delta);
    return rel;
  }
  writeManifest(project: string, manifest: Manifest): void {
    this.manifests.set(project, manifest);
  }
  readSnapshot(project: string, releaseId: string, base: string): Snapshot | undefined {
    return this.snapshots.get(this.key(project, snapshotPath(releaseId, base)));
  }
  readManifest(project: string): Manifest | undefined {
    return this.manifests.get(project);
  }

  /** SDK 런타임이 쓰는 프로젝트 스코프 DeliveryReader(배포 플레인 소비자 시뮬). */
  deliveryReader(project: string): DeliveryReader {
    return {
      getSnapshot: (path) => this.snapshots.get(this.key(project, path)),
      getDelta: (path) => this.deltas.get(this.key(project, path)),
    };
  }
}
