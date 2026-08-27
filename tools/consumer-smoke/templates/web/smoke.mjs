// 게시본을 node_modules에서 그대로 import 한다 — 저장소 소스를 가리키는 경로가 하나도 없어야 한다.
import { HttpRynL10n, BakedBundle } from "@rynl10n/web";
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sdk = new HttpRynL10n({
  projectKey: "smoke",
  endpoint: "https://cdn.example.invalid", // 배포 플레인 — 스모크는 네트워크를 타지 않는다
  bundle: BakedBundle.parse(read("./snapshot.json")),
  context: { appVersion: "3.2.1" },
  locale: "en",
});

let bad = 0;
for (const c of read("./checks.json")) {
  const got = sdk.t(c.key, c.args, c.locale ?? undefined);
  const ok = got === c.expect;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: ${JSON.stringify(got)}${ok ? "" : ` (기대 ${JSON.stringify(c.expect)})`}`);
}
process.exit(bad === 0 ? 0 : 1);
