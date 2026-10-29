import SwiftUI
import UIKit
import RynL10n
__CLIENT__
__APP__

struct FragmentView: View {
    @Environment(\.scenePhase) var scenePhase
    let count = 2
    var body: some View {
        VStack {
__LOOKUP__
        }
__FOREGROUND__
__SCENE__
    }
}

class AppDelegate: UIResponder, UIApplicationDelegate {
__DELEGATE__
}

@MainActor func automation() {
__POLLING__
__PUSH__
__TELEMETRY__
__INSTALL_ID__
    precondition(!installId.isEmpty)
    reporter.stop()
    push.stop()
    L10n.remote.stopPolling()
}
