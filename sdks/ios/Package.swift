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
    ],
    targets: [
        .target(name: "RynL10n"),
        .testTarget(name: "RynL10nTests", dependencies: ["RynL10n"]),
    ]
)
