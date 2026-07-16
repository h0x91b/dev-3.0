@testable import Dev3UI
import SwiftUI
import Testing

@Test("Companion root view is constructible on supported platforms")
@MainActor
func companionRootViewConstruction() {
    _ = CompanionRootView()
}
