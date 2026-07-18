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
            Dev3App.seedAutoPairIfRequested()
        #endif
        let runtime = ConnectionRuntime()
        self.runtime = runtime
        store = AppStore(runtime: runtime)
    }

    #if DEBUG
        /// DEBUG-only: seed a paired server from launch env so the Simulator can
        /// connect to a local dev3 without typing. Never compiled into Release.
        private static func seedAutoPairIfRequested() {
            let env = ProcessInfo.processInfo.environment
            guard let originStr = env["DEV3_AUTOPAIR_ORIGIN"],
                  let token = env["DEV3_AUTOPAIR_TOKEN"],
                  let origin = URL(string: originStr)
            else { return }
            do {
                let server = try PairedServer(
                    origin: origin,
                    sessionToken: token,
                    name: env["DEV3_AUTOPAIR_NAME"] ?? "Sim dev3",
                    instanceId: env["DEV3_AUTOPAIR_INSTANCE"] ?? "sim-autopair"
                )
                let snapshot = PairedServerSnapshot(servers: [server], activeInstanceId: server.instanceId)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let data = try encoder.encode(snapshot)
                try KeychainSecureDataStore().write(data, account: PairedServerStore.account)
            } catch {
                print("[autopair] seed failed: \(error)")
            }
        }

        /// DEBUG-only: once connected and the task has loaded, open its terminal
        /// so the Simulator lands straight on the screen under test. No-op in Release.
        @MainActor
        static func autoOpenTaskIfRequested(store: AppStore) async {
            let env = ProcessInfo.processInfo.environment
            guard let projectID = env["DEV3_AUTOOPEN_PROJECT"],
                  let taskID = env["DEV3_AUTOOPEN_TASK"]
            else { return }
            for _ in 0 ..< 60 {
                if store.isConnected, store.task(projectId: projectID, taskId: taskID) != nil {
                    store.openTask(projectId: projectID, taskId: taskID, from: .work)
                    return
                }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    #endif

    var body: some Scene {
        WindowGroup {
            CompanionAppRoot(
                store: store,
                runtime: runtime,
                notificationTapBridge: appDelegate.notificationTapBridge
            )
            .task {
                await store.start()
                #if DEBUG
                    await Dev3App.autoOpenTaskIfRequested(store: store)
                #endif
            }
            .onChange(of: scenePhase) { _, phase in
                store.sceneChanged(isActive: phase == .active)
            }
        }
    }
}
