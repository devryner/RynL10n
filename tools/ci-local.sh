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
    step "Android SDK test"              in_dir sdks/android ./gradlew test -q                   || return 1
    step "Android SDK AAR assembleRelease" in_dir sdks/android ./gradlew :library:assembleRelease -q || return 1
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
