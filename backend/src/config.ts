/**
 * 프로세스 환경 → 기동 설정 (9.1).
 *
 * **빈 문자열은 "설정 없음"이다.** `process.env.X ?? 기본값`은 nullish만 걸러내므로 빈 값이
 * 기본값을 덮어쓴다. 값 없는 변수를 빈 문자열로 주입하는 건 흔한 경로다 — 컨테이너
 * 오케스트레이터의 미해석 Secret, CI가 `env:`로 넘긴 미설정 시크릿,
 * `.env`의 `X=`. 같은 사고를 Android 릴리스 서명에서 이미 한 번 겪었다(빈 GPG 키로 서명이
 * 켜져 게시가 죽었다).
 *
 * 그래서 판정을 **여기 한 곳**에 모은다. 이 모듈을 통과한 값은 "있으면 유효하다"를 만족하므로
 * 나머지 코드가 빈 문자열을 다시 의심하지 않아도 된다. `main.ts`가 아니라 별도 모듈인 이유는
 * 엔트리포인트가 import 시점에 서버를 띄워 테스트가 불러올 수 없기 때문이다.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * 값이 있는 환경변수만 돌려준다 — 미설정·빈 문자열·공백뿐인 값은 모두 `undefined`.
 * 값 자체는 자르지 않는다(경로·토큰의 내용은 호출자 소관이고, 여기서 판정하는 건 "있는가"뿐).
 */
export function envValue(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/**
 * 포트 — 값이 없으면 기본값. 값이 있는데 정수가 아니면 **즉시 실패**한다.
 * `Number("")`는 0(= OS 임의 포트), `Number("abc")`는 NaN이고 둘 다 listen을 통과해버려,
 * 서버는 떴는데 아무도 접속하지 못하는 상태가 로그 한 줄 없이 만들어진다.
 */
export function envPort(env: Env, name: string, fallback: number): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name}은 0~65535의 정수여야 합니다: ${JSON.stringify(raw)}`);
  }
  return n;
}

export interface ServerConfig {
  readonly managementPort: number;
  readonly deliveryPort: number;
  readonly dbPath: string;
  readonly storageRoot: string;
  readonly adminToken: string;
  readonly deliveryAllowOrigin: string;
  readonly deliveryBaseUrl: string;
}

/** 기본값은 단일 노드 셀프호스트(`docker compose up`) 기준. 프로덕션은 전부 환경에서 온다. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const deliveryPort = envPort(env, "RYNL10N_DELIVERY_PORT", 8788);
  return {
    managementPort: envPort(env, "RYNL10N_PORT", 8787),
    deliveryPort,
    dbPath: envValue(env, "RYNL10N_DB") ?? ":memory:",
    storageRoot: envValue(env, "RYNL10N_STORAGE") ?? "./.rynl10n-storage",
    adminToken: envValue(env, "RYNL10N_ADMIN_TOKEN") ?? "dev-admin-token",
    // 브라우저 SDK(Web·Flutter Web)가 교차 오리진으로 읽는다. 공개 읽기 전용 정적 파일이라 기본은 `*`.
    // 빈 값이 새어 들어가면 `Access-Control-Allow-Origin: `가 나가 브라우저가 조용히 거부한다.
    deliveryAllowOrigin: envValue(env, "RYNL10N_DELIVERY_ALLOW_ORIGIN") ?? "*",
    // 배포 플레인 base URL — 대시보드가 산출물 링크를 만들 때 쓴다(프로덕션은 CDN 도메인).
    deliveryBaseUrl: envValue(env, "RYNL10N_DELIVERY_URL") ?? `http://localhost:${deliveryPort}`,
  };
}
