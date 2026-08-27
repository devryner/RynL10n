/**
 * 산출물 스토리지 (배포 플레인) — 기획서 7.2 / 11.2.
 * 정적 파일 레이아웃: /{project}/manifest.json · /{project}/releases/{r}/snapshot-{hash}.json · delta-{base}-{target}.json
 * 스냅샷·델타는 내용해시 URL(불변). MinIO/S3 대체 가능 — 여기선 로컬 FS 구현.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalStringify } from "../../../src/serialize/jcs.ts";
import type { Snapshot, Delta, Manifest } from "../../../src/core/types.ts";

/** SDK 런타임(배포 플레인 소비자)이 읽는 정적 파일 인터페이스 — 경로 기반. */
export interface DeliveryReader {
  getSnapshot(path: string): Snapshot | undefined;
  getDelta(path: string): Delta | undefined;
}

export interface ArtifactStore {
  writeSnapshot(project: string, releaseId: string, snap: Snapshot): string;
  writeDelta(project: string, releaseId: string, delta: Delta): string;
  writeManifest(project: string, manifest: Manifest): void;
  readSnapshot(project: string, releaseId: string, base: string): Snapshot | undefined;
  readDelta(project: string, releaseId: string, from: string, to: string): Delta | undefined;
  readManifest(project: string): Manifest | undefined;
  /**
   * SDK 런타임이 보는 것과 같은 경로 기반 읽기 뷰(진단·시뮬레이션용).
   * manifest의 `snapshot`·`delta`는 상대 경로 문자열이라 (releaseId, hash)로 되짚지 않고
   * 그 경로를 그대로 읽어야 한다 — SDK가 하는 일과 같아야 시뮬레이션이 실물과 갈라지지 않는다.
   */
  deliveryReader(project: string): DeliveryReader;
  /**
   * 프로젝트의 산출물 전체 제거. DB에서 프로젝트를 지울 때 함께 호출한다 —
   * 배포 플레인은 정적 파일만 보고 서빙하므로, 여기 남으면 지워진 프로젝트의 manifest를
   * SDK에 계속 내주게 된다(4.1의 대가: 읽기 경로에 애플리케이션 로직이 없어 스스로 걸러내지 못한다).
   */
  deleteProject(project: string): void;
}

/**
 * 프로젝트 id는 URL에서 그대로 들어와 경로 세그먼트가 된다. 경로 순회를 막지 않으면
 * 쓰기는 스토리지 루트 밖을 오염시키고, 삭제는 루트 밖을 **재귀 삭제**한다.
 * 세그먼트 하나로 쓸 수 있는 형태만 통과시킨다.
 */
function assertSafeSegment(value: string, label: string): void {
  if (
    value === "" || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\") || value.includes("\0")
  ) {
    throw new Error(`${label}로 쓸 수 없는 값입니다: ${JSON.stringify(value)}`);
  }
}

/**
 * manifest가 준 상대 경로(`releases/{r}/snapshot-{hash}.json`)를 그대로 join하기 전 검사.
 * 경로는 서버가 쓴 것이지만 배포 플레인의 파일은 손으로도 고칠 수 있고, 읽기 뷰는
 * 그 문자열을 신뢰해 루트에 붙인다 — 세그먼트마다 위 가드를 다시 건다.
 */
function assertSafeRelPath(rel: string): void {
  if (rel === "" || rel.startsWith("/")) throw new Error(`상대 경로가 아닙니다: ${JSON.stringify(rel)}`);
  for (const seg of rel.split("/")) assertSafeSegment(seg, "산출물 경로 세그먼트");
}

// 릴리스 id는 생성 시 본문으로 지정할 수 있어(`POST /projects/{p}/releases`의 `id`)
// 프로젝트 id와 똑같이 경로 세그먼트로 내려온다 — 같은 가드를 건다.
function snapshotPath(releaseId: string, base: string): string {
  assertSafeSegment(releaseId, "릴리스 id");
  return `releases/${releaseId}/snapshot-${base}.json`;
}
function deltaPath(releaseId: string, from: string, to: string): string {
  assertSafeSegment(releaseId, "릴리스 id");
  return `releases/${releaseId}/delta-${from}-${to}.json`;
}

/** 로컬 FS 구현(단일 노드 셀프호스트 · 테스트). 스냅샷·델타는 JCS 정규화로 방출(결정적). */
export class FsArtifactStore implements ArtifactStore {
  private readonly root: string;
  /**
   * 루트가 비어 있으면 모든 경로가 **cwd 기준 상대경로**가 된다 — 산출물이 작업 디렉토리에
   * 쏟아지고, `deleteProject("src")`가 프로젝트 트리가 아니라 `./src`를 재귀 삭제한다.
   * `assertSafeSegment`는 프로젝트 id만 보므로 그 가드로는 막히지 않는다. 기동 시점에 끊는다.
   */
  constructor(root: string) {
    if (root.trim() === "") throw new Error("스토리지 루트가 비어 있습니다(경로가 cwd로 접힙니다)");
    this.root = root;
  }

  private abs(project: string, rel: string): string {
    assertSafeSegment(project, "프로젝트 id");
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
  readDelta(project: string, releaseId: string, from: string, to: string): Delta | undefined {
    return this.readPath(project, deltaPath(releaseId, from, to)) as Delta | undefined;
  }
  readManifest(project: string): Manifest | undefined {
    const p = this.abs(project, "manifest.json");
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  }
  deliveryReader(project: string): DeliveryReader {
    return {
      getSnapshot: (path) => this.readPath(project, path) as Snapshot | undefined,
      getDelta: (path) => this.readPath(project, path) as Delta | undefined,
    };
  }
  private readPath(project: string, rel: string): unknown {
    assertSafeRelPath(rel);
    const p = this.abs(project, rel);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as unknown;
  }
  deleteProject(project: string): void {
    assertSafeSegment(project, "프로젝트 id");
    // 산출물이 없는 프로젝트(publish 전)도 정상 경로다 — force로 조용히 넘어간다.
    rmSync(join(this.root, project), { recursive: true, force: true });
  }
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
  readDelta(project: string, releaseId: string, from: string, to: string): Delta | undefined {
    return this.deltas.get(this.key(project, deltaPath(releaseId, from, to)));
  }
  readManifest(project: string): Manifest | undefined {
    return this.manifests.get(project);
  }
  deleteProject(project: string): void {
    const prefix = `${project}/`;
    for (const map of [this.snapshots, this.deltas] as Map<string, unknown>[]) {
      for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k);
    }
    this.manifests.delete(project);
  }

  /** SDK 런타임이 쓰는 프로젝트 스코프 DeliveryReader(배포 플레인 소비자 시뮬). */
  deliveryReader(project: string): DeliveryReader {
    return {
      getSnapshot: (path) => this.snapshots.get(this.key(project, path)),
      getDelta: (path) => this.deltas.get(this.key(project, path)),
    };
  }
}
