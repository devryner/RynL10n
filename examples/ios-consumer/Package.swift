// swift-tools-version: 6.0
import PackageDescription

// RynL10n build tool plugin 소비 예제 — 플러그인 한 줄로 빌드타임 자동 번들링(차별점 ①).
let package = Package(
    name: "Consumer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../sdks/ios"),
    ],
    targets: [
        .executableTarget(
            name: "Consumer",
            dependencies: [.product(name: "RynL10n", package: "ios")],
            exclude: ["rynl10n"], // vendored 스냅샷은 플러그인이 직접 읽음(SPM 리소스 처리 제외)
            plugins: [.plugin(name: "RynL10nBakePlugin", package: "ios")] // ← 이 한 줄이면 끝
        ),
    ]
)
