@testable import Dev3TerminalKit
import Dev3UI
import Testing

@Test("Terminal themes preserve generated desktop palettes")
func terminalThemeMapping() {
    let dark = Dev3ResolvedTerminalTheme(palette: Dev3Theme.dark)
    let light = Dev3ResolvedTerminalTheme(palette: Dev3Theme.light)

    #expect(dark.ansi.count == 16)
    #expect(light.ansi.count == 16)
    #expect(dark.background == Dev3RGBA(red: 26, green: 27, blue: 38))
    #expect(dark.ansi[1] == Dev3RGBA(red: 247, green: 118, blue: 142))
    #expect(light.background == Dev3RGBA(red: 255, green: 255, blue: 255))
    #expect(light.ansi[12] == Dev3RGBA(red: 3, green: 102, blue: 214))
    #expect(light.selectionBackground.opacity == 0.145_098)
}
