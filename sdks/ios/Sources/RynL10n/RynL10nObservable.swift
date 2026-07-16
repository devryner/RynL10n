import Foundation
import Combine

/// SwiftUI 바인딩 — 기획서 6.2.
/// 카탈로그 갱신(onCatalogUpdated) 시 `version`을 올려 SwiftUI 뷰가 리렌더하게 한다.
/// 사용: `@StateObject var l10n = RynL10nObservable(client: ...)` 후 `Text(l10n.t("key"))`.
public final class RynL10nObservable: ObservableObject {
    /// 카탈로그가 바뀔 때마다 증가. SwiftUI 리렌더 트리거(objectWillChange).
    @Published public private(set) var version = 0
    public let client: RynL10nClient

    public init(client: RynL10nClient) {
        self.client = client
        client.onCatalogUpdated { [weak self] _ in
            guard let self else { return }
            // 프로덕션 앱은 메인 스레드에서 refresh하거나 여기서 메인 디스패치 권장.
            self.version &+= 1
        }
    }

    /// 동기 조회(항상 번들 fallback). 뷰 본문에서 직접 호출.
    public func t(_ key: String, args: [String: JSONValue] = [:], locale: String? = nil) -> String {
        client.t(key, args: args, locale: locale)
    }

    @discardableResult
    public func refresh(manifest: Manifest) -> Bool { client.refresh(manifest: manifest) }
}
