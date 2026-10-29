/** Compile and run the marked README examples in disposable consumer projects. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConsumed, loadExamples, replaceOnce, take } from "./examples.ts";
import { fixture } from "./fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const channels = ["web", "ios", "android", "flutter"] as const;
type Channel = typeof channels[number];
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run check:sdk-guides -- [--only=web,ios,android,flutter] [--keep]");
  process.exit(0);
}
if (args.some((arg) => arg !== "--keep" && !arg.startsWith("--only="))) throw new Error("알 수 없는 인자입니다. --help 참조");
const selected = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",") ?? [...channels];
if (!selected.length || selected.some((id) => !channels.includes(id as Channel)) || new Set(selected).size !== selected.length) {
  throw new Error("--only에는 web,ios,android,flutter 중 중복 없는 대상을 지정하세요");
}
const examples = loadExamples(root);
const work = mkdtempSync(join(tmpdir(), "rynl10n-sdk-guides-"));
const children = new Set<ChildProcess>();
let interrupted = false;
function terminate(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* already exited */ }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  interrupted = true;
  for (const child of children) terminate(child);
});

function write(path: string, text: string) {
  const dest = join(work, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
}
function template(path: string, values: Record<string, string> = {}) {
  return readFileSync(join(here, "templates", path), "utf8").replace(/__([A-Z_]+)__/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`${path}: 템플릿 값 누락 ${key}`);
    return values[key]!;
  });
}
function example(id: string, language: string) { return take(examples, id, language); }
const swift = (id: string) => example(`ios.${id}`, "swift");
const kotlin = (id: string) => example(`android.${id}`, "kotlin");
const dart = (id: string) => example(`flutter.${id}`, "dart");
const withoutImports = (code: string) => code.split("\n").filter((line) => !line.startsWith("import ")).join("\n");
const literal = (value: string) => JSON.stringify(value).slice(1, -1);

async function run(label: string, command: string, argv: string[], directory = root, env: NodeJS.ProcessEnv = {}) {
  if (interrupted) throw new Error("중단 요청");
  console.log(`▶ ${label}`);
  const log = join(work, `${label.replace(/[^\w.-]/g, "-")}.log`);
  let output = "";
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, argv, { cwd: directory, env: { ...process.env, ...env }, detached: process.platform !== "win32" });
    children.add(child);
    const timer = setTimeout(() => { output += "\n명령 실행 제한 10분 초과\n"; terminate(child); }, 600_000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); children.delete(child); resolve(status); });
  }).finally(() => writeFileSync(log, output));
  if (code !== 0) {
    console.error(output.split(/\r?\n/).slice(-70).join("\n"));
    throw new Error(`${label} 실패 (${code ?? "signal"}), 로그: ${log}`);
  }
  console.log(`✔ ${label}`);
  return output.trim();
}
function available(command: string) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}
function requireTool(command: string) {
  if (!available(command)) throw new Error(`필수 도구 없음: ${command}. tools/sdk-guides/README.md 참조`);
}
function androidSdk(): string {
  const local = join(root, "sdks/android/local.properties");
  const configured = existsSync(local) ? /^sdk\.dir=(.+)$/m.exec(readFileSync(local, "utf8"))?.[1]?.trim().replaceAll("\\:", ":").replaceAll("\\\\", "\\") : undefined;
  for (const dir of [configured, process.env["ANDROID_HOME"], process.env["ANDROID_SDK_ROOT"]]) {
    if (dir && existsSync(join(dir, "platforms/android-35/android.jar"))) return dir;
  }
  throw new Error("Android SDK 35 필요: sdks/android/local.properties의 sdk.dir 또는 ANDROID_HOME 설정");
}
function chrome(): string {
  for (const path of [process.env["CHROME_EXECUTABLE"], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome", "chromium", "chromium-browser"]) {
    if (path && (existsSync(path) || available(path))) return path;
  }
  throw new Error("Chrome 필요: CHROME_EXECUTABLE에 실행 파일 경로를 지정하세요");
}

console.log(`SDK 가이드 검증: ${selected.join(", ")}\n작업 디렉터리: ${work}`);
let backend: Awaited<ReturnType<typeof fixture>> | undefined;
let passed = false;
try {
  for (const id of selected) {
    if (id === "web") requireTool("npm");
    if (id === "ios") {
      if (process.platform !== "darwin") throw new Error("iOS 가이드 검증은 Xcode가 있는 macOS에서 실행하세요");
      requireTool("swift"); requireTool("swiftc"); requireTool("xcrun");
    }
    if (id === "android") { requireTool("java"); androidSdk(); }
    if (id === "flutter") { requireTool("flutter"); chrome(); }
  }
  backend = await fixture(work);
  const { API, CDN } = backend;
  const endpoints = (code: string) => code.replaceAll("https://cdn.example.com", CDN).replaceAll("https://admin.example.com", API);
  const snapshot = readFileSync(join(work, "snapshot.json"), "utf8");

  for (const id of selected) {
    const dir = join(work, id);
    mkdirSync(dir, { recursive: true });
    if (id === "web") {
      for (const file of ["package.json", "package-lock.json", "tsconfig.json", "run.mjs"]) write(`web/${file}`, template(`web/${file}`));
      const names = { config: "config.ts", dom: "l10n.ts", "bundle-import": "bundle-import.ts", "bundle-fetch": "bundle-fetch.ts", cache: "cache.ts", push: "push.ts", telemetry: "telemetry.ts", react: "react.tsx" };
      for (const [name, file] of Object.entries(names)) write(`web/${file}`, example(`web.${name}`, name === "react" ? "tsx" : "ts"));
      const guide = readFileSync(join(root, "sdks/web/README.md"), "utf8");
      const version = /npm install @rynl10n\/web@(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(guide)?.[1];
      if (!version) throw new Error("Web 가이드의 npm 설치 버전을 찾지 못했습니다");
      write("web/rynl10n/snapshot.json", snapshot);
      await run("web-tools", "npm", ["ci", "--no-audit", "--no-fund"], dir);
      await run("web-sdk", "npm", ["install", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", `@rynl10n/web@${version}`], dir);
      await run("web-typecheck", join(dir, "node_modules/.bin/tsc"), ["--noEmit"], dir);
      await run("web-examples", process.execPath, ["run.mjs"], dir);
    }
    if (id === "android") {
      for (const file of ["gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties", "gradle/gradle-daemon-jvm.properties"]) {
        mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(root, "sdks/android", file), join(dir, file));
      }
      chmodSync(join(dir, "gradlew"), 0o755);
      write("android/local.properties", `sdk.dir=${androidSdk().replaceAll("\\", "\\\\").replaceAll(":", "\\:")}\n`);
      write("android/gradle.properties", "android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\n");
      for (const file of ["settings.gradle.kts", "build.gradle.kts"]) write(`android/${file}`, template(`android/${file}`));
      write("android/app/build.gradle.kts", template("android/app/build.gradle.kts", { ANDROID_DEPENDENCY: kotlin("dependency"), ANDROID_RESOURCES: kotlin("resources") }));
      write("android/app/src/main/AndroidManifest.xml", example("android.manifest", "xml"));
      for (const [name, key] of [["App", "application"], ["CatalogText", "compose"], ["MainActivity", "activity"]]) {
        write(`android/app/src/main/kotlin/guide/check/${name}.kt`, "package guide.check\n" + endpoints(kotlin(key!)));
      }
      const fragments = [kotlin("lookup"), kotlin("lifecycle"), kotlin("push")].map(endpoints);
      const imports = [...new Set(fragments.flatMap((code) => code.split("\n").filter((line) => line.startsWith("import "))))];
      write("android/app/src/main/kotlin/guide/check/Fragments.kt", `package guide.check\nimport android.content.Context\nimport android.widget.TextView\n${imports.join("\n")}\nfun fragments(context: Context, textView: TextView, count: Int) {\n${fragments.map(withoutImports).join("\n")}\n}\n`);
      write("android/app/src/main/kotlin/guide/check/Telemetry.kt", `package guide.check\nimport android.app.Application\nimport com.rynl10n.RynL10n\nfun Application.telemetry() {\n${endpoints(kotlin("telemetry"))}\n}\n`);
      write("android/app/src/main/assets/rynl10n/snapshot.json", snapshot);
      for (const test of ["GuideTest", "ComposeGuideTest"]) {
        const file = `app/src/test/kotlin/guide/check/${test}.kt`;
        write(`android/${file}`, template(`android/${file}`, { API, CDN }));
      }
      await run("android-examples", "./gradlew", ["--console=plain", ":app:assembleDebug", ":app:testDebugUnitTest"], dir);
    }
    if (id === "flutter") {
      const guide = readFileSync(join(root, "sdks/flutter/README.md"), "utf8");
      const version = /^  rynl10n: (\^?\d+\.\d+\.\d+(?:-[\w.-]+)?)$/m.exec(guide)?.[1];
      if (!version) throw new Error("Flutter 가이드의 pub.dev 설치 버전을 찾지 못했습니다");
      write("flutter/pubspec.yaml", template("flutter/pubspec.yaml", { FLUTTER_VERSION: version }));
      for (const name of ["client", "io", "web"]) write(`flutter/lib/${name}.dart`, endpoints(dart(name)));
      write("flutter/lib/automation.dart", `import 'package:rynl10n/rynl10n.dart';\nimport 'package:rynl10n/rynl10n_io.dart';\nServerPushChannel automate(RemoteDeliveryStore store, RynL10nClient client) {\n${endpoints(dart("automation"))}\nreturn push;\n}\nTelemetryReporter report(RynL10nClient client) {\n${endpoints(dart("telemetry"))}\nreturn reporter;\n}\n`);
      write("flutter/assets/rynl10n/snapshot.json", snapshot);
      for (const file of ["guide_test.dart", "web_test.dart"]) write(`flutter/test/${file}`, template(`flutter/test/${file}`));
      await run("flutter-pub", "flutter", ["pub", "get"], dir);
      await run("flutter-analyze", "flutter", ["analyze", "--fatal-infos"], dir);
      await run("flutter-examples", "flutter", ["test", "test/guide_test.dart"], dir);
      await run("flutter-browser", "flutter", ["test", "--platform", "chrome", "test/web_test.dart"], dir, { CHROME_EXECUTABLE: chrome() });
    }
    if (id === "ios") {
      const client = swift("client"), lookup = swift("lookup"), foreground = swift("foreground"), scene = swift("scene-phase");
      const delegate = swift("app-delegate"), polling = swift("polling"), push = swift("push"), app = swift("app"), telemetry = swift("telemetry"), installId = swift("install-id");
      const sdkSources = readdirSync(join(root, "sdks/ios/Sources/RynL10n")).filter((file) => file.endsWith(".swift")).map((file) => join(root, "sdks/ios/Sources/RynL10n", file));
      const sdk = await run("ios-sdk-path", "xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);
      const modules = join(dir, "modules"); mkdirSync(modules);
      const target = ["-swift-version", "6", "-sdk", sdk, "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios15.0-simulator`];
      await run("ios-sdk-module", "xcrun", ["swiftc", ...target, "-parse-as-library", "-emit-module", "-module-name", "RynL10n", "-emit-module-path", join(modules, "RynL10n.swiftmodule"), ...sdkSources]);
      write("ios/client.swift", client);
      await run("ios-client", "xcrun", ["swiftc", ...target, "-warnings-as-errors", "-parse-as-library", "-typecheck", "-I", modules, join(dir, "client.swift")]);
      write("ios/Guide.swift", template("ios/Guide.swift", { CLIENT: client, LOOKUP: lookup, FOREGROUND: foreground, SCENE: scene, DELEGATE: withoutImports(delegate), POLLING: polling, PUSH: push, APP: app, TELEMETRY: withoutImports(telemetry), INSTALL_ID: installId }));
      await run("ios-ui", "xcrun", ["swiftc", ...target, "-warnings-as-errors", "-parse-as-library", "-typecheck", "-I", modules, join(dir, "Guide.swift")]);
      const mac = join(dir, "mac-modules"); mkdirSync(mac);
      await run("ios-macos-module", "swiftc", ["-swift-version", "6", "-parse-as-library", "-emit-library", "-emit-module", "-module-name", "RynL10n", "-emit-module-path", join(mac, "RynL10n.swiftmodule"), "-o", join(mac, "libRynL10n.dylib"), ...sdkSources]);
      const configured = replaceOnce(endpoints(client), 'telemetry: "off"', 'telemetry: "aggregate"');
      const cached = replaceOnce(configured, 'project: "myapp"', `project: "myapp", cacheDirectory: URL(fileURLWithPath: "${literal(join(dir, "cache"))}")`);
      write("ios/Runtime.swift", template("ios/Runtime.swift", { CLIENT: cached, POLLING: polling, PUSH: endpoints(push), TELEMETRY: withoutImports(endpoints(telemetry)), CORE: swift("core") }));
      write("ios/Guide.app/Contents/Resources/snapshot.json", snapshot);
      write("ios/Guide.app/Contents/Info.plist", template("ios/Info.plist"));
      const binary = join(dir, "Guide.app/Contents/MacOS/Guide"); mkdirSync(dirname(binary), { recursive: true });
      await run("ios-runtime-build", "swiftc", ["-swift-version", "6", "-warnings-as-errors", "-parse-as-library", "-I", mac, "-L", mac, "-lRynL10n", "-Xlinker", "-rpath", "-Xlinker", mac, join(dir, "Runtime.swift"), "-o", binary]);
      await run("ios-runtime", binary, []);
      for (const variant of ["remote", "local"]) {
        let fields = swift(`package-${variant}`);
        if (variant === "local") fields = replaceOnce(fields, '"../RynL10n"', JSON.stringify(root));
        write(`ios/${variant}/Package.swift`, `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Guide", platforms: [.macOS(.v13), .iOS(.v15)],\n${fields})\n`);
        write(`ios/${variant}/Sources/App/Guide.swift`, client);
        await run(`ios-package-${variant}`, "swift", ["build"], join(dir, variant));
      }
      write("ios/plugin/Package.swift", `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "GuidePlugin", platforms: [.macOS(.v13)], dependencies: [.package(path: "${literal(root)}")], targets: [\n${swift("plugin-target")}])\n`);
      write("ios/plugin/Sources/App/rynl10n/release-snapshot.json", snapshot);
      write("ios/plugin/Sources/App/main.swift", template("ios/plugin.swift"));
      await run("ios-plugin", "swift", ["run", "App"], join(dir, "plugin"));
    }
  }
  assertConsumed(examples, selected);
  passed = true;
  console.log(`SDK 가이드 검증 통과: ${selected.join(", ")}`);
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  for (const child of children) terminate(child);
  await backend?.close();
  if (passed && !args.includes("--keep")) rmSync(work, { recursive: true, force: true });
  else console.log(`프로젝트·로그 보관: ${work}`);
}
