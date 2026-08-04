/**
 * 영속 캐시 — 기획서 6.4 / 7.2 (앱 적용 경로).
 *
 * 배포 플레인 산출물은 **내용해시 URL이라 한 번 받으면 영구 유효**하다. iOS·Android는 이것을 디스크에
 * 두지만 브라우저에는 파일 시스템이 없으므로 Web Storage(`localStorage`)를 같은 자리로 쓴다.
 * 덕분에 탭을 새로 열거나 오프라인으로 다시 들어와도 마지막 카탈로그가 그대로 살아 있다.
 *
 * **저장 실패는 전부 조용히 삼킨다** — 사생활 모드·용량 초과·샌드박스 iframe 어디서든 캐시는 *가속*일
 * 뿐이고, 번들 fallback이 항상 살아 있어 번역 공백이 생기지 않는다(3.1).
 */

/** `localStorage`/`sessionStorage` 호환 최소 표면. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface PersistentCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** 이 캐시가 소유한 항목만 비운다(같은 스토리지의 다른 키는 건드리지 않는다). */
  clear(): void;
}

/** 메모리 캐시 — 스토리지가 없는 환경(SSR·Node·테스트)의 fallback. 탭 수명과 함께 사라진다. */
export function memoryCache(): PersistentCache {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/**
 * Web Storage 백엔드. 키는 `rynl10n:{namespace}:` 로 네임스페이스가 붙어
 * 같은 오리진의 다른 프로젝트·다른 앱 데이터와 섞이지 않는다.
 */
export function storageCache(storage: StorageLike, namespace: string): PersistentCache {
  const prefix = `rynl10n:${namespace}:`;
  return {
    get(key) {
      try {
        return storage.getItem(prefix + key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        storage.setItem(prefix + key, value);
      } catch {
        // 용량 초과·사생활 모드 — 캐시 없이 계속 진행한다(번들 fallback이 있다).
      }
    },
    remove(key) {
      try {
        storage.removeItem(prefix + key);
      } catch {
        /* 무시 */
      }
    },
    clear() {
      try {
        const doomed: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key !== null && key.startsWith(prefix)) doomed.push(key);
        }
        for (const key of doomed) storage.removeItem(key);
      } catch {
        /* 무시 */
      }
    },
  };
}

/**
 * 기본 캐시 선택: 브라우저면 `localStorage`, 아니면 메모리.
 *
 * `globalThis.localStorage`가 아니라 **`window`를 먼저 본다** — Node에도 실험적 `localStorage` 전역이
 * 있어서 그걸 집으면 서버 사이드 렌더링·테스트에서 엉뚱한 백엔드를 쓰게 된다.
 * 접근 자체가 던지는 환경(샌드박스 iframe)도 있어 읽기까지 시도해 본 뒤 결정한다.
 */
export function defaultCache(namespace: string): PersistentCache {
  try {
    const win = (globalThis as { window?: { localStorage?: StorageLike } }).window;
    const storage = win?.localStorage;
    if (storage) {
      storage.getItem(`rynl10n:${namespace}:probe`); // 접근 가능 여부 확인
      return storageCache(storage, namespace);
    }
  } catch {
    /* 접근 불가 → 메모리 */
  }
  return memoryCache();
}
