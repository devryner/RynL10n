// swift-tools-version: 6.0
import PackageDescription

// RynL10n build tool plugin 소비 예제 — 플러그인 한 줄로 빌드타임 자동 번들링(차별점 ①).
let package = Package(
    name: "Consumer",
    platforms: [.macOS(.v13)],
    dependencies: [
        // 경로 의존의 패키지 이름은 디렉토리 이름에서 온다 — 서브모듈로 `core/` 같은 곳에 체크아웃되면
        // "RynL10n"이 아니게 되어 아래 `package: "RynL10n"`을 못 찾는다. 이름을 못박아 둔다.
        .package(name: "RynL10n", path: "../.."),
    ],
    targets: [
        .executableTarget(
            name: "Consumer",
            dependencies: [.product(name: "RynL10n", package: "RynL10n")],
            exclude: ["rynl10n"], // vendored 스냅샷은 플러그인이 직접 읽음(SPM 리소스 처리 제외)
            plugins: [.plugin(name: "RynL10nBakePlugin", package: "RynL10n")] // ← 이 한 줄이면 끝
        ),
    ]
)
