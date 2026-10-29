import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GUIDE_FILES = [
  "sdks/README.md", "sdks/ios/README.md", "sdks/android/README.md",
  "sdks/web/README.md", "sdks/flutter/README.md",
] as const;

export type Example = { id: string; language: string; code: string; location: string };
const checkedLanguages = new Set(["swift", "kotlin", "ts", "tsx", "dart"]);

/** IDs survive section reordering; an unmarked new example must not silently escape the gate. */
export function extract(markdown: string, file: string): Example[] {
  const lines = markdown.split(/\r?\n/).map((line) => line.replace(/^> ?/, ""));
  const examples: Example[] = [];
  let pending: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^<!-- sdk-guide:([\w.-]+) -->$/.exec(line);
    if (marker) {
      if (pending) throw new Error(`${file}:${i + 1}: 코드 없는 마커 ${pending}`);
      if (!/^(ios|android|web|flutter)\.[\w.-]+$/.test(marker[1]!)) throw new Error(`${file}:${i + 1}: 알 수 없는 SDK 마커 ${marker[1]}`);
      pending = marker[1]!;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (!fence) continue;
    const start = i + 1;
    const body: string[] = [];
    while (++i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i]!);
    if (i === lines.length) throw new Error(`${file}:${start}: 닫히지 않은 코드 블록`);
    if (!pending && !checkedLanguages.has(fence[1]!)) continue;
    if (!pending) throw new Error(`${file}:${start}: sdk-guide 마커가 없는 ${fence[1]} 예제`);
    if (examples.some((example) => example.id === pending)) throw new Error(`${file}: 중복 마커 ${pending}`);
    examples.push({ id: pending, language: fence[1]!, code: body.join("\n") + "\n", location: `${file}:${start + 1}` });
    pending = undefined;
  }
  if (pending) throw new Error(`${file}: 코드 없는 마커 ${pending}`);
  return examples;
}

export function loadExamples(root: string): Map<string, Example> {
  const result = new Map<string, Example>();
  for (const file of GUIDE_FILES) {
    for (const example of extract(readFileSync(join(root, file), "utf8"), file)) {
      if (result.has(example.id)) throw new Error(`문서 간 중복 마커 ${example.id}`);
      result.set(example.id, example);
    }
  }
  return result;
}

export function take(examples: Map<string, Example>, id: string, language: string): string {
  const example = examples.get(id);
  if (!example) throw new Error(`가이드 예제가 없습니다: ${id}`);
  if (example.language !== language) throw new Error(`${example.location}: ${id}는 ${language}여야 합니다`);
  examples.delete(id);
  return example.code;
}

export function assertConsumed(examples: Map<string, Example>, selected: readonly string[]) {
  const untested = [...examples.keys()].filter((id) => selected.includes(id.split(".")[0]!));
  if (untested.length) throw new Error(`검증에 연결하지 않은 가이드 예제: ${untested.join(", ")}`);
}

/** Only documented environment substitutions are allowed; stale scaffolding fails explicitly. */
export function replaceOnce(code: string, before: string, after: string): string {
  if (code.split(before).length !== 2) throw new Error(`예제의 치환 지점을 확인하세요: ${before}`);
  return code.replace(before, after);
}
