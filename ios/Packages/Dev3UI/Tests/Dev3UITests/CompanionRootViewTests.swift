import Dev3Kit
@testable import Dev3UI
import SwiftUI
import Testing

@Test("Companion root view is constructible on supported platforms")
@MainActor
func companionRootViewConstruction() {
    let runtime = ConnectionRuntime()
    _ = CompanionRootView(store: AppStore(runtime: runtime))
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
