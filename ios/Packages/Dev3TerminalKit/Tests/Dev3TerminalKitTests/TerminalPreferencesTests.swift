@testable import Dev3TerminalKit
import Foundation
import Testing

@Test("Font preferences persist independently per server")
func fontPreferencesPerServer() throws {
    let suiteName = "Dev3TerminalKitTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = Dev3TerminalFontPreferenceStore(defaults: defaults, keyPrefix: "font")

    store.setSize(17.5, for: "studio")
    store.setSize(11, for: "laptop")

    #expect(store.size(for: "studio") == 17.5)
    #expect(store.size(for: "laptop") == 11)
    #expect(store.size(for: "new") == Dev3TerminalFontPreferenceStore.defaultSize)
    store.reset(for: "studio")
    #expect(store.size(for: "studio") == Dev3TerminalFontPreferenceStore.defaultSize)
}

@Test("Font preferences clamp unsafe sizes")
func fontPreferenceBounds() {
    #expect(Dev3TerminalFontPreferenceStore.clamp(2) == 8)
    #expect(Dev3TerminalFontPreferenceStore.clamp(14) == 14)
    #expect(Dev3TerminalFontPreferenceStore.clamp(80) == 28)
}
