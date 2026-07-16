@testable import Dev3TerminalKit
import Dev3UI
import SwiftUI
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

@Test("Instance terminal themes override opposite device appearances")
func instanceThemeOverridesDevice() {
    let darkOnLight = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: .dark,
        deviceColorScheme: .light
    )
    let lightOnDark = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: .light,
        deviceColorScheme: .dark
    )
    let missingOnLight = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: nil,
        deviceColorScheme: .light
    )

    #expect(darkOnLight.effectiveMode == .dark)
    #expect(lightOnDark.effectiveMode == .light)
    #expect(missingOnLight.effectiveMode == .dark)
}

@Test("Equivalent effective terminal themes apply only once")
func effectiveThemeAppliesOnce() {
    var state = Dev3TerminalThemeApplicationState()
    let darkOnLight = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: .dark,
        deviceColorScheme: .light
    )
    let darkOnDark = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: .dark,
        deviceColorScheme: .dark
    )
    let lightOnDark = Dev3TerminalThemeConfiguration(
        instanceResolvedTheme: .light,
        deviceColorScheme: .dark
    )

    let firstApply = state.shouldApply(darkOnLight)
    let repeatedApply = state.shouldApply(darkOnDark)
    let changedApply = state.shouldApply(lightOnDark)

    #expect(firstApply)
    #expect(!repeatedApply)
    #expect(changedApply)
}
