#!/usr/bin/env bash
#
# GitHub Actions 대신 로컬에서 도는 CI.
#
# 2026-09-10 부터 `ci.yml` 은 push·PR 에서 돌지 않는다 — Actions 한도를 너무 써서다(iOS 잡은
# macOS 러너라 분당 과금이 Linux 의 10배). **`workflow_call` 은 남겼다** — `release.yml` 이 태그에서
# 이 워크플로를 게시 전 게이트로 부르므로, 게시만큼은 여전히 Actions 에서 전부 검증된다.
#
# 그래서 **PR 을 올리거나 main 에 푸시하기 전에 이 스크립트를 돌리는 것이 평상시 유일한 게이트다.**
# `ci.yml` 의 잡과 같은 검사를 한다. 한쪽을 고치면 다른 쪽도 고친다.
#
#   reference  TS 참조 구현 · 백엔드 · mcp-stdio 타입체크·테스트 + 골든 벡터 결정성
#   web        Web SDK 타입체크 · 테스트 · 게시 빌드
#   ios        iOS SDK swift test · SPM 플러그인 소비 예제 빌드
#   android    Android SDK gradle test · AAR assembleRelease
#   flutter    Flutter SDK pub get · test · 예제 실행 · analyze --fatal-infos
#
# 사용법 (저장소 루트에서):
#   ./tools/ci-local.sh                 # 전부
#   ./tools/ci-local.sh reference web   # 고른 것만
#
# 로컬 도구 버전이 CI 와 다를 수 있다 — CI 는 Node 24.x · Java 21 · Dart 3.5 로 고정했다.
# 특히 Dart 는 새 버전의 분석기가 경고를 더 내서 analyze 결과가 달라질 수 있다.
#
# **캐시와 초록의 관계는 단계마다 다르다**(2026-09-26 확인).
#   android  Gradle 은 `test` 과제째로 UP-TO-DATE 가 되어 **테스트도 컴파일도 돌지 않은 채** 통과했다.
#            그래서 `clean` 을 앞에 두고 실행된 과제가 하나도 없으면 막는다(`android_gradle`).
#   ios      `swift test` 는 증분 컴파일만 건너뛰고 **테스트 바이너리는 매번 실행한다** — 두 번 연속
#            돌려 51 개가 그대로 도는 것을 확인했다. android 같은 침묵은 없다.
#   flutter  `dart test`·`dart analyze` 도 같다 — 2 회차에도 54 개가 돌고 analyze 가 다시 돈다.
#
# 다만 ios·flutter 도 **컴파일 자체는 건너뛴다.** 테스트가 도니 코드 동작 신호는 남지만, 툴체인이
# 깨진 것은 무언가 바뀌기 전까지 드러나지 않는다(Kotlin 이 JDK 26 을 못 읽던 건이 그랬다).
# 둘의 클린 빌드는 Gradle 과 달리 비싸서 매번 돌리지 않는다 — **툴체인을 바꿨을 때 한 번** 클린으로
# 돌리는 것이 그 사각을 닫는 자리다.
#
# 읽을 때 하나: `swift test` 끝에 붙는 `Test run with 0 tests in 0 suites passed` 는 새 swift-testing
# 러너가 자기 소속 테스트를 0 개 찾았다는 뜻이다(이 저장소는 XCTest 만 쓴다). 근거가 없는 초록 한
# 줄이므로 위의 `Executed 51 tests` 쪽을 봐야 한다.
#
# 맥 기본 bash(3.2)에서도 돌도록 bash 4 문법을 쓰지 않는다.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
targets="${*:-reference web ios android flutter}"
failed=""

step() {
    local name="$1"; shift
    printf '\n▶ %s\n' "$name"
    if "$@"; then
        printf '✔ %s\n' "$name"
    else
        printf '✘ %s\n' "$name" >&2
        return 1
    fi
}

in_dir() { # in_dir <디렉터리> <명령...>
    local dir="$1"; shift
    (cd "$root/$dir" && "$@")
}

# Gradle 은 캐시가 살아 있으면 compileKotlin 을 UP-TO-DATE 로 건너뛴다. 그러면 컴파일러를 부르지도
# 않은 채 BUILD SUCCESSFUL 이 나서, **툴체인이 깨진 날에도 초록이 뜬다.** 2026-09-23 에 실제로 겪었다 —
# JDK 26 에서 죽는 것을 확인하려고 이 단계를 돌렸는데 전 과제가 캐시에서 나와 통과했고, `-q` 가
# 요약줄까지 지워 단서조차 남지 않았다. 통과처럼 보이는 침묵이 가장 비싼 실패다.
#
# 그래서 둘을 한다: `clean` 으로 컴파일을 강제하고, 요약줄에 executed 가 있는지까지 확인한다.
# 앞의 것이 지금의 수선이고 뒤의 것은 그것이 사라져도 거짓 초록이 나지 않게 하는 가드다.
# 출력은 삼켜 두었다가 실패할 때만 보여 준다 — `-q` 로 지우는 것과 달리 근거는 남는다.
android_gradle() { # android_gradle <gradle 인자...>
    local out status
    out="$(in_dir sdks/android ./gradlew "$@" 2>&1)"
    status=$?
    if [ $status -ne 0 ]; then
        printf '%s\n' "$out" | tail -25 >&2
        return 1
    fi
    # "48 actionable tasks: 43 executed, 5 up-to-date" ↔ "28 actionable tasks: 28 up-to-date"
    case "$out" in
        *"actionable tasks:"*" executed"*) return 0 ;;
    esac
    printf '%s\n' "$out" | tail -5 >&2
    printf '  ✘ 한 과제도 실행되지 않았다 — 전부 캐시다. 컴파일러가 돌지 않았으므로 이 통과는\n' >&2
    printf '    툴체인을 검증하지 못한다. clean 이 빠졌는지 확인하라.\n' >&2
    return 1
}

npm_installed=""
ensure_npm() {
    [ -n "$npm_installed" ] && return 0
    # devDependencies 는 typescript·@types/node 뿐이다(런타임 의존성 0 원칙).
    # package-lock.json 은 추적한다 — 이 설치가 그 파일을 바꾸면 lockfile 이 package.json 과 어긋난 것이다.
    step "npm install" in_dir . npm install --no-audit --no-fund --silent || return 1
    npm_installed=1
}

run_reference() {
    ensure_npm || return 1
    step "typecheck"            in_dir . npm run -s typecheck           || return 1
    step "test"                 in_dir . npm test -s                    || return 1
    step "typecheck:backend"    in_dir . npm run -s typecheck:backend   || return 1
    step "test:backend"         in_dir . npm run -s test:backend        || return 1
    step "typecheck:mcp-stdio"  in_dir . npm run -s typecheck:mcp-stdio || return 1
    step "test:mcp-stdio"       in_dir . npm run -s test:mcp-stdio      || return 1
    # 골든 벡터 = 크로스언어 계약. 재생성 결과가 커밋 상태와 1바이트라도 다르면 막는다.
    # 다르면 재생성된 파일이 작업 트리에 남는다 — 의도한 변경이면 커밋하고 각 SDK 테스트를 다시 돌린다.
    step "gen:golden"           in_dir . npm run -s gen:golden          || return 1
    if ! step "골든 벡터 결정성 (재생성 후 diff 없음)" \
            in_dir . git diff --exit-code --stat fixtures/golden; then
        echo "골든 벡터가 커밋 상태와 다르다. 의도한 변경이면 결과를 커밋하고 각 SDK 테스트를 다시 돌릴 것." >&2
        return 1
    fi
}

run_web() {
    ensure_npm || return 1
    step "Web SDK typecheck"      in_dir sdks/web npm run -s typecheck     || return 1
    step "Web SDK test"           in_dir sdks/web npm test -s              || return 1
    # 게시본은 트랜스파일된 .js+.d.ts 다. 태그를 단 뒤에 빌드가 깨진 걸 알면 늦다.
    step "Web SDK 게시 빌드 스모크" in_dir sdks/web npm run -s build:publish || return 1
}

run_ios() {
    # 패키지 매니페스트는 저장소 루트에 있다(SwiftPM 제약 — 루트 Package.swift 주석 참조).
    step "iOS SDK swift test"            in_dir . swift test                     || return 1
    # 차별점 ①(빌드타임 자동 번들링)의 소비 경로. 플러그인이 빌드 그래프에 붙는지까지 본다.
    step "SPM 플러그인 소비 예제 빌드"      in_dir examples/ios-consumer swift build || return 1
}

run_android() {
    # 코어는 루트 JVM 모듈이라 Android SDK 없이 돈다.
    # clean 을 앞에 두는 이유는 android_gradle 주석에 있다 — 캐시가 살아 있으면 컴파일러를
    # 부르지 않은 채 통과한다.
    step "Android SDK test"                android_gradle clean test              || return 1
    step "Android SDK AAR assembleRelease" android_gradle :library:assembleRelease || return 1
}

run_flutter() {
    step "Flutter SDK pub get"   in_dir sdks/flutter dart pub get                  || return 1
    step "Flutter SDK test"      in_dir sdks/flutter dart test                     || return 1
    # 순수 Dart 코어라 위젯 없이 도는 예제다. pub.dev 점수 요건이기도 하다.
    step "Flutter SDK 예제 실행"  in_dir sdks/flutter dart run example/example.dart || return 1
    step "Flutter SDK analyze"   in_dir sdks/flutter dart analyze --fatal-infos    || return 1
}

for target in $targets; do
    case "$target" in
        reference) run_reference || failed="$failed reference" ;;
        web)       run_web       || failed="$failed web" ;;
        ios)       run_ios       || failed="$failed ios" ;;
        android)   run_android   || failed="$failed android" ;;
        flutter)   run_flutter   || failed="$failed flutter" ;;
        *) echo "모르는 대상: $target  (reference | web | ios | android | flutter)" >&2; exit 2 ;;
    esac
done

if [ -n "$failed" ]; then
    printf '\n실패:%s\n' "$failed" >&2
    exit 1
fi
printf '\n모두 통과: %s\n' "$targets"
