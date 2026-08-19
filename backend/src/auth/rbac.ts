/**
 * 인증 & RBAC — 기획서 7.3.
 * 머신(CI 플러그인)=스코프 제한 Bearer 토큰. 사람=OIDC는 통합 지점만 두고 β는 토큰 경로.
 * 역할 4종: Admin / Maintainer / Translator / Viewer.
 */
import { createHash } from "node:crypto";

export type Role = "admin" | "maintainer" | "translator" | "viewer";

/** 역할 목록(런타임 검증용) — 사용자 관리 API가 입력 role을 이 목록으로 판정한다. */
export const ROLES: readonly Role[] = ["admin", "maintainer", "translator", "viewer"];

/** 능력(capability) — 라우트가 요구하는 최소 권한. */
export type Capability = "read" | "edit_translation" | "manage_release" | "admin";

const ROLE_CAPS: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set(["read"]),
  translator: new Set(["read", "edit_translation"]),
  maintainer: new Set(["read", "edit_translation", "manage_release"]),
  admin: new Set(["read", "edit_translation", "manage_release", "admin"]),
};

export interface Principal {
  readonly actor: string;
  readonly role: Role;
  /** 접근 가능한 프로젝트 id 집합, 또는 '*'(전체). */
  readonly projects: ReadonlySet<string> | "*";
}

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) { super(message); this.name = "AuthError"; this.status = status; }
}

/** 토큰 → Principal 해석기 계약. TokenRegistry(인메모리)와 DbTokenRegistry(영속)가 이 표면을 공유한다. */
export interface PrincipalResolver {
  resolve(token: string): Principal | undefined;
}

/** 스코프 토큰 레지스트리(β 인메모리). 부트스트랩 env 토큰·테스트가 이 경로를 쓴다. */
export class TokenRegistry implements PrincipalResolver {
  private readonly tokens = new Map<string, Principal>();
  issue(token: string, principal: Principal): void { this.tokens.set(token, principal); }
  resolve(token: string): Principal | undefined { return this.tokens.get(token); }
}

/** 토큰 평문 → 저장 해시(sha256 hex). DB에는 이 값만 남는다 — 평문은 발급 응답 1회 노출. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** DbTokenRegistry가 필요로 하는 사용자 조회 표면 — Repo가 구조적으로 만족한다(순환 의존 차단). */
export interface UserPrincipalSource {
  findUserByTokenHash(hash: string): {
    readonly id: string;
    readonly role: string;
    readonly projects: "*" | readonly string[];
    readonly disabled: boolean;
  } | undefined;
}

/**
 * DB 기반 토큰 해석(사용자 관리 기능의 인증 이음새).
 *
 * 순서: ① 부트스트랩 레지스트리(env 토큰 — 첫 admin을 만들 수단, 닭-달걀 방지) →
 * ② sha256(token)으로 user_tokens 조회. disabled 사용자·미등록 역할은 미해석(=401)으로 처리해
 * 폐기·비활성이 **즉시** 효력을 갖는다(세션 캐시 없음).
 */
export class DbTokenRegistry implements PrincipalResolver {
  private readonly users: UserPrincipalSource;
  private readonly bootstrap: PrincipalResolver | undefined;
  constructor(users: UserPrincipalSource, bootstrap?: PrincipalResolver) {
    this.users = users;
    this.bootstrap = bootstrap;
  }
  resolve(token: string): Principal | undefined {
    const boot = this.bootstrap?.resolve(token);
    if (boot) return boot;
    const u = this.users.findUserByTokenHash(tokenHash(token));
    if (!u || u.disabled) return undefined;
    if (!(ROLES as readonly string[]).includes(u.role)) return undefined; // 손상된 role 값은 통과시키지 않는다
    return { actor: u.id, role: u.role as Role, projects: u.projects === "*" ? "*" : new Set(u.projects) };
  }
}

/** Authorization 헤더에서 Principal 해석(없거나 미등록이면 401). */
export function authenticate(tokens: PrincipalResolver, authHeader: string | undefined): Principal {
  if (!authHeader?.startsWith("Bearer ")) throw new AuthError(401, "Bearer 토큰 필요");
  const p = tokens.resolve(authHeader.slice("Bearer ".length).trim());
  if (!p) throw new AuthError(401, "유효하지 않은 토큰");
  return p;
}

/** capability + 프로젝트 스코프 검사(부족하면 403). */
export function authorize(p: Principal, cap: Capability, projectId: string | undefined): void {
  if (!ROLE_CAPS[p.role].has(cap)) throw new AuthError(403, `역할 ${p.role}에 ${cap} 권한 없음`);
  if (projectId !== undefined && p.projects !== "*" && !p.projects.has(projectId)) {
    throw new AuthError(403, `프로젝트 ${projectId} 접근 권한 없음`);
  }
}
