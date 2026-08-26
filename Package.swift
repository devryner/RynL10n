// swift-tools-version: 6.0
import PackageDescription

// RynL10n iOS SDK — 조회 API + 런타임 로딩 + (별도) SPM 빌드 플러그인.
// 코어 알고리즘(직렬화·resolve·매칭)은 M0 TS 참조 구현과 골든 벡터로 정합성을 보장한다.
// 해싱은 CryptoKit(Apple 플랫폼). Linux CI는 추후 swift-crypto로 대체.
//
// **이 매니페스트가 왜 저장소 루트에 있는가**(6.5): SwiftPM은 저장소 루트의 `Package.swift`만
// 패키지로 인식한다 — `.package(url:)`에 하위 경로를 줄 수 없다(swift-package-manager#5768은
// 2022년에 닫혔고 Swift 6.3에도 `subdir` 문법이 없다). 반면 **소스 위치는 자유롭다.**
// 그래서 매니페스트만 루트로 올리고 실제 소스는 `sdks/ios/` 아래 그대로 두어, 4개 언어 SDK가
// `sdks/` 밑에 대칭으로 놓이는 레이아웃을 지킨다.
//
// 기각안: `sdks/ios/`를 subtree push하는 미러 저장소(`rynl10n-swift`). 별도 저장소·deploy key
// 시크릿·전용 CI 잡을 유지해야 하고 태그가 두 곳에 생기며 미러에서는 테스트가 돌지 않는다.
// 미러를 택했던 근거는 "소비자가 모노레포 전체를 받는다"였는데, 실측 클론 전송량이 205 KiB라
// (빌드 산출물은 git에 없다) 그 부담이 실재하지 않았다.
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
        .target(name: "RynL10n", path: "sdks/ios/Sources/RynL10n"),
        // 빌드타임 자동 번들링 CLI(6.3). build tool plugin이 이 실행파일을 prebuild로 실행한다.
        .executableTarget(name: "rynl10n-bake", dependencies: ["RynL10n"],
                          path: "sdks/ios/Sources/rynl10n-bake"),
        // build tool plugin: vendored 스냅샷을 prebuild에 bake(에어갭·샌드박스 적합).
        .plugin(name: "RynL10nBakePlugin", capability: .buildTool(), dependencies: ["rynl10n-bake"],
                path: "sdks/ios/Plugins/RynL10nBakePlugin"),
        // 리소스는 bake 산출물이 앱 번들에 들어간 모습을 그대로 흉내낸다(번들 로더 검증용).
        .testTarget(name: "RynL10nTests", dependencies: ["RynL10n"],
                    path: "sdks/ios/Tests/RynL10nTests",
                    resources: [.copy("Fixtures/snapshot.json"), .copy("Fixtures/rynl10n.lock")]),
    ]
)
