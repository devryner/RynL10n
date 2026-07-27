/**
 * 관리 DB (SoT) 스키마 — 기획서 5 / 7.4. 정규화 관계형 저장(node:sqlite 내장).
 * 엔티티: Project / Locale / Key / Translation / Release, Release↔Key 다대다(백포트 대상).
 * 부가: jobs(비동기 잡), published_manifests(롤백 보존 창 8.3).
 */
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * 뒤늦게 추가된 컬럼을 기존 DB에 채우는 idempotent 마이그레이션(9.4 업그레이드).
 * `CREATE TABLE IF NOT EXISTS`는 이미 존재하는 테이블을 바꾸지 않으므로 구 DB에는 ALTER가 필요하고,
 * 신규 DB에서는 같은 ALTER가 "duplicate column"으로 실패한다 — 양쪽 모두 최종 스키마는 동일하다.
 */
const MIGRATIONS: readonly string[] = [
  // 번역자 참고용 설명(5.1) — 저작 메타데이터라 런타임 산출물에는 싣지 않는다.
  "ALTER TABLE keys ADD COLUMN description TEXT NOT NULL DEFAULT ''",
];

function migrate(db: DatabaseSync): void {
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch { /* 이미 적용된 마이그레이션 */ }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  default_locale TEXT NOT NULL
);

-- 지원 로케일(BCP 47). fallback_parent는 명시적 override(5.1), 없으면 태그 절단.
CREATE TABLE IF NOT EXISTS locales (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag            TEXT NOT NULL,
  fallback_parent TEXT,
  PRIMARY KEY (project_id, tag)
);

-- Key: 'namespace.key', 값이 아닌 '의미'의 단위. 플레이스홀더 서명·복수형 메타 보유(5.1).
-- description: 번역자 참고용 설명(화면·맥락·톤). '의미'에 속하므로 로케일별이 아니라 키 단위이며,
-- 저작 메타데이터라 런타임 스냅샷·델타에는 포함하지 않는다(11.1 해시 입력 불변 → 골든 벡터 계약 유지).
CREATE TABLE IF NOT EXISTS keys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  placeholder_signature TEXT NOT NULL DEFAULT '',
  is_plural      INTEGER NOT NULL DEFAULT 0,
  description    TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, name)
);

-- Translation: (Key, Locale) → 값. value_json은 string 또는 CLDR 복수형 맵. state로 상태 구분.
CREATE TABLE IF NOT EXISTS translations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_id         INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  locale         TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'draft',
  updated_at     TEXT NOT NULL,
  UNIQUE (key_id, locale)
);

-- Release: 격리 단위. base/overlay는 산출물 해시 포인터, state는 라이프사이클(8.1).
CREATE TABLE IF NOT EXISTS releases (
  id             TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  vm_strategy    TEXT NOT NULL,
  vm_value       TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'draft',
  base           TEXT,
  overlay        TEXT,
  rollout        INTEGER NOT NULL DEFAULT 100,
  seq            INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- Release ↔ Key 다대다(백포트가 이 참조 테이블 대상, 참조 카운트로 키 삭제 가드 5.2).
CREATE TABLE IF NOT EXISTS release_keys (
  project_id     TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  key_id         INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, release_id, key_id),
  FOREIGN KEY (project_id, release_id) REFERENCES releases(project_id, id) ON DELETE CASCADE
);

-- 비동기 잡(publish 등, 202 + GET /jobs/{id}).
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  type           TEXT NOT NULL,
  state          TEXT NOT NULL,
  progress       INTEGER NOT NULL DEFAULT 0,
  result_json    TEXT,
  created_at     TEXT NOT NULL
);

-- 롤백 보존 창(8.3): 프로젝트별 최근 published manifest 이력.
CREATE TABLE IF NOT EXISTS published_manifests (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  manifest_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);

-- 텔레메트리 집계(9.3): 옵트인·익명·집계만. 번역 값·키명·기기 식별자 없음.
-- 배포 건전성(카나리 판정 8.4 입력): 이벤트별 count를 (project,release,event,bucket)로 누적.
CREATE TABLE IF NOT EXISTS telemetry (
  project_id         TEXT NOT NULL,
  release_id         TEXT NOT NULL,
  event              TEXT NOT NULL,
  app_version_bucket TEXT NOT NULL,
  count              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, release_id, event, app_version_bucket)
);

-- 감사 로그(7.3): 누가·언제·무엇을(릴리스 단위).
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  detail_json    TEXT,
  created_at     TEXT NOT NULL
);
`;
