import Dev3Kit
@testable import Dev3UI
import SwiftUI
import Testing

@Test("Companion root view is constructible on supported platforms")
@MainActor
func companionRootViewConstruction() {
    let runtime = ConnectionRuntime()
    _ = CompanionRootView(
        store: AppStore(runtime: runtime),
        settingsAccessoryBuilder: {
            AnyView(Section("Notifications") { Text("Preferences") })
        }
    )
}

@Test("Offline task info remains read-only after the app reconnects")
func offlineTaskInfoConnectionPolicy() {
    let offline = TaskInfoConnectionPolicy(hasLiveService: false)
    #expect(offline.canMutate(isConnected: false) == false)
    #expect(offline.canMutate(isConnected: true) == false)

    let live = TaskInfoConnectionPolicy(hasLiveService: true)
    #expect(live.canMutate(isConnected: false) == false)
    #expect(live.canMutate(isConnected: true))
}

@Test("Todo taps run only while connected and never open an unavailable terminal")
func taskOpenRouting() {
    let todo = makeIATask(id: "todo", status: .todo)
    let active = makeIATask(id: "active", status: .inProgress)

    #expect(CompanionTaskOpenRoute.resolve(task: todo, isConnected: true) == .run)
    #expect(CompanionTaskOpenRoute.resolve(task: todo, isConnected: false) == .info)
    #expect(CompanionTaskOpenRoute.resolve(task: active, isConnected: true) == .terminal)
    #expect(CompanionTaskOpenRoute.resolve(task: active, isConnected: false) == .info)
}
