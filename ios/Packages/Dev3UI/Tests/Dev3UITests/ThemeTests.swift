@testable import Dev3UI
import Testing

@Suite("Generated native theme")
struct ThemeTests {
    @Test("Semantic colors match desktop dark and light tokens")
    func semanticColors() {
        #expect(Dev3Theme.dark.value(.surfaceBase) == Dev3RGBA(red: 6, green: 9, blue: 21))
        #expect(Dev3Theme.light.value(.surfaceBase) == Dev3RGBA(red: 240, green: 242, blue: 250))
        #expect(Dev3Theme.dark.value(.accent) == Dev3RGBA(red: 68, green: 150, blue: 255))
        #expect(Dev3Theme.light.value(.accent) == Dev3RGBA(red: 59, green: 130, blue: 246))
        #expect(Dev3Theme.dark.value(.glassCard).opacity == 0.04)
        #expect(Dev3Theme.light.value(.glassCard).opacity == 0.72)
    }

    @Test("Status tokens retain wire names without owning the domain model")
    func statusTokens() {
        #expect(Dev3StatusToken.allCases.count == 8)
        #expect(Dev3StatusToken.inProgress.rawValue == "in-progress")
        #expect(Dev3Theme.dark.statusValue(.completed) == Dev3RGBA(red: 60, green: 243, blue: 176))
        #expect(Dev3Theme.light.statusValue(.cancelled) == Dev3RGBA(red: 220, green: 38, blue: 38))
    }

    @Test("Label palette and terminal ANSI colors are generated")
    func categoricalPalettes() {
        #expect(Dev3Theme.dark.labelValues.count == 12)
        #expect(Dev3Theme.dark.labelValues == Dev3Theme.light.labelValues)
        #expect(Dev3Theme.dark.terminal.backgroundValue == Dev3RGBA(red: 26, green: 27, blue: 38))
        #expect(Dev3Theme.light.terminal.blueValue == Dev3RGBA(red: 0, green: 92, blue: 197))
        #expect(abs(Dev3Theme.light.terminal.selectionBackgroundValue.opacity - (37.0 / 255.0)) < 0.000_001)
    }

    @Test("Raw source manifest covers non-native CSS metadata")
    func sourceManifest() {
        #expect(Dev3ThemeSourceTokens.dark.keys == Dev3ThemeSourceTokens.light.keys)
        #expect(Dev3ThemeSourceTokens.dark.count > 50)
        #expect(Dev3ThemeSourceTokens.dark["shadow-column"]?.contains("rgb(0 0 0 / 0.3)") == true)
        #expect(Dev3ThemeSourceTokens.light["bg-grad-angle"] == "135deg")
    }

    @Test("Nerd Font constants preserve supplementary-plane code points")
    func nerdFontGlyphs() {
        #expect(Dev3Glyph.fontName == "JetBrainsMono Nerd Font Mono")
        #expect(Dev3Glyph.fileTree.unicodeScalars.first?.value == 0xF0645)
        #expect(Dev3Glyph.windows.unicodeScalars.first?.value == 0xF05C2)
        #expect(Dev3Glyph.terminal.unicodeScalars.first?.value == 0xF120)
    }
}
