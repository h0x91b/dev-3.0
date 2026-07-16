import Dev3Kit
import Dev3UI
import SwiftUI

@main
@MainActor
struct Dev3App: App {
    @Environment(\.scenePhase) private var scenePhase

    private let runtime: ConnectionRuntime?
    private let controller: ConnectionController

    init() {
        #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--uitesting") {
                runtime = nil
                controller = UITestDependencies.makeController()
                return
            }
        #endif
        let runtime = ConnectionRuntime()
        self.runtime = runtime
        controller = runtime.controller
    }

    var body: some Scene {
        WindowGroup {
            CompanionRootView(controller: controller)
                .task {
                    await controller.start()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        controller.foregrounded()
                    }
                }
        }
    }
}
