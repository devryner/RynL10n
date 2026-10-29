__CLIENT__

@main struct GuideRuntime {
    @MainActor static func main() async throws {
        precondition(L10n.client.t("home.title", locale: "en") == "Home")
        precondition(L10n.client.t("cart.items", args: ["n": .int(2)], locale: "en") == "2 items")
        precondition(L10n.client.t("home.title", locale: "ja") == "ホーム")
        let observable = RynL10nObservable(client: L10n.client)
        let changed = try await L10n.remote.update(L10n.client)
        precondition(changed && observable.version > 0)
        precondition(observable.t("home.title", locale: "en") == "Updated Home")
__POLLING__
__PUSH__
__TELEMETRY__
        let sent = await reporter.flush(L10n.client)
        precondition(sent)
        reporter.stop()
        push.stop()
        L10n.remote.stopPolling()

        let bakedSnapshot = try Snapshot.baked(in: .main)
        let cdnStore = L10n.remote
        let manifest = try await cdnStore.loadManifest()
__CORE__
        precondition(s == "⟪pay.button⟫")
        print("PASS Swift bundle, query, locale, delivery, observable, polling, push and telemetry")
    }
}
