// swift-tools-version: 6.0
import PackageDescription

// SPM은 레지스트리가 없다 — **태그가 곧 배포**다(6.5). 그래서 좌표는 저장소 URL + 버전이고,
// 여기에 로컬 체크아웃(.package(path:))을 절대 쓰지 않는다. 쓰는 순간 게시본이 아니라
// 작업 트리를 검증하게 된다.
let package = Package(
    name: "Smoke",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/devryner/RynL10n", from: "__VERSION__")
    ],
    targets: [
        .executableTarget(name: "Smoke", dependencies: [.product(name: "RynL10n", package: "RynL10n")])
    ]
)
