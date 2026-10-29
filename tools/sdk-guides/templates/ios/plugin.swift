import Foundation
import RynL10n

let snapshot = try Snapshot.baked(in: .module)
let client = RynL10nClient(bundle: snapshot, store: InMemoryDeliveryStore(), context: .init(appVersion: "1.0.0"))
precondition(client.t("home.title", locale: "en") == "Home")
print("PASS summary plugin target baked resource load")
