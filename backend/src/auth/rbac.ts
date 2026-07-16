/**
 * 인증 & RBAC — 기획서 7.3.
 * 머신(CI 플러그인)=스코프 제한 Bearer 토큰. 사람=OIDC는 통합 지점만 두고 β는 토큰 경로.
 * 역할 4종: Admin / Maintainer / Translator / Viewer.
 */

export type Role = "admin" | "maintainer" | "translator" | "viewer";

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

/** 스코프 토큰 레지스트리(β 인메모리). 프로덕션은 DB·OIDC 연동. */
export class TokenRegistry {
  private readonly tokens = new Map<string, Principal>();
  issue(token: string, principal: Principal): void { this.tokens.set(token, principal); }
  resolve(token: string): Principal | undefined { return this.tokens.get(token); }
}

/** Authorization 헤더에서 Principal 해석(없거나 미등록이면 401). */
export function authenticate(tokens: TokenRegistry, authHeader: string | undefined): Principal {
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
