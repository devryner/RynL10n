import PackagePlugin
import Foundation

/// 빌드타임 자동 번들링 SPM build tool plugin — 기획서 3.2 / 6.3 (차별점 ①).
/// 소비 타깃의 `Sources/<Target>/rynl10n/release-snapshot.json`(vendored 스냅샷)을 prebuild에서 bake해
/// SDK 번들 리소스로 생성한다. 네트워크 없이 동작(SPM prebuild 샌드박스·에어갭 적합).
/// 서버 fetch 모드는 CLI(`rynl10n-bake --fetch`)로 CI에서 별도 실행.
@main
struct RynL10nBakePlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        guard let src = target as? SourceModuleTarget else { return [] }
        let input = src.directory.appending(subpath: "rynl10n/release-snapshot.json")
        // vendored 스냅샷이 없으면 조용히 스킵(플러그인 적용해도 안전).
        guard FileManager.default.fileExists(atPath: input.string) else { return [] }

        let outDir = context.pluginWorkDirectory
        let tool = try context.tool(named: "rynl10n-bake")
        // buildCommand(prebuild 아님): 소스 빌드 실행파일 사용 가능. 고정 출력명(--stable-name)으로 선언.
        let bundleDir = outDir.appending(subpath: "rynl10n")
        return [
            .buildCommand(
                displayName: "RynL10n: vendored 스냅샷 bake",
                executable: tool.path,
                arguments: [input.string, outDir.string, "--stable-name"],
                inputFiles: [input],
                outputFiles: [bundleDir.appending(subpath: "snapshot.json"), bundleDir.appending(subpath: "rynl10n.lock")]
            )
        ]
    }
}
