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
