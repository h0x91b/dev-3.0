import Dev3Kit

public enum Dev3ResolvedThemeMode: String, Sendable {
    case dark
    case light

    public init(settings: Dev3GlobalSettings) {
        if let resolvedTheme = settings.resolvedTheme.flatMap(Self.init(rawValue:)) {
            self = resolvedTheme
        } else if let explicitTheme = settings.theme.flatMap(Self.init(rawValue:)) {
            self = explicitTheme
        } else {
            self = .dark
        }
    }
}
