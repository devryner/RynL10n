/**
 * Repository — DB(SoT) 도메인 CRUD (기획서 5 / 7.4).
 * node:sqlite prepared statement 래핑. 값(TranslationValue)은 value_json에 JSON으로 저장.
 */
import type { DatabaseSync } from "node:sqlite";
import type { TranslationValue, VersionMatch, ReleaseState } from "../../../src/core/types.ts";

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly defaultLocale: string;
}
export interface ReleaseRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly versionMatch: VersionMatch;
  readonly state: ReleaseState;
  readonly base: string | null;
  readonly overlay: string | null;
  readonly rollout: number;
  readonly seq: number;
  readonly createdAt: string;
}
export type Catalog = Record<string, Record<string, TranslationValue>>;

function nowIso(): string {
  return new Date().toISOString();
}

export class Repo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  // ── Project / Locale ────────────────────────────────────────────────────────
  createProject(id: string, name: string, defaultLocale: string, locales: string[]): void {
    this.db.prepare("INSERT INTO projects(id,name,default_locale) VALUES(?,?,?)").run(id, name, defaultLocale);
    const ins = this.db.prepare("INSERT OR IGNORE INTO locales(project_id,tag) VALUES(?,?)");
    for (const tag of new Set([defaultLocale, ...locales])) ins.run(id, tag);
  }
  getProject(id: string): ProjectRow | undefined {
    const r = this.db.prepare("SELECT id,name,default_locale FROM projects WHERE id=?").get(id) as
      | { id: string; name: string; default_locale: string } | undefined;
    return r ? { id: r.id, name: r.name, defaultLocale: r.default_locale } : undefined;
  }
  addLocale(projectId: string, tag: string, fallbackParent?: string): void {
    this.db.prepare("INSERT OR REPLACE INTO locales(project_id,tag,fallback_parent) VALUES(?,?,?)")
      .run(projectId, tag, fallbackParent ?? null);
  }
  listLocales(projectId: string): string[] {
    return (this.db.prepare("SELECT tag FROM locales WHERE project_id=? ORDER BY tag").all(projectId) as { tag: string }[])
      .map((r) => r.tag);
  }

  // ── Key / Translation ──────────────────────────────────────────────────────
  upsertKey(projectId: string, name: string, signature: string, isPlural: boolean): number {
    this.db.prepare(
      `INSERT INTO keys(project_id,name,placeholder_signature,is_plural) VALUES(?,?,?,?)
       ON CONFLICT(project_id,name) DO UPDATE SET placeholder_signature=excluded.placeholder_signature, is_plural=excluded.is_plural`,
    ).run(projectId, name, signature, isPlural ? 1 : 0);
    return (this.db.prepare("SELECT id FROM keys WHERE project_id=? AND name=?").get(projectId, name) as { id: number }).id;
  }
  getKeyByName(projectId: string, name: string): { id: number; signature: string; isPlural: boolean } | undefined {
    const r = this.db.prepare("SELECT id,placeholder_signature,is_plural FROM keys WHERE project_id=? AND name=?")
      .get(projectId, name) as { id: number; placeholder_signature: string; is_plural: number } | undefined;
    return r ? { id: r.id, signature: r.placeholder_signature, isPlural: !!r.is_plural } : undefined;
  }
  putTranslation(projectId: string, keyId: number, locale: string, value: TranslationValue, state: string): void {
    this.db.prepare(
      `INSERT INTO translations(project_id,key_id,locale,value_json,state,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(key_id,locale) DO UPDATE SET value_json=excluded.value_json, state=excluded.state, updated_at=excluded.updated_at`,
    ).run(projectId, keyId, locale, JSON.stringify(value), state, nowIso());
  }
  getTranslation(keyId: number, locale: string): { value: TranslationValue; state: string; updatedAt: string } | undefined {
    const r = this.db.prepare("SELECT value_json,state,updated_at FROM translations WHERE key_id=? AND locale=?")
      .get(keyId, locale) as { value_json: string; state: string; updated_at: string } | undefined;
    return r ? { value: JSON.parse(r.value_json) as TranslationValue, state: r.state, updatedAt: r.updated_at } : undefined;
  }

  // ── Release ────────────────────────────────────────────────────────────────
  nextSeq(projectId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM releases WHERE project_id=?").get(projectId) as { n: number };
    return r.n;
  }
  createRelease(projectId: string, id: string, name: string, vm: VersionMatch, state: ReleaseState): void {
    this.db.prepare(
      `INSERT INTO releases(id,project_id,name,vm_strategy,vm_value,state,rollout,seq,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(id, projectId, name, vm.strategy, vm.value, state, 100, this.nextSeq(projectId), nowIso());
  }
  getRelease(projectId: string, id: string): ReleaseRow | undefined {
    const r = this.db.prepare("SELECT * FROM releases WHERE project_id=? AND id=?").get(projectId, id) as any;
    return r ? mapRelease(r) : undefined;
  }
  listReleases(projectId: string): ReleaseRow[] {
    return (this.db.prepare("SELECT * FROM releases WHERE project_id=? ORDER BY seq").all(projectId) as any[]).map(mapRelease);
  }
  updateReleaseState(projectId: string, id: string, state: ReleaseState): void {
    this.db.prepare("UPDATE releases SET state=? WHERE project_id=? AND id=?").run(state, projectId, id);
  }
  updateReleaseVersionMatch(projectId: string, id: string, vm: VersionMatch): void {
    this.db.prepare("UPDATE releases SET vm_strategy=?, vm_value=? WHERE project_id=? AND id=?")
      .run(vm.strategy, vm.value, projectId, id);
  }
  updateReleasePointers(projectId: string, id: string, base: string, overlay: string): void {
    this.db.prepare("UPDATE releases SET base=?, overlay=? WHERE project_id=? AND id=?").run(base, overlay, projectId, id);
  }
  setReleaseOverlay(projectId: string, id: string, overlay: string): void {
    this.db.prepare("UPDATE releases SET overlay=? WHERE project_id=? AND id=?").run(overlay, projectId, id);
  }

  // ── Release ↔ Key ──────────────────────────────────────────────────────────
  addReleaseKey(projectId: string, releaseId: string, keyId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO release_keys(project_id,release_id,key_id) VALUES(?,?,?)")
      .run(projectId, releaseId, keyId);
  }
  keyRefCount(keyId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM release_keys WHERE key_id=?").get(keyId) as { n: number }).n;
  }

  /** 릴리스에 속한 키들의 (locale→key→value) 카탈로그. 지원 로케일로 제한. */
  catalogForRelease(projectId: string, releaseId: string): Catalog {
    const supported = new Set(this.listLocales(projectId));
    const rows = this.db.prepare(
      `SELECT k.name AS name, t.locale AS locale, t.value_json AS value_json
       FROM release_keys rk
       JOIN keys k ON k.id = rk.key_id
       JOIN translations t ON t.key_id = k.id
       WHERE rk.project_id=? AND rk.release_id=?`,
    ).all(projectId, releaseId) as { name: string; locale: string; value_json: string }[];
    const catalog: Catalog = {};
    for (const row of rows) {
      if (!supported.has(row.locale)) continue;
      (catalog[row.locale] ??= {})[row.name] = JSON.parse(row.value_json) as TranslationValue;
    }
    return catalog;
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────
  createJob(id: string, projectId: string, type: string): void {
    this.db.prepare("INSERT INTO jobs(id,project_id,type,state,progress,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, projectId, type, "pending", 0, nowIso());
  }
  finishJob(id: string, state: "done" | "failed", result: unknown): void {
    this.db.prepare("UPDATE jobs SET state=?, progress=100, result_json=? WHERE id=?")
      .run(state, JSON.stringify(result ?? null), id);
  }
  getJob(id: string): { id: string; state: string; progress: number; result: unknown } | undefined {
    const r = this.db.prepare("SELECT id,state,progress,result_json FROM jobs WHERE id=?").get(id) as
      | { id: string; state: string; progress: number; result_json: string | null } | undefined;
    return r ? { id: r.id, state: r.state, progress: r.progress, result: r.result_json ? JSON.parse(r.result_json) : null } : undefined;
  }

  // ── Published manifest 이력(롤백 보존 창 8.3) ────────────────────────────────
  recordManifest(projectId: string, manifestJson: string, keep = 20): number {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM published_manifests WHERE project_id=?")
      .get(projectId) as { n: number }).n;
    this.db.prepare("INSERT INTO published_manifests(project_id,seq,manifest_json,created_at) VALUES(?,?,?,?)")
      .run(projectId, seq, manifestJson, nowIso());
    // 보존 창 초과분 정리.
    this.db.prepare(
      `DELETE FROM published_manifests WHERE project_id=? AND seq <= ?`,
    ).run(projectId, seq - keep);
    return seq;
  }
  listManifestHistory(projectId: string): { seq: number; manifestJson: string; createdAt: string }[] {
    return (this.db.prepare("SELECT seq,manifest_json,created_at FROM published_manifests WHERE project_id=? ORDER BY seq DESC")
      .all(projectId) as { seq: number; manifest_json: string; created_at: string }[])
      .map((r) => ({ seq: r.seq, manifestJson: r.manifest_json, createdAt: r.created_at }));
  }

  // ── Audit ────────────────────────────────────────────────────────────────────
  audit(projectId: string, actor: string, action: string, detail: unknown): void {
    this.db.prepare("INSERT INTO audit_log(project_id,actor,action,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(projectId, actor, action, JSON.stringify(detail ?? null), nowIso());
  }
}

function mapRelease(r: any): ReleaseRow {
  return {
    id: r.id, projectId: r.project_id, name: r.name,
    versionMatch: { strategy: r.vm_strategy, value: r.vm_value },
    state: r.state, base: r.base, overlay: r.overlay, rollout: r.rollout, seq: r.seq, createdAt: r.created_at,
  };
}
