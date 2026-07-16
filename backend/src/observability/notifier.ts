/**
 * 실시간 푸시 알림 — 기획서 8.4(MVP는 폴링, 실시간은 로드맵) / M4.
 *
 * publish/롤백 시 "manifest 변경" **신호만** 방출한다(번역 데이터 없음 — 데이터는 여전히 정적 CDN).
 * SDK는 이 신호를 받아 정적 manifest를 즉시 재요청 → 폴링 지연 없이 갱신. 옵트인, 폴링으로 폴백 가능.
 * 이는 캐시 무효화 신호일 뿐이라 "읽기 경로 = 정적 파일" 원칙을 데이터 측면에서 유지한다.
 */
export type NotifyListener = (seq: number) => void;

export class Notifier {
  private readonly subs = new Map<string, Set<NotifyListener>>();
  private readonly seq = new Map<string, number>();

  subscribe(projectId: string, listener: NotifyListener): () => void {
    const set = this.subs.get(projectId) ?? new Set();
    set.add(listener);
    this.subs.set(projectId, set);
    return () => set.delete(listener);
  }

  /** 프로젝트 manifest 변경을 알림. 단조 증가 seq를 함께 전달. */
  emit(projectId: string): number {
    const next = (this.seq.get(projectId) ?? 0) + 1;
    this.seq.set(projectId, next);
    for (const l of this.subs.get(projectId) ?? []) l(next);
    return next;
  }

  subscriberCount(projectId: string): number {
    return this.subs.get(projectId)?.size ?? 0;
  }
}
