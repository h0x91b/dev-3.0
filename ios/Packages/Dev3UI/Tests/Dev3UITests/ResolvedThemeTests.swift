import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@Test("Resolved instance theme wins over the stored preference")
func resolvedInstanceThemeWins() throws {
    let settings = try globalSettings(theme: "light", resolvedTheme: "dark")
    #expect(Dev3ResolvedThemeMode(settings: settings) == .dark)
}

@Test("Invalid, system, and missing instance themes use the backend dark fallback")
func invalidInstanceThemeFallsBackToDark() throws {
    #expect(try Dev3ResolvedThemeMode(settings: globalSettings(theme: "system")) == .dark)
    #expect(try Dev3ResolvedThemeMode(settings: globalSettings(theme: "future")) == .dark)
    #expect(try Dev3ResolvedThemeMode(settings: globalSettings()) == .dark)
    #expect(try Dev3ResolvedThemeMode(settings: globalSettings(theme: "light")) == .light)
}

private func globalSettings(
    theme: String? = nil,
    resolvedTheme: String? = nil
) throws -> Dev3GlobalSettings {
    var fields = [
        #""defaultAgentId":"builtin-codex""#,
        #""defaultConfigId":"luna""#,
        #""taskDropPosition":"top""#,
        #""updateChannel":"stable""#
    ]
    if let theme {
        fields.append(#""theme":"\#(theme)""#)
    }
    if let resolvedTheme {
        fields.append(#""resolvedTheme":"\#(resolvedTheme)""#)
    }
    let data = Data("{\(fields.joined(separator: ","))}".utf8)
    return try JSONDecoder().decode(Dev3GlobalSettings.self, from: data)
}
