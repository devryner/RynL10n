/**
 * `resolve_preview` — 이 앱 버전에서 이 키가 실제로 무엇으로 보이는가, 그리고 **왜** 그런가
 * (MCP 도구 2/2).
 *
 * "왜 아직 옛 문구가 보이지?"의 답을 지금은 사람이 manifest → 릴리스 매칭(4.3) → 스냅샷 해시 →
 * 오버레이 override(3.1) → 서명 불일치 fallback을 눈으로 따라가야 얻는다. 그 경로를 한 번의
 * 호출로 되짚는다.
 *
 * **SDK와 같은 코드를 돌린다.** 판정은 `RynL10nClient`(src/client)가 그대로 하고 여기서는
 * 입력을 모아 주고 결과를 설명할 뿐이다 — 시뮬레이터를 따로 구현하면 실물과 갈라지는 순간
 * 도구가 거짓말을 시작한다. 그래서 이 파일에는 resolve 규칙이 한 줄도 없다.
 *
 * 관리 플레인이 배포 플레인 산출물을 **읽는** 것은 플레인 분리(4.1)를 깨지 않는다 —
 * `GET /projects/{p}/manifest`가 이미 하는 진단용 read-through와 같은 성격이고,
 * SDK 읽기 경로에 애플리케이션 서버가 끼어드는 것이 아니다.
 */
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { NotFoundError } from "../pipeline/publish.ts";
import { BadRequestError } from "../api/errors.ts";
import { RynL10nClient, buildOverlay } from "../../../src/client/client.ts";
import { selectRelease, type ClientContext } from "../../../src/core/matching.ts";
import { fallbackChain, formatValue, TOMBSTONE } from "../../../src/core/resolve.ts";
import { inRollout, bucketOf } from "../../../src/core/canary.ts";
import type { Delta, FallbackPolicy, ManifestRelease, Snapshot, TranslationValue } from "../../../src/core/types.ts";

export interface PreviewInput {
  readonly project: string;
  readonly key: string;
  readonly locale: string;
  // ── 릴리스 매칭 축(로케일 축과 다르다, 6.1). 최소 하나 필요 ──
  readonly appVersion?: string;
  readonly releaseLabel?: string;
  readonly buildNumber?: number;
  /** 앱이 빌드 시점에 구워 넣은 번들의 base 해시(lockfile). 생략하면 "방금 빌드한 앱"을 가정한다. */
  readonly bundleBase?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly fallbackPolicy?: FallbackPolicy;
  readonly matchPrerelease?: boolean;
  /** 카나리 버킷 판정용 기기 로컬 익명 id(8.4). rollout<100일 때만 의미가 있다. */
  readonly installId?: string;
}

export type DiagnosisCode =
  | "manifest_missing"
  | "no_release_matched"
  | "release_not_published"
  | "stale_bundle"
  | "bundle_unavailable"
  | "snapshot_missing"
  | "overlay_absent"
  | "canary_excluded"
  | "delta_missing"
  | "delta_base_mismatch"
  | "format_guard_fallback"
  | "tombstoned"
  | "locale_fallback"
  | "key_unresolved";

export interface Diagnosis {
  readonly code: DiagnosisCode;
  readonly detail: string;
}

export interface PreviewResult {
  readonly value: string | null;
  readonly raw: TranslationValue | null;
  readonly source: "overlay" | "bundle" | "unresolved";
  readonly matchedLocale: string | null;
  readonly localeChain: readonly string[];
  readonly guardFallback: boolean;
  readonly release: {
    readonly selection: "matched" | "nearest-lower" | "bundle-only";
    readonly id: string | null;
    readonly state: string | null;
    readonly versionMatch: ManifestRelease["versionMatch"] | null;
    readonly base: string | null;
    readonly overlay: string | null;
    readonly rollout: number | null;
  };
  /** 어떤 번들을 가정했는가. `assumed`면 호출자가 bundleBase를 주지 않아 최신 빌드로 친 것이다. */
  readonly bundle: { readonly base: string; readonly assumed: boolean };
  readonly canary: { readonly rollout: number | null; readonly inRollout: boolean; readonly bucket: number | null };
  readonly diagnosis: readonly Diagnosis[];
}

export function resolvePreview(repo: Repo, store: ArtifactStore, input: PreviewInput): PreviewResult {
  const project = repo.getProject(input.project);
  if (!project) throw new NotFoundError(`project ${input.project}`);
  if (input.appVersion === undefined && input.releaseLabel === undefined && input.buildNumber === undefined) {
    // 셋 다 없으면 selectRelease가 무조건 bundle-only로 떨어져 도구가 늘 같은 답을 낸다 —
    // 답이 아니라 질문이 잘못된 것이므로 조용히 통과시키지 않는다.
    throw new BadRequestError("appVersion · releaseLabel · buildNumber 중 최소 하나가 필요합니다(앱이 SDK에 넘기는 컨텍스트 그대로)");
  }

  const diagnosis: Diagnosis[] = [];
  const ctx: ClientContext = {
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    ...(input.releaseLabel !== undefined ? { releaseLabel: input.releaseLabel } : {}),
    ...(input.buildNumber !== undefined ? { buildNumber: input.buildNumber } : {}),
    ...(input.matchPrerelease !== undefined ? { matchPrerelease: input.matchPrerelease } : {}),
    ...(input.fallbackPolicy !== undefined ? { fallbackPolicy: input.fallbackPolicy } : {}),
  };

  const manifest = store.readManifest(input.project);
  const reader = store.deliveryReader(input.project);
  const emptyBundle: Snapshot = { schemaVersion: 1, release: "", base: "", defaultLocale: project.defaultLocale, locales: {} };

  if (!manifest) {
    diagnosis.push({ code: "manifest_missing", detail: "이 프로젝트는 아직 한 번도 게시되지 않았습니다 — 배포 플레인에 manifest가 없습니다" });
    return bundleOnlyResult(input, emptyBundle, diagnosis, true);
  }

  // 클라이언트가 하는 것과 **같은 함수**로 먼저 선택한다(번들을 고르려면 결과가 먼저 필요하다).
  const selection = selectRelease(manifest.releases, ctx);
  const release = selection.kind === "bundle-only" ? null : selection.release;

  if (release === null) {
    diagnosis.push({ code: "no_release_matched", detail: describeNoMatch(ctx) });
    // 매칭될 만한 릴리스가 draft로 남아 있는가 — manifest에는 published·superseded만 실리므로
    // manifest만 봐서는 알 수 없다. DB를 봐야 "있는데 아직 게시 안 됨"을 말해 줄 수 있다.
    for (const r of repo.listReleases(input.project)) {
      if (r.state !== "draft") continue;
      if (matchesContext(r.versionMatch, ctx)) {
        diagnosis.push({ code: "release_not_published", detail: `릴리스 ${r.id}(${r.versionMatch.strategy} ${r.versionMatch.value})가 이 컨텍스트에 맞지만 아직 draft입니다` });
      }
    }
  }

  // ── 번들 결정: 앱이 무엇을 구웠는지 서버는 모른다 ─────────────────────────────
  let bundle: Snapshot | undefined;
  let assumed = false;
  if (input.bundleBase !== undefined) {
    bundle = findSnapshotByBase(manifest.releases, reader, input.bundleBase);
    if (bundle === undefined) {
      diagnosis.push({ code: "bundle_unavailable", detail: `base ${input.bundleBase}의 스냅샷을 배포 플레인에서 찾지 못했습니다(보존 창 밖이거나 다른 프로젝트의 값)` });
    }
  }
  if (bundle === undefined) {
    assumed = true;
    bundle = (release && reader.getSnapshot(release.snapshot)) ?? emptyBundle;
  }

  if (release !== null && input.bundleBase !== undefined && !assumed && release.base !== bundle.base) {
    diagnosis.push({ code: "stale_bundle", detail: `앱 번들(base ${bundle.base})이 릴리스 ${release.id}의 base ${release.base}와 다릅니다 — 앱은 갱신 시 풀 스냅샷을 다시 받습니다` });
    if (reader.getSnapshot(release.snapshot) === undefined) {
      diagnosis.push({ code: "snapshot_missing", detail: `릴리스 스냅샷 ${release.snapshot}이 없어 갱신이 실패합니다 — 앱은 구워 넣은 번들에 머뭅니다` });
    }
  }

  // ── SDK와 같은 코드로 갱신 사이클을 돌린다 ───────────────────────────────────
  const client = new RynL10nClient({
    bundle, store: reader, context: ctx,
    locale: input.locale,
    ...(input.installId !== undefined ? { installId: input.installId } : {}),
  });
  client.refresh(manifest);

  if (release !== null) collectReleaseDiagnosis(release, bundle, reader, input, diagnosis);

  const r = client.resolve(input.key, input.locale);
  // 기본 로케일은 프로젝트 속성이라 어느 스냅샷을 활성으로 잡았든 같다(5.1).
  const chain = fallbackChain(input.locale, project.defaultLocale);

  if (r.guardFallback) {
    diagnosis.push({ code: "format_guard_fallback", detail: "오버레이 값의 플레이스홀더 서명이 번들과 달라 이 키만 번들로 되돌렸습니다(3.1) — 원격 문구가 적용되지 않습니다" });
  }
  if (r.value === undefined) {
    diagnosis.push({ code: "key_unresolved", detail: `키 "${input.key}"를 로케일 체인 ${chain.join(" → ")} 어디서도 찾지 못했습니다` });
  } else if (r.matchedLocale !== input.locale) {
    diagnosis.push({ code: "locale_fallback", detail: `"${input.locale}"에 값이 없어 "${r.matchedLocale}"로 떨어졌습니다` });
  }

  const status = client.status();
  const rollout = release?.rollout ?? null;
  const bucket = input.installId !== undefined && release !== null ? bucketOf(input.installId, release.id) : null;

  return {
    value: r.value === undefined ? null : formatValue(r.value, r.matchedLocale ?? input.locale, input.args ?? {}),
    raw: r.value ?? null,
    source: r.source,
    matchedLocale: r.matchedLocale ?? null,
    localeChain: chain,
    guardFallback: r.guardFallback,
    release: {
      selection: selection.kind,
      id: status.releaseId ?? null,
      state: release?.state ?? null,
      versionMatch: release?.versionMatch ?? null,
      base: release?.base ?? null,
      overlay: release?.overlay ?? null,
      rollout,
    },
    bundle: { base: bundle.base, assumed },
    canary: { rollout, inRollout: release === null ? false : inRollout(release.rollout, input.installId, release.id), bucket },
    diagnosis,
  };
}

/** 매칭된 릴리스에서 오버레이가 적용되지 않는 원인들 — `refresh()`의 조기 반환 지점과 1:1이다. */
function collectReleaseDiagnosis(
  release: ManifestRelease,
  bundle: Snapshot,
  reader: { getSnapshot(p: string): Snapshot | undefined; getDelta(p: string): Delta | undefined },
  input: PreviewInput,
  out: Diagnosis[],
): void {
  if (release.overlay === release.base || release.delta === undefined) {
    out.push({ code: "overlay_absent", detail: `릴리스 ${release.id}에 적용할 오버레이가 없습니다(overlay 포인터가 base와 같음) — 스냅샷 그대로입니다` });
    return;
  }
  if (!inRollout(release.rollout, input.installId, release.id)) {
    out.push({
      code: "canary_excluded",
      detail: input.installId === undefined
        ? `rollout ${release.rollout}%인데 installId가 없어 카나리 대상에서 제외됩니다(보수적 기본값, 8.4)`
        : `installId ${input.installId}는 버킷 ${bucketOf(input.installId, release.id)}이라 rollout ${release.rollout}% 밖입니다`,
    });
    return;
  }
  const delta = reader.getDelta(release.delta);
  if (delta === undefined) {
    out.push({ code: "delta_missing", detail: `델타 ${release.delta}를 배포 플레인에서 찾지 못했습니다 — 앱은 이전 상태를 유지합니다` });
    return;
  }
  // 활성 번들이 릴리스 base로 교체된 뒤에 검사한다 — 클라이언트도 그 순서다.
  const active = release.base !== bundle.base ? (reader.getSnapshot(release.snapshot) ?? bundle) : bundle;
  if (delta.from !== active.base) {
    out.push({ code: "delta_base_mismatch", detail: `델타의 from(${delta.from})이 활성 번들 base(${active.base})와 달라 적용이 거부됩니다(6.4 원자성)` });
    return;
  }
  const overlay = buildOverlay(delta);
  for (const loc of fallbackChain(input.locale, active.defaultLocale)) {
    if (overlay.get(loc, input.key) === TOMBSTONE) {
      out.push({ code: "tombstoned", detail: `오버레이가 (${loc}, ${input.key})를 삭제 마커로 가립니다 — 그 로케일에서는 번들 값도 보이지 않습니다` });
      break;
    }
  }
}

function findSnapshotByBase(
  releases: readonly ManifestRelease[],
  reader: { getSnapshot(p: string): Snapshot | undefined },
  base: string,
): Snapshot | undefined {
  for (const r of releases) {
    const snap = reader.getSnapshot(r.snapshot);
    if (snap?.base === base) return snap;
  }
  return undefined;
}

function matchesContext(vm: ManifestRelease["versionMatch"], ctx: ClientContext): boolean {
  // 같은 판정을 쓰기 위해 선택기를 그대로 재사용한다 — published인 척 껍데기를 하나 넣는다.
  const shell: ManifestRelease = { id: "?", state: "published", versionMatch: vm, base: "", overlay: "", rollout: 100, snapshot: "" };
  return selectRelease([shell], { ...ctx, fallbackPolicy: "bundle-only" }).kind === "matched";
}

function describeNoMatch(ctx: ClientContext): string {
  const given = [
    ctx.appVersion !== undefined ? `appVersion=${ctx.appVersion}` : null,
    ctx.releaseLabel !== undefined ? `releaseLabel=${ctx.releaseLabel}` : null,
    ctx.buildNumber !== undefined ? `buildNumber=${ctx.buildNumber}` : null,
  ].filter(Boolean).join(" · ");
  return `게시된 릴리스 중 이 컨텍스트(${given})에 맞는 것이 없습니다 — 앱은 구워 넣은 번들만 씁니다`;
}

function bundleOnlyResult(input: PreviewInput, bundle: Snapshot, diagnosis: Diagnosis[], assumed: boolean): PreviewResult {
  const chain = fallbackChain(input.locale, bundle.defaultLocale);
  diagnosis.push({ code: "key_unresolved", detail: `배포 산출물이 없어 키 "${input.key}"를 해석할 수 없습니다` });
  return {
    value: null, raw: null, source: "unresolved", matchedLocale: null, localeChain: chain, guardFallback: false,
    release: { selection: "bundle-only", id: null, state: null, versionMatch: null, base: null, overlay: null, rollout: null },
    bundle: { base: bundle.base, assumed },
    canary: { rollout: null, inRollout: false, bucket: null },
    diagnosis,
  };
}
