/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — 기획서 11.1
 *
 * 결정성이 전부다: 같은 (릴리스, 콘텐츠)면 항상 같은 바이트열 → 같은 해시.
 * 이것이 7.4 결정적 빌드 · 4.4 불변(내용해시) 캐싱의 근거.
 *
 * JCS 규칙(11.1):
 *  - 객체 키 UTF-16 코드유닛 오름차순 정렬
 *  - 최소 공백(구분자 `,`·`:`, 들여쓰기 없음)
 *  - 숫자는 최단 표현
 *  - 문자열 값은 저장 전 유니코드 NFC 정규화
 *  - 비ASCII는 이스케이프 없이 UTF-8 그대로, 제어문자만 이스케이프
 *
 * 구현 노트: 문자열의 이스케이프는 V8 JSON.stringify(문자열 1개)가 JCS와 일치한다
 * (제어문자 짧은 형태 \b\t\n\f\r + 소문자 \u00xx, 비ASCII 리터럴 UTF-8, 공백 없음).
 * 하지만 **객체를 재구성해 JSON.stringify하는 방식은 쓸 수 없다**: JS 객체는 정수형 문자열
 * 키("2","10")를 항상 숫자 오름차순으로 열거하므로 JCS의 UTF-16 코드유닛 정렬("10"<"2")을
 * 깨뜨린다. 따라서 객체/배열은 직접 문자열로 방출해 키 순서를 완전히 통제한다.
 * 숫자는 스키마상 전량 정수라 String(n)이 최단 표현과 일치한다. 비정수 number는 거부한다
 * (프로덕션에서 임의 number가 필요하면 RFC 8785 §3.2.2.3 ES Number→String(Ryū) 전량 구현).
 */

/** 값을 JCS 정규화 문자열로 직렬화. */
export function canonicalStringify(value: unknown): string {
  return emit(value);
}

function emit(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify((value as string).normalize("NFC"));
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error(`JCS: 유한하지 않은 숫자는 직렬화할 수 없다 (${String(n)})`);
    if (!Number.isInteger(n)) throw new Error(`JCS: 비정수 number는 이 스파이크 범위 밖이다 (${n}). 11.1 참조.`);
    return String(n);
  }
  if (Array.isArray(value)) return "[" + value.map(emit).join(",") + "]";
  if (t === "object") {
    const src = value as Record<string, unknown>;
    // Array.prototype.sort의 기본 비교자 = UTF-16 코드유닛 순 → JCS 키 정렬과 일치.
    const keys = Object.keys(src).filter((k) => src[k] !== undefined).sort();
    const parts: string[] = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ":" + emit(src[k]));
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`JCS: 직렬화할 수 없는 타입 ${t}`);
}

/** 값을 JCS 정규화 UTF-8 바이트열로 직렬화 (해시 입력). */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalStringify(value), "utf8");
}
