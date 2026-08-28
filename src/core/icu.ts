/**
 * ICU 인자 이름(argName)의 단일 정의 — 기획서 5.3
 *
 * 인자 이름을 알아보는 코드는 셋이다: 서명(placeholder) · 런타임 치환(resolve) · bake 변환(convert).
 * 셋이 같은 것을 다르게 알면 "서명에는 잡히는데 치환은 안 되는" 조합이 생기므로 정의는 여기 한 곳에만 둔다.
 *
 * ICU MessageFormat에서 argName은 **Pattern_Syntax도 Pattern_White_Space도 아닌 문자 1개 이상**이다.
 * [A-Za-z0-9_]+로 좁히면 {이름}·{имя}가 인자가 아니라 리터럴이 되고, 그러면 서명이 ""라
 * 포맷 가드(3.1)를 그냥 통과한 뒤 런타임에 중괄호가 그대로 보인다.
 *
 * 두 Unicode 속성은 **불변(immutable)으로 선언**돼 코드포인트 목록이 앞으로도 바뀌지 않는다. 그래서
 * 속성 이름 대신 범위를 직접 적었다 — Pattern_Syntax 속성 이스케이프를 지원하지 않는 엔진이 있고
 * (java.util.regex), 4개 언어가 **바이트 동일한 클래스**를 써야 골든 벡터 계약이 성립하기 때문이다.
 * 전부 BMP라 유니코드 이스케이프만으로 적을 수 있다.
 *
 * 같은 문자열이 TS src/core/icu.ts · Swift Icu.swift · Kotlin Icu.kt · Dart icu.dart에 있다.
 * 고칠 일이 생기면 넷을 함께 고치고 `npm run gen:golden` 후 전 SDK를 재실행한다.
 */

/**
 * Pattern_Syntax(2760) ∪ Pattern_White_Space(11). 뺀 나머지가 argName 한 글자다.
 * U+0020(SPACE)은 Pattern_White_Space지만 뒤의 U+0021..U+002F와 이어지고, U+200E..U+200F·
 * U+2028..U+2029도 사이의 U+2010..U+2027과 이어져 각각 한 범위로 합쳤다.
 */
const NOT_ARG_NAME_CHAR =
  String.raw`\u0009-\u000D\u0020-\u002F\u003A-\u0040\u005B-\u005E\u0060\u007B-\u007E\u0085\u00A1-\u00A7` +
  String.raw`\u00A9\u00AB-\u00AC\u00AE\u00B0-\u00B1\u00B6\u00BB\u00BF\u00D7\u00F7` +
  String.raw`\u200E-\u2029\u2030-\u203E\u2041-\u2053\u2055-\u205E\u2190-\u245F\u2500-\u2775` +
  String.raw`\u2794-\u2BFF\u2E00-\u2E7F\u3001-\u3003\u3008-\u3020\u3030\uFD3E-\uFD3F\uFE45-\uFE46`;

/** ICU 인자 이름 1개 이상. */
export const ARG_NAME = String.raw`[^${NOT_ARG_NAME_CHAR}]+`;

/** 인자 타입 키워드(ICU simpleArg/complexArg의 두 번째 자리). */
export const ARG_TYPE = String.raw`plural|selectordinal|select|number|date|time|spellout|ordinal|duration`;

/** 여는 중괄호 + 이름(+ 타입) 스캔 — 서명 수집용(닫는 중괄호까지 보지 않는다). */
export const ARG_SCAN = String.raw`\{\s*(${ARG_NAME})\s*(?:,\s*(${ARG_TYPE}))?`;

/** 타입 없는 단순 인자 — 치환 대상. */
export const SIMPLE_ARG = String.raw`\{\s*(${ARG_NAME})\s*\}`;

/** 중괄호 안쪽(name 또는 name, type ...) 선두 매칭 — 변환기용. */
export const INNER_ARG = String.raw`^(${ARG_NAME})\s*(?:,\s*([a-z]+))?`;
