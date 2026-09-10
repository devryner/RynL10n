import PackagePlugin
import Foundation

/// 빌드타임 자동 번들링 SPM build tool plugin — 기획서 3.2 / 6.3 (차별점 ①).
/// 소비 타깃의 `rynl10n/release-snapshot.json`(vendored 스냅샷)을 bake해 SDK 번들 리소스로 생성한다.
/// 네트워크 없이 동작(빌드 샌드박스·에어갭 적합). 서버 fetch 모드는 CLI(`rynl10n-bake --fetch`)로 CI에서 별도 실행.
///
/// **SwiftPM 타깃과 Xcode 프로젝트 타깃 양쪽을 지원한다** — Xcode의 앱 타깃에 적용하려면 플러그인이
/// `XcodeBuildToolPlugin`을 따로 구현해야 하며(`BuildToolPlugin`만으로는 Xcode 타깃에 붙지 않는다),
/// 아래 `#if canImport(XcodeProjectPlugin)` 블록이 그 경로다.
@main
struct RynL10nBakePlugin: BuildToolPlugin {
    /// vendored 스냅샷의 관례 경로(두 환경 공통).
    static let vendoredSuffix = "rynl10n/release-snapshot.json"

    /// bake 명령 하나를 구성한다. 입력이 없으면 nil(플러그인을 붙여둬도 안전하게 무동작).
    ///
    /// `PackagePlugin.Path` 가 아니라 `URL` 을 쓴다 — swift-tools 6.0 에서 `Path` 계열
    /// (`Tool.path`·`pluginWorkDirectory`·`Path.appending(subpath:)`·`Path.string`)이 전부 폐기돼
    /// 소비 앱의 빌드 로그에 경고 14건이 찍혔다. CLI 인자는 문자열이므로 `path(percentEncoded: false)`
    /// 로 푼다(퍼센트 인코딩을 그대로 두면 공백·한글 경로에서 파일을 못 찾는다).
    static func bakeCommand(input: URL, workDirectory: URL, tool: PluginContext.Tool) -> Command {
        let bundleDir = workDirectory.appending(path: "rynl10n")
        // buildCommand(prebuild 아님): 소스 빌드 실행파일 사용 가능. 고정 출력명(--stable-name)으로 선언.
        return .buildCommand(
            displayName: "RynL10n: vendored 스냅샷 bake",
            executable: tool.url,
            arguments: [input.path(percentEncoded: false), workDirectory.path(percentEncoded: false), "--stable-name"],
            inputFiles: [input],
            outputFiles: [bundleDir.appending(path: "snapshot.json"),
                          bundleDir.appending(path: "rynl10n.lock")]
        )
    }

    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        // `Target.directoryURL` 은 tools 6.1 부터라 6.0 매니페스트에선 못 쓴다 — 구체 타입에는
        // 6.0 부터 있으니 그쪽으로 받는다. tools-version 을 올리면 소비자의 최소 Xcode 가 따라 오른다.
        let directoryURL: URL
        switch target {
        case let swift as SwiftSourceModuleTarget: directoryURL = swift.directoryURL
        case let clang as ClangSourceModuleTarget: directoryURL = clang.directoryURL
        default: return []
        }
        let input = directoryURL.appending(path: Self.vendoredSuffix)
        // vendored 스냅샷이 없으면 조용히 스킵(플러그인 적용해도 안전).
        guard FileManager.default.fileExists(atPath: input.path(percentEncoded: false)) else { return [] }
        return [Self.bakeCommand(input: input,
                                 workDirectory: context.pluginWorkDirectoryURL,
                                 tool: try context.tool(named: "rynl10n-bake"))]
    }
}

#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

/// Xcode 앱 타깃 경로 — Xcode 프로젝트에는 SwiftPM의 `Sources/<Target>/` 레이아웃이 없으므로
/// 타깃의 입력 파일 목록에서 `rynl10n/release-snapshot.json`을 찾는다.
/// 연결 방법: 앱 타깃 → Build Phases → **Run Build Tool Plug-ins**에 RynL10nBakePlugin 추가.
extension RynL10nBakePlugin: XcodeBuildToolPlugin {
    func createBuildCommands(context: XcodePluginContext, target: XcodeTarget) throws -> [Command] {
        let input = target.inputFiles.first { $0.url.path(percentEncoded: false).hasSuffix(Self.vendoredSuffix) }?.url
        // 스냅샷을 타깃 멤버십에 넣지 않았을 수도 있다 → 그때는 조용히 스킵(빌드는 계속).
        guard let input else { return [] }
        return [Self.bakeCommand(input: input,
                                 workDirectory: context.pluginWorkDirectoryURL,
                                 tool: try context.tool(named: "rynl10n-bake"))]
    }
}
#endif
