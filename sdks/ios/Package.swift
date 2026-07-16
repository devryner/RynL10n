// swift-tools-version: 6.0
import PackageDescription

// RynL10n iOS SDK (M1 α) — 조회 API + 런타임 로딩 + (별도) SPM 빌드 플러그인.
// 코어 알고리즘(직렬화·resolve·매칭)은 M0 TS 참조 구현과 골든 벡터로 정합성을 보장한다.
// 해싱은 CryptoKit(Apple 플랫폼). Linux CI는 추후 swift-crypto로 대체.
let package = Package(
    name: "RynL10n",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [
        .library(name: "RynL10n", targets: ["RynL10n"]),
        .executable(name: "rynl10n-bake", targets: ["rynl10n-bake"]),
        // 빌드타임 자동 번들링을 빌드 그래프에 자동 연결(차별점 ①). 소비 타깃이 plugins:에 추가.
        .plugin(name: "RynL10nBakePlugin", targets: ["RynL10nBakePlugin"]),
    ],
    targets: [
        .target(name: "RynL10n"),
        // 빌드타임 자동 번들링 CLI(6.3). build tool plugin이 이 실행파일을 prebuild로 실행한다.
        .executableTarget(name: "rynl10n-bake", dependencies: ["RynL10n"]),
        // build tool plugin: vendored 스냅샷을 prebuild에 bake(에어갭·샌드박스 적합).
        .plugin(name: "RynL10nBakePlugin", capability: .buildTool(), dependencies: ["rynl10n-bake"]),
        .testTarget(name: "RynL10nTests", dependencies: ["RynL10n"]),
    ]
)
