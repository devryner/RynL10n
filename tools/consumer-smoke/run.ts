/**
 * 소비자 스모크 — **게시본**을 저장소 밖 빈 프로젝트에서 실 좌표로 설치해 `t()`까지 굴린다.
 *
 * 실행: `npm run smoke:consumer -- [--version=0.1.0] [--only=npm,pub,maven,spm] [--keep]`
 *
 * 게시가 끝났다는 것과 소비자가 실제로 받아 쓸 수 있다는 것은 다른 명제다. 그 사이에는 게시본에만
 * 있는 실패가 산다 — 패키징에서 빠진 파일, `.d.ts` 경로가 어긋난 `exports`, POM이 못 끌고 오는
 * 전이 의존성, 태그가 매니페스트 없는 커밋을 가리키는 경우. 저장소 안 테스트는 전부 **소스**를
 * 보므로 이 층을 통째로 통과시킨다.
 *
 * **소비자 쪽 저장소 선언에 `mavenLocal()`·`file:`·`path:`를 두지 않는 것이 이 검증의 전부다.**
 * 하나라도 남으면 로컬 산출물을 집어 레지스트리를 건드리지 않고 통과한다.
 *
 * 검증 케이스는 네 언어가 **같은 `checks.json`을 읽어** 실행한다(아래 CHECKS). 언어마다 케이스를
 * 따로 적으면 조용히 갈라지고, 갈라진 쪽이 통과해도 아무도 모른다 — 골든 벡터와 같은 이유다.
 *
 * 자세한 배경·요구 도구는 `tools/consumer-smoke/README.md`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TEMPLATES = join(HERE, "templates");

/** 네 언어가 공유하는 검증 케이스. 축을 늘리려면 여기만 고친다. */
const CHECKS = [
  { name: "기본 로케일 조회", key: "home.title", args: {}, locale: null, expect: "Home" },
  { name: "호출 인자 로케일 우선", key: "home.title", args: {}, locale: "ko", expect: "홈" },
  { name: "플레이스홀더 치환", key: "greet", args: { name: "세계" }, locale: null, expect: "Hello 세계" },
  { name: "복수형 one", key: "cart.items", args: { n: 1 }, locale: null, expect: "1 item" },
  { name: "복수형 other", key: "cart.items", args: { n: 3 }, locale: null, expect: "3 items" },
  // ko에 greet이 없어 ko-KR → ko → 기본 로케일로 절단된다(3.1 로케일 우선 원칙).
  { name: "로케일 fallback 체인", key: "greet", args: { name: "x" }, locale: "ko-KR", expect: "Hello x" },
];

// ── 인자 ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const keep = flag("keep") !== undefined;
const only = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);

// ── 버전 (lockstep) ───────────────────────────────────────────────────────────────────────────
/** 세 매니페스트에서 버전을 읽는다. iOS는 매니페스트에 버전이 없다 — SPM은 태그가 곧 버전이다. */
function manifestVersions(): Record<string, string> {
  const web = JSON.parse(readFileSync(join(ROOT, "sdks/web/package.json"), "utf8")).version as string;
  const flutter = /^version:\s*(.+)$/m.exec(readFileSync(join(ROOT, "sdks/flutter/pubspec.yaml"), "utf8"))?.[1]?.trim();
  const android = /rynl10nVersion\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "sdks/android/library/build.gradle.kts"), "utf8"))?.[1];
  return { web, flutter: flutter ?? "?", android: android ?? "?" };
}

const versions = manifestVersions();
const distinct = [...new Set(Object.values(versions))];
if (distinct.length !== 1) {
  console.error(`lockstep이 깨졌습니다 — ${JSON.stringify(versions)}`);
  process.exit(1);
}
const version = flag("version") || distinct[0]!;
const fromManifest = version === distinct[0];

// ── 작업 디렉토리 ─────────────────────────────────────────────────────────────────────────────
const workdir = flag("dir") || mkdtempSync(join(tmpdir(), "rynl10n-smoke-"));
mkdirSync(workdir, { recursive: true });

/** 골든 벡터의 스냅샷을 그대로 쓴다 — 스모크용 픽스처를 따로 두면 그쪽이 먼저 낡는다. */
const snapshot = JSON.stringify(JSON.parse(readFileSync(join(ROOT, "fixtures/golden/convert.json"), "utf8")).snapshot, null, 2);

/** 템플릿을 복사하며 `__VERSION__`을 치환하고, 각 프로젝트에 스냅샷·검증 케이스를 떨군다. */
function scaffold(template: string, dest: string, versionLiteral: string): void {
  cpSync(join(TEMPLATES, template), dest, { recursive: true });
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const before = readFileSync(p, "utf8");
      if (before.includes("__VERSION__")) writeFileSync(p, before.replaceAll("__VERSION__", versionLiteral));
    }
  };
  walk(dest);
  writeFileSync(join(dest, "snapshot.json"), snapshot);
  writeFileSync(join(dest, "checks.json"), JSON.stringify(CHECKS, null, 2));
}

// ── 도구 탐지 ─────────────────────────────────────────────────────────────────────────────────
function has(cmd: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

function androidSdk(): string | undefined {
  for (const env of [process.env["ANDROID_HOME"], process.env["ANDROID_SDK_ROOT"]]) {
    if (env && existsSync(join(env, "platforms", "android-35"))) return env;
  }
  return undefined;
}

// ── 채널 ──────────────────────────────────────────────────────────────────────────────────────
type Step = { label: string; cmd: string; args: string[] };
type Channel = {
  id: string;
  label: string;
  coord: string;
  skip(): string | undefined; // 건너뛸 이유(없으면 undefined)
  prepare(dir: string): void;
  steps: Step[];
};

const CHANNELS: Channel[] = [
  {
    id: "npm",
    label: "npm",
    coord: `@rynl10n/web@${version}`,
    skip: () => (has("npm") ? undefined : "npm 없음"),
    prepare: (dir) => scaffold("web", dir, version),
    steps: [
      { label: "install", cmd: "npm", args: ["install", "--no-audit", "--no-fund", "--silent"] },
      { label: "타입 해석(.d.ts)", cmd: "npx", args: ["tsc", "--noEmit", "-p", "tsconfig.json"] },
      { label: "실행", cmd: "node", args: ["smoke.mjs"] },
    ],
  },
  {
    id: "pub",
    label: "pub.dev",
    coord: `rynl10n ${version}`,
    skip: () => (has("dart") ? undefined : "dart 없음"),
    prepare: (dir) => scaffold("dart", dir, `^${version}`),
    steps: [
      { label: "pub get", cmd: "dart", args: ["pub", "get"] },
      { label: "실행", cmd: "dart", args: ["run", "smoke.dart"] },
    ],
  },
  {
    id: "maven",
    label: "Maven Central",
    coord: `com.devryner.rynl10n:android:${version}`,
    skip: () => {
      if (!has("java")) return "java 없음";
      if (!androidSdk()) return "Android SDK(platforms/android-35) 없음";
      return undefined;
    },
    prepare: (dir) => {
      scaffold("android", dir, version);
      // Gradle 래퍼는 sdks/android 것을 그대로 쓴다(8.11.1 — AGP 8.7.3과 짝). 소비자에게
      // 시스템 gradle 설치를 요구하지 않기 위해서다.
      mkdirSync(join(dir, "gradle", "wrapper"), { recursive: true });
      for (const f of ["gradlew", "gradlew.bat"]) cpSync(join(ROOT, "sdks/android", f), join(dir, f));
      for (const f of ["gradle-wrapper.jar", "gradle-wrapper.properties"]) {
        cpSync(join(ROOT, "sdks/android/gradle/wrapper", f), join(dir, "gradle", "wrapper", f));
      }
      chmodSync(join(dir, "gradlew"), 0o755);
      // 유닛 테스트의 작업 디렉토리는 모듈 디렉토리다.
      for (const f of ["snapshot.json", "checks.json"]) cpSync(join(dir, f), join(dir, "consumer", f));
    },
    steps: [
      { label: "유닛 테스트", cmd: "./gradlew", args: [":consumer:testDebugUnitTest", "--no-daemon", "--console=plain"] },
    ],
  },
  {
    id: "spm",
    label: "SwiftPM",
    coord: `devryner/RynL10n @ ${version} (태그 v${version})`,
    skip: () => (has("swift") ? undefined : "swift 없음"),
    prepare: (dir) => scaffold("swift", dir, version),
    steps: [{ label: "resolve + 빌드 + 실행", cmd: "swift", args: ["run"] }],
  },
];

// ── 실행 ──────────────────────────────────────────────────────────────────────────────────────
console.log(`RynL10n 소비자 스모크 — 버전 ${version}${fromManifest ? " (매니페스트 lockstep)" : " (--version 지정)"}`);
console.log(`작업 디렉토리: ${workdir}\n`);

type Result = { channel: Channel; state: "pass" | "fail" | "skip"; detail: string };
const results: Result[] = [];

for (const channel of CHANNELS) {
  if (only && !only.includes(channel.id)) continue;

  const reason = channel.skip();
  if (reason) {
    console.log(`— ${channel.label} … SKIP (${reason})\n`);
    results.push({ channel, state: "skip", detail: reason });
    continue;
  }

  console.log(`— ${channel.label} — ${channel.coord}`);
  const dir = join(workdir, channel.id);
  mkdirSync(dir, { recursive: true });
  channel.prepare(dir);

  let failed = "";
  let passes = 0;
  for (const step of channel.steps) {
    const run = spawnSync(step.cmd, step.args, { cwd: dir, encoding: "utf8", env: process.env });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    for (const line of output.split("\n")) {
      const check = /^\s*(PASS|FAIL)\s+(.*)$/.exec(line);
      if (check) {
        console.log(`    ${check[1]}  ${check[2]}`);
        if (check[1] === "PASS") passes++; else failed ||= "검증 케이스 실패";
      }
    }
    if (run.status !== 0) {
      failed ||= `${step.label} 실패 (exit ${run.status ?? "signal"})`;
      // 위에서 이미 출력한 검증 케이스 줄은 뺀다 — 같은 줄이 두 번 나오면 무엇이 원인인지 흐려진다.
      const tail = output.split("\n").filter((l) => !/^\s*(PASS|FAIL)\s/.test(l)).slice(-25);
      console.log(tail.map((l) => `    │ ${l}`).join("\n"));
      break;
    }
  }
  if (!failed && passes !== CHECKS.length) failed = `검증 케이스 ${passes}/${CHECKS.length}만 실행됨`;

  console.log(failed ? `  ✗ ${failed}\n` : `  ✓ ${passes}/${CHECKS.length} 통과\n`);
  results.push({ channel, state: failed ? "fail" : "pass", detail: failed || `${passes}/${CHECKS.length}` });
}

// ── 요약 ──────────────────────────────────────────────────────────────────────────────────────
console.log("요약");
for (const r of results) {
  const mark = r.state === "pass" ? "✓" : r.state === "fail" ? "✗" : "-";
  console.log(`  ${mark} ${r.channel.label.padEnd(14)} ${r.detail}`);
}

const skipped = results.filter((r) => r.state === "skip").length;
if (skipped) console.log(`\n${skipped}개 채널을 건너뛰었습니다 — 도구가 없는 채널은 검증되지 않은 것이지 통과한 것이 아닙니다.`);

if (keep) console.log(`\n작업 디렉토리를 남겨 둡니다: ${workdir}`);
else if (!flag("dir")) rmSync(workdir, { recursive: true, force: true });

process.exit(results.some((r) => r.state === "fail") ? 1 : 0);
