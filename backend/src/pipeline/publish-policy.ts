/** 프로젝트가 선택한 게시 품질 정책. 초안을 빼서 게시하지 않고 릴리스 전체를 차단한다. */
import type { Repo, ProjectRow } from "../db/repo.ts";
import { BadRequestError } from "../api/errors.ts";

export interface PublishPolicy {
  readonly requireReviewed: boolean;
  readonly requireDefaultLocale: boolean;
}
export const DEFAULT_PUBLISH_POLICY: PublishPolicy = Object.freeze({ requireReviewed: false, requireDefaultLocale: false });

export interface PublishPolicyIssue {
  readonly code: "unreviewed_translation" | "default_locale_missing";
  readonly key: string;
  readonly locale: string;
}
export interface PublishCheck {
  readonly ok: boolean;
  readonly policy: PublishPolicy;
  readonly issues: readonly PublishPolicyIssue[];
}

/** 전체 정책 객체를 받는다. 잘못 적은 플래그가 조용히 무시되면 게시 가드가 풀린다. */
export function requirePublishPolicy(value: unknown): PublishPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError("publishPolicy는 requireReviewed·requireDefaultLocale boolean 객체여야 합니다");
  }
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).length !== 2 || !Object.hasOwn(policy, "requireReviewed") || !Object.hasOwn(policy, "requireDefaultLocale")
    || Object.keys(policy).some((key) => key !== "requireReviewed" && key !== "requireDefaultLocale")
    || typeof policy.requireReviewed !== "boolean" || typeof policy.requireDefaultLocale !== "boolean") {
    throw new BadRequestError("publishPolicy에는 requireReviewed·requireDefaultLocale boolean 둘만 필요합니다");
  }
  return { requireReviewed: policy.requireReviewed, requireDefaultLocale: policy.requireDefaultLocale };
}

/** 미리보기와 실제 publish가 같은 release key·지원 locale 범위를 검사한다. */
export function checkPublishPolicy(repo: Repo, project: ProjectRow, releaseId: string): PublishCheck {
  const policy = project.publishPolicy;
  const issues: PublishPolicyIssue[] = [];
  if (!policy.requireReviewed && !policy.requireDefaultLocale) return { ok: true, policy, issues };
  const keys = new Set(repo.listReleaseKeys(project.id, releaseId));
  const locales = new Set(repo.listLocales(project.id));
  for (const key of repo.listKeyDetails(project.id)) {
    if (!keys.has(key.name)) continue;
    if (policy.requireDefaultLocale && !Object.hasOwn(key.translations, project.defaultLocale)) {
      issues.push({ code: "default_locale_missing", key: key.name, locale: project.defaultLocale });
    }
    if (policy.requireReviewed) {
      for (const locale of Object.keys(key.translations).sort()) {
        if (locales.has(locale) && key.translations[locale]!.state !== "reviewed") {
          issues.push({ code: "unreviewed_translation", key: key.name, locale });
        }
      }
    }
  }
  return { ok: issues.length === 0, policy, issues };
}

export class PublishPolicyError extends Error {
  readonly status = 422;
  readonly publishCheck: PublishCheck;
  constructor(check: PublishCheck) {
    const details = check.issues.slice(0, 10).map((issue) =>
      `${issue.code === "default_locale_missing" ? "기본 로케일 누락" : "미검수 번역"}: ${issue.key}(${issue.locale})`);
    super(`게시 품질 정책을 충족하지 못했습니다 — ${details.join(" · ")}${check.issues.length > 10 ? ` 외 ${check.issues.length - 10}건` : ""}`);
    this.name = "PublishPolicyError";
    this.publishCheck = check;
  }
}
