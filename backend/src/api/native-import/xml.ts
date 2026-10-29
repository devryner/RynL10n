type Fail = (message: string) => never;
export interface XmlNode {
  name: string;
  attrs: Map<string, string>;
  children: Array<XmlNode | string | { comment: string }>;
}

function xmlCodePoint(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** 외부 엔터티·DTD 없이 필요한 XML 구조만 읽는다. 네이티브 파서나 네트워크에 위임하지 않는다. */
export function parseXml(source: string, fail: Fail): XmlNode {
  const text = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if ([...text].some((character) => !xmlCodePoint(character.codePointAt(0)!))) fail("XML 1.0에서 허용되지 않는 문자가 있습니다");
  let cursor = 0;
  const whitespace = () => { while (cursor < text.length && /[ \t\n]/u.test(text[cursor]!)) cursor++; };
  const name = (): string => {
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(text.slice(cursor));
    if (!match) fail("XML 이름이 필요합니다");
    cursor += match[0].length; return match[0];
  };
  const decode = (raw: string): string => raw.replace(/&([^;]*);|&/gu, (entity, body: string | undefined) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (body !== undefined && Object.hasOwn(named, body)) return named[body]!;
    if (body !== undefined && /^(?:#\d+|#x[0-9a-fA-F]+)$/u.test(body)) {
      const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (xmlCodePoint(code)) return String.fromCodePoint(code);
    }
    return fail(`지원하지 않거나 잘못된 XML 엔터티 ${entity}`);
  });
  const comment = (): { comment: string } => {
    const end = text.indexOf("-->", cursor + 4);
    if (end < 0) fail("XML 주석이 닫히지 않았습니다");
    const value = text.slice(cursor + 4, end);
    if (value.includes("--") || value.endsWith("-")) fail("잘못된 XML 주석입니다");
    cursor = end + 3; return { comment: value };
  };
  const element = (depth: number): XmlNode => {
    if (depth > 8) fail("XML 요소가 너무 깊습니다");
    if (text[cursor++] !== "<" || /[!?/]/u.test(text[cursor] ?? "")) fail("XML 요소가 필요합니다(DTD·처리 명령은 지원하지 않습니다)");
    const tag = name();
    const attrs = new Map<string, string>();
    while (true) {
      const before = cursor; whitespace();
      if (text.startsWith("/>", cursor)) { cursor += 2; return { name: tag, attrs, children: [] }; }
      if (text[cursor] === ">") { cursor++; break; }
      if (cursor === before) fail("XML 속성 사이 공백이 필요합니다");
      const attribute = name();
      if (attrs.has(attribute)) fail(`XML 속성 ${attribute}가 중복되었습니다`);
      whitespace();
      if (text[cursor++] !== "=") fail("XML 속성에 =가 필요합니다");
      whitespace();
      const quote = text[cursor++];
      if (quote !== '"' && quote !== "'") fail("XML 속성은 따옴표로 감싸야 합니다");
      const end = text.indexOf(quote, cursor);
      if (end < 0) fail("XML 속성이 닫히지 않았습니다");
      const raw = text.slice(cursor, end);
      if (raw.includes("<")) fail("XML 속성에 <를 직접 넣을 수 없습니다");
      attrs.set(attribute, decode(raw)); cursor = end + 1;
    }
    const children: XmlNode["children"] = [];
    while (cursor < text.length) {
      if (text.startsWith(`</`, cursor)) {
        cursor += 2;
        if (name() !== tag) fail(`XML 닫는 태그가 ${tag}와 다릅니다`);
        whitespace();
        if (text[cursor++] !== ">") fail("XML 닫는 태그가 잘못되었습니다");
        return { name: tag, attrs, children };
      }
      if (text.startsWith("<!--", cursor)) { children.push(comment()); continue; }
      if (text.startsWith("<![CDATA[", cursor)) {
        const end = text.indexOf("]]>", cursor + 9);
        if (end < 0) fail("CDATA가 닫히지 않았습니다");
        children.push(text.slice(cursor + 9, end)); cursor = end + 3; continue;
      }
      if (text[cursor] === "<") { children.push(element(depth + 1)); continue; }
      const end = text.indexOf("<", cursor);
      const raw = text.slice(cursor, end < 0 ? text.length : end);
      if (raw.includes("]]>")) fail("XML 텍스트에 ]]>를 직접 넣을 수 없습니다");
      children.push(decode(raw)); cursor += raw.length;
    }
    return fail(`XML ${tag}가 닫히지 않았습니다`);
  };
  whitespace();
  if (text.startsWith("<?xml", cursor)) {
    const declaration = /^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])(?:utf-8|UTF-8)\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/u.exec(text.slice(cursor));
    if (!declaration) fail("XML 1.0 UTF-8 선언만 지원합니다");
    cursor += declaration[0].length;
  }
  whitespace();
  while (text.startsWith("<!--", cursor)) { comment(); whitespace(); }
  const root = element(0);
  whitespace();
  while (text.startsWith("<!--", cursor)) { comment(); whitespace(); }
  if (cursor !== text.length) fail("XML 루트 뒤에 추가 내용이 있습니다");
  return root;
}

/** XML 해석 뒤 Android의 인용·공백 접기·백슬래시 처리를 적용한다. */
export function androidText(node: XmlNode, fail: Fail): string {
  if (node.children.some((child) => typeof child !== "string" && !("comment" in child))) {
    fail("Android 스타일/annotation/리소스 참조 요소는 지원하지 않습니다. 서식을 제거하거나 별도로 보존하세요");
  }
  const raw = node.children.filter((child): child is string => typeof child === "string").join("");
  let out = "", quoted = false, pendingSpace = false;
  const append = (value: string) => { if (pendingSpace && out) out += " "; pendingSpace = false; out += value; };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === "\\") {
      const escaped = raw[++i];
      if (escaped === undefined) fail("Android escape가 끝나지 않았습니다");
      if (escaped === "u") {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("Android Unicode escape는 \\uXXXX여야 합니다");
        append(String.fromCharCode(Number.parseInt(hex, 16))); i += 4;
      } else {
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "@": "@", "?": "?" };
        if (!Object.hasOwn(escapes, escaped)) fail(`지원하지 않는 Android escape \\${escaped}`);
        append(escapes[escaped]!);
      }
    } else if (char === '"') {
      if (!quoted && pendingSpace && out) { out += " "; pendingSpace = false; }
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(char)) pendingSpace = true;
    else append(char);
  }
  if (quoted) fail("Android 문자열의 따옴표가 닫히지 않았습니다");
  if (/^\s*[@?](?:[A-Za-z][A-Za-z0-9_.]*:)?(?:[A-Za-z][A-Za-z0-9_.]*\/|[A-Za-z_][A-Za-z0-9_]*$)/u.test(raw) && !raw.startsWith("\\")) {
    fail("Android 리소스/테마 참조는 값으로 해석할 수 없습니다");
  }
  return out;
}
