import Dev3Kit
import Dev3UI
import SwiftUI

@main
@MainActor
struct Dev3App: App {
    @Environment(\.scenePhase) private var scenePhase

    private let runtime: ConnectionRuntime?
    private let store: AppStore

    init() {
        #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--uitesting") {
                runtime = nil
                store = AppStore(controller: UITestDependencies.makeController())
                return
            }
        #endif
        let runtime = ConnectionRuntime()
        self.runtime = runtime
        store = AppStore(runtime: runtime)
    }

    var body: some Scene {
        WindowGroup {
            CompanionAppRoot(store: store, runtime: runtime)
                .task {
                    await store.start()
                }
                .onChange(of: scenePhase) { _, phase in
                    store.sceneChanged(isActive: phase == .active)
                }
        }
    }
}
