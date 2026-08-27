pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }

// **mavenLocal()을 넣지 않는다.** 넣는 순간 로컬에 설치된 산출물을 집어 레지스트리를 건드리지
// 않고 통과한다 — 검증한 것이 게시본이 아니게 된다(이 스모크의 전제).
dependencyResolutionManagement { repositories { google(); mavenCentral() } }

rootProject.name = "rynl10n-consumer-smoke"
include(":consumer")
