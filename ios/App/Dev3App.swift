import Dev3Kit
import Dev3UI
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class Dev3AppDelegate: NSObject, UIApplicationDelegate {
    let notificationTapBridge = NotificationTapBridge()

    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = notificationTapBridge
        return true
    }
}

@main
@MainActor
struct Dev3App: App {
    @UIApplicationDelegateAdaptor(Dev3AppDelegate.self) private var appDelegate
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
            CompanionAppRoot(
                store: store,
                runtime: runtime,
                notificationTapBridge: appDelegate.notificationTapBridge
            )
            .task {
                await store.start()
            }
            .onChange(of: scenePhase) { _, phase in
                store.sceneChanged(isActive: phase == .active)
            }
        }
    }
}
