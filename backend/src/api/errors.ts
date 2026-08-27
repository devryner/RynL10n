/**
 * 관리 API 에러 타입 — 기획서 7.1의 에러 코드 규약(422/409/404/403/401).
 *
 * server.ts 안에 있던 것을 밖으로 뺐다: 검증기(translation-import.ts)를 라우트 밖에서도
 * 재사용하려면 그 검증기가 던지는 타입이 server.ts에 매여 있으면 안 되기 때문이다.
 * `NotFoundError`·`RangeConflictError`는 pipeline/publish.ts가 원천이라 그대로 둔다.
 */

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** 플레이스홀더 서명·복수형 형태 불일치(422) — 포맷 안전 가드(3.1)의 쓰기 경로 방어선. */
export class SignatureMismatchError extends HttpError { constructor(m: string) { super(422, m); } }
export class BadRequestError extends HttpError { constructor(m: string) { super(400, m); } }
/** 현재 상태와 충돌해 요청을 수행할 수 없음(409). 범위 충돌은 별도 RangeConflictError. */
export class ConflictError extends HttpError { constructor(m: string) { super(409, m); } }
