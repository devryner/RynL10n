// 게시본의 .d.ts가 소비자 쪽 tsc에서 해석되는지 본다(`exports.types` 경로가 어긋나면 여기서 걸린다).
// 실행이 아니라 타입 해석만 확인하므로 `tsc --noEmit` 대상이다.
import { HttpRynL10n, BakedBundle } from "@rynl10n/web";

const sdk = new HttpRynL10n({
  projectKey: "smoke",
  endpoint: "https://cdn.example.invalid",
  bundle: BakedBundle.parse({
    schemaVersion: 1, release: "R1", base: "x", defaultLocale: "en",
    locales: { en: { "home.title": "Home" } },
  }),
  context: { appVersion: "3.2.1" },
  locale: "en",
});

export const value: string = sdk.t("home.title");
export const unsubscribe: () => void = sdk.onCatalogUpdated(() => {});
