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

/** 대시보드 편집 그리드용 — 키 1개 + 로케일별 번역 전체(7.1). refCount는 키 삭제 가드(5.2) 표시. */
export interface KeyDetail {
  readonly name: string;
  readonly signature: string;
  readonly isPlural: boolean;
  /** 번역자 참고용 설명(5.1). 키 단위 — 로케일이 늘어도 같은 '의미'를 설명한다. */
  readonly description: string;
  readonly refCount: number;
  readonly translations: Record<string, { value: TranslationValue; state: string; updatedAt: string }>;
}

/** 프로젝트 전체 export(데이터 이식성 9.2 / 백업 9.4) — id 비의존, 참조는 이름 기반. */
export interface ProjectExport {
  readonly project: ProjectRow;
  readonly locales: ReadonlyArray<{ tag: string; fallbackParent: string | null }>;
  readonly keys: ReadonlyArray<{
    name: string; signature: string; isPlural: boolean;
    /** 구 export에는 없을 수 있다(하위호환) — import 시 빈 문자열로 취급. */
    description?: string;
    translations: ReadonlyArray<{ locale: string; value: TranslationValue; state: string }>;
  }>;
  readonly releases: ReadonlyArray<{
    id: string; name: string; versionMatch: VersionMatch; state: ReleaseState;
    /** 구 export에는 없을 수 있다(하위호환) — import 시 각각 미설정·기본값 100으로 취급. */
    base?: string | null; overlay?: string | null; rollout?: number;
    keys: readonly string[];
  }>;
}

/** 기존 프로젝트에 키·번역만 병합하는 import. API 계층에서 검증·메타 추론을 마친 정규화 형태. */
export interface TranslationImport {
  readonly keys: ReadonlyArray<{
    readonly name: string;
    readonly signature: string;
    readonly isPlural: boolean;
    readonly description?: string;
    readonly translations: ReadonlyArray<{
      readonly locale: string;
      readonly value: TranslationValue;
      readonly state: string;
    }>;
  }>;
}

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
  listProjects(): ProjectRow[] {
    return (this.db.prepare("SELECT id,name,default_locale FROM projects ORDER BY id").all() as
      { id: string; name: string; default_locale: string }[])
      .map((r) => ({ id: r.id, name: r.name, defaultLocale: r.default_locale }));
  }
  /**
   * 프로젝트 완전 삭제 — 하위 엔티티까지 한 트랜잭션으로.
   *
   * locales·keys·translations·releases·release_keys·published_manifests는 FK의
   * ON DELETE CASCADE가 처리한다. 반면 **jobs·telemetry·audit_log는 project_id가 FK가 아니라
   * 평범한 컬럼**이라 카스케이드가 닿지 않는다 — 여기서 명시적으로 지우지 않으면 고아 행이 남고,
   * 같은 id로 프로젝트를 다시 만들었을 때 남의 이력이 딸려 온다.
   *
   * 산출물(배포 플레인) 정리는 이 메서드의 책임이 아니다 — 호출자가
   * `ArtifactStore.deleteProject`를 함께 불러야 DB와 정적 파일이 어긋나지 않는다.
   */
  deleteProject(projectId: string): void {
    this.db.exec("BEGIN");
    try {
      // 테이블명은 리터럴 — 사용자 입력이 SQL 문자열에 섞이지 않는다.
      for (const table of ["jobs", "telemetry", "audit_log"] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
      }
      this.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
  getKeyByName(projectId: string, name: string): { id: number; signature: string; isPlural: boolean; description: string } | undefined {
    const r = this.db.prepare("SELECT id,placeholder_signature,is_plural,description FROM keys WHERE project_id=? AND name=?")
      .get(projectId, name) as { id: number; placeholder_signature: string; is_plural: number; description: string } | undefined;
    return r ? { id: r.id, signature: r.placeholder_signature, isPlural: !!r.is_plural, description: r.description } : undefined;
  }
  /** 번역자 참고용 설명 갱신(5.1). 서명·복수형 메타와 독립적으로 다룬다. */
  setKeyDescription(projectId: string, name: string, description: string): void {
    this.db.prepare("UPDATE keys SET description=? WHERE project_id=? AND name=?").run(description, projectId, name);
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

  /** 프로젝트의 전체 키 + 로케일별 번역(대시보드 편집 그리드). 키 이름 사전순, 쿼리 3회 고정. */
  listKeyDetails(projectId: string): KeyDetail[] {
    const keyRows = this.db.prepare(
      "SELECT id,name,placeholder_signature,is_plural,description FROM keys WHERE project_id=? ORDER BY name",
    ).all(projectId) as { id: number; name: string; placeholder_signature: string; is_plural: number; description: string }[];
    const transRows = this.db.prepare(
      "SELECT key_id,locale,value_json,state,updated_at FROM translations WHERE project_id=?",
    ).all(projectId) as { key_id: number; locale: string; value_json: string; state: string; updated_at: string }[];
    const refRows = this.db.prepare(
      "SELECT key_id, COUNT(*) AS n FROM release_keys WHERE project_id=? GROUP BY key_id",
    ).all(projectId) as { key_id: number; n: number }[];

    const byKey = new Map<number, KeyDetail["translations"]>();
    for (const t of transRows) {
      let bucket = byKey.get(t.key_id);
      if (!bucket) { bucket = {}; byKey.set(t.key_id, bucket); }
      (bucket as Record<string, unknown>)[t.locale] = {
        value: JSON.parse(t.value_json) as TranslationValue, state: t.state, updatedAt: t.updated_at,
      };
    }
    const refs = new Map(refRows.map((r) => [r.key_id, r.n]));
    return keyRows.map((k) => ({
      name: k.name, signature: k.placeholder_signature, isPlural: !!k.is_plural, description: k.description,
      refCount: refs.get(k.id) ?? 0, translations: byKey.get(k.id) ?? {},
    }));
  }

  // ── Release ────────────────────────────────────────────────────────────────
  nextSeq(projectId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM releases WHERE project_id=?").get(projectId) as { n: number };
    return r.n;
  }
  /**
   * 릴리스 생성. `rollout`은 카나리 %(8.4) — **기본값 100(전량 배포)이 안전 기본값**이라
   * 신규 생성 경로는 이 값을 넘기지 않는다. 인자로 열어 둔 건 import(9.2) 때문이다:
   * 백업에 담긴 값을 그대로 되살리지 않으면 복원이 무손실이 아니게 된다.
   */
  createRelease(projectId: string, id: string, name: string, vm: VersionMatch, state: ReleaseState, rollout = 100): void {
    this.db.prepare(
      `INSERT INTO releases(id,project_id,name,vm_strategy,vm_value,state,rollout,seq,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(id, projectId, name, vm.strategy, vm.value, state, rollout, this.nextSeq(projectId), nowIso());
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
  /** 릴리스에 포함된 키 이름 목록(대시보드 릴리스 상세·백포트 대상 선택). */
  listReleaseKeys(projectId: string, releaseId: string): string[] {
    return (this.db.prepare(
      `SELECT k.name AS name FROM release_keys rk JOIN keys k ON k.id=rk.key_id
       WHERE rk.project_id=? AND rk.release_id=? ORDER BY k.name`,
    ).all(projectId, releaseId) as { name: string }[]).map((r) => r.name);
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

  // ── Telemetry(9.3) ───────────────────────────────────────────────────────────
  addTelemetry(projectId: string, releaseId: string, event: string, bucket: string, count: number): void {
    this.db.prepare(
      `INSERT INTO telemetry(project_id,release_id,event,app_version_bucket,count) VALUES(?,?,?,?,?)
       ON CONFLICT(project_id,release_id,event,app_version_bucket) DO UPDATE SET count = count + excluded.count`,
    ).run(projectId, releaseId, event, bucket, count);
  }
  /** (release,event)별 집계 카운트. 카나리 건전성(8.4) 입력. */
  telemetryByEvent(projectId: string, releaseId: string): Record<string, number> {
    const rows = this.db.prepare(
      "SELECT event, SUM(count) AS n FROM telemetry WHERE project_id=? AND release_id=? GROUP BY event",
    ).all(projectId, releaseId) as { event: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.event] = r.n;
    return out;
  }
  /** 대시보드 열람용 익명 집계. 원문·키·기기 식별자는 스키마상 포함하지 않는다. */
  listTelemetry(projectId: string): {
    releaseId: string;
    event: string;
    appVersionBucket: string;
    count: number;
  }[] {
    return (this.db.prepare(
      `SELECT release_id,event,app_version_bucket,count
       FROM telemetry WHERE project_id=?
       ORDER BY release_id,app_version_bucket,event`,
    ).all(projectId) as {
      release_id: string;
      event: string;
      app_version_bucket: string;
      count: number;
    }[]).map((r) => ({
      releaseId: r.release_id,
      event: r.event,
      appVersionBucket: r.app_version_bucket,
      count: r.count,
    }));
  }

  // ── 데이터 이식성(9.2) / 백업(9.4) ───────────────────────────────────────────
  /** 프로젝트 전체를 id 비의존 구조로 export(키·번역·릴리스·매핑). 락인 없음을 보증. */
  exportProject(projectId: string): ProjectExport {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`없는 프로젝트: ${projectId}`);
    const locales = (this.db.prepare("SELECT tag,fallback_parent FROM locales WHERE project_id=? ORDER BY tag").all(projectId) as any[])
      .map((r) => ({ tag: r.tag, fallbackParent: r.fallback_parent ?? null }));
    const keyRows = this.db.prepare("SELECT id,name,placeholder_signature,is_plural,description FROM keys WHERE project_id=? ORDER BY name").all(projectId) as any[];
    const keys = keyRows.map((k) => ({
      name: k.name, signature: k.placeholder_signature, isPlural: !!k.is_plural, description: k.description,
      translations: (this.db.prepare("SELECT locale,value_json,state FROM translations WHERE key_id=? ORDER BY locale").all(k.id) as any[])
        .map((t) => ({ locale: t.locale, value: JSON.parse(t.value_json) as TranslationValue, state: t.state })),
    }));
    const releases = this.listReleases(projectId).map((r) => ({
      id: r.id, name: r.name, versionMatch: r.versionMatch, state: r.state,
      base: r.base, overlay: r.overlay, rollout: r.rollout,
      keys: (this.db.prepare(
        "SELECT k.name AS name FROM release_keys rk JOIN keys k ON k.id=rk.key_id WHERE rk.project_id=? AND rk.release_id=? ORDER BY k.name",
      ).all(projectId, r.id) as any[]).map((x) => x.name),
    }));
    return { project, locales, keys, releases };
  }

  /**
   * export 구조를 (빈) DB에 import. 키 id는 새로 부여, 참조는 이름 기반으로 복원.
   *
   * **한 트랜잭션으로 묶는다** — 수십 개의 INSERT라 중간에 하나만 깨져도(릴리스 매칭 규칙 불량,
   * 로케일 중복 등) 키는 있는데 릴리스는 없는 반쪽 프로젝트가 남는다. 복원은 "됐거나 안 됐거나"
   * 둘 중 하나여야 사용자가 다시 시도할 수 있다(`deleteProject`와 같은 규칙).
   */
  importProject(data: ProjectExport): void {
    this.db.exec("BEGIN");
    try {
      this.createProject(data.project.id, data.project.name, data.project.defaultLocale, []);
      for (const l of data.locales) this.addLocale(data.project.id, l.tag, l.fallbackParent ?? undefined);
      const keyId = new Map<string, number>();
      for (const k of data.keys) {
        const id = this.upsertKey(data.project.id, k.name, k.signature, k.isPlural);
        if (k.description) this.setKeyDescription(data.project.id, k.name, k.description);
        keyId.set(k.name, id);
        for (const t of k.translations) this.putTranslation(data.project.id, id, t.locale, t.value, t.state);
      }
      for (const r of data.releases) {
        this.createRelease(data.project.id, r.id, r.name, r.versionMatch, r.state, r.rollout ?? 100);
        // `!= null` — 구 export에는 포인터 필드가 아예 없을 수 있다(undefined). `!== null`이면
        // 그때 undefined가 바인딩까지 내려가 TypeError로 터진다.
        if (r.base != null && r.overlay != null) this.updateReleasePointers(data.project.id, r.id, r.base, r.overlay);
        for (const name of r.keys) { const id = keyId.get(name); if (id !== undefined) this.addReleaseKey(data.project.id, r.id, id); }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * 기존 프로젝트에 키·번역만 upsert. 검증은 호출 전에 끝내고, 실제 쓰기는 한 트랜잭션으로 묶어
   * 대량 입력 도중 하나가 실패해도 일부 키만 반영되는 상태를 만들지 않는다.
   */
  importTranslations(projectId: string, data: TranslationImport): void {
    this.db.exec("BEGIN");
    try {
      for (const k of data.keys) {
        const id = this.upsertKey(projectId, k.name, k.signature, k.isPlural);
        if (k.description !== undefined) this.setKeyDescription(projectId, k.name, k.description);
        for (const t of k.translations) this.putTranslation(projectId, id, t.locale, t.value, t.state);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── Audit ────────────────────────────────────────────────────────────────────
  audit(projectId: string, actor: string, action: string, detail: unknown): void {
    this.db.prepare("INSERT INTO audit_log(project_id,actor,action,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(projectId, actor, action, JSON.stringify(detail ?? null), nowIso());
  }

  // ── 사용자 관리(7.3) ──────────────────────────────────────────────────────────
  // 인스턴스 수준 엔티티 — 프로젝트 export/import(9.2)에 넣지 않는다(복원에 권한이 딸려오는 사고 차단).
  createUser(id: string, name: string, role: string, projects: "*" | readonly string[]): void {
    this.db.prepare("INSERT INTO users(id,name,role,projects,disabled,created_at) VALUES(?,?,?,?,0,?)")
      .run(id, name, role, serializeScope(projects), nowIso());
  }
  getUser(id: string): UserRow | undefined {
    const r = this.db.prepare("SELECT id,name,role,projects,disabled,created_at FROM users WHERE id=?").get(id) as any;
    return r ? mapUser(r) : undefined;
  }
  /** 전체 사용자 + 토큰 요약(id·label·발급 시각 — **해시는 내보내지 않는다**). */
  listUsers(): Array<UserRow & { tokens: Array<{ id: string; label: string; createdAt: string }> }> {
    const users = (this.db.prepare("SELECT id,name,role,projects,disabled,created_at FROM users ORDER BY id").all() as any[])
      .map(mapUser);
    const tokenRows = this.db.prepare("SELECT id,user_id,label,created_at FROM user_tokens ORDER BY created_at,id").all() as
      { id: string; user_id: string; label: string; created_at: string }[];
    const byUser = new Map<string, Array<{ id: string; label: string; createdAt: string }>>();
    for (const t of tokenRows) {
      let bucket = byUser.get(t.user_id);
      if (!bucket) { bucket = []; byUser.set(t.user_id, bucket); }
      bucket.push({ id: t.id, label: t.label, createdAt: t.created_at });
    }
    return users.map((u) => ({ ...u, tokens: byUser.get(u.id) ?? [] }));
  }
  updateUser(id: string, patch: { name?: string; role?: string; projects?: "*" | readonly string[]; disabled?: boolean }): void {
    const cur = this.getUser(id);
    if (!cur) return;
    this.db.prepare("UPDATE users SET name=?, role=?, projects=?, disabled=? WHERE id=?").run(
      patch.name ?? cur.name,
      patch.role ?? cur.role,
      serializeScope(patch.projects ?? cur.projects),
      (patch.disabled ?? cur.disabled) ? 1 : 0,
      id,
    );
  }
  deleteUser(id: string): void {
    this.db.prepare("DELETE FROM users WHERE id=?").run(id); // 토큰은 FK CASCADE
  }
  /** 활성 admin 수 — 마지막 admin 강등·비활성·삭제 가드(스스로 잠그는 사고 차단) 입력. */
  countActiveAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as { n: number }).n;
  }
  addUserToken(userId: string, tokenId: string, hash: string, label: string): void {
    this.db.prepare("INSERT INTO user_tokens(id,user_id,token_hash,label,created_at) VALUES(?,?,?,?,?)")
      .run(tokenId, userId, hash, label, nowIso());
  }
  /** 토큰 폐기. 지운 행이 있으면 true — 없는 토큰은 404로 표면화할 수 있게 한다. */
  deleteUserToken(userId: string, tokenId: string): boolean {
    const r = this.db.prepare("DELETE FROM user_tokens WHERE id=? AND user_id=?").run(tokenId, userId);
    return Number(r.changes) > 0;
  }
  /** 토큰 해시 → 사용자(인증 경로, rbac.UserPrincipalSource). disabled 판정은 호출자(401) 몫. */
  findUserByTokenHash(hash: string): UserRow | undefined {
    const r = this.db.prepare(
      "SELECT u.id,u.name,u.role,u.projects,u.disabled,u.created_at FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?",
    ).get(hash) as any;
    return r ? mapUser(r) : undefined;
  }
}

/** 사용자 행 — projects는 '*'(전체) 또는 프로젝트 id 배열(rbac.Principal.projects와 대응). */
export interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly projects: "*" | string[];
  readonly disabled: boolean;
  readonly createdAt: string;
}

function serializeScope(projects: "*" | readonly string[]): string {
  return projects === "*" ? "*" : JSON.stringify(projects);
}

function mapUser(r: any): UserRow {
  return {
    id: r.id, name: r.name, role: r.role,
    projects: r.projects === "*" ? "*" : (JSON.parse(r.projects) as string[]),
    disabled: !!r.disabled, createdAt: r.created_at,
  };
}

function mapRelease(r: any): ReleaseRow {
  return {
    id: r.id, projectId: r.project_id, name: r.name,
    versionMatch: { strategy: r.vm_strategy, value: r.vm_value },
    state: r.state, base: r.base, overlay: r.overlay, rollout: r.rollout, seq: r.seq, createdAt: r.created_at,
  };
}
