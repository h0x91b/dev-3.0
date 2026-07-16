import Dev3UI

public struct Dev3ResolvedTerminalTheme: Sendable {
    public let background: Dev3RGBA
    public let foreground: Dev3RGBA
    public let cursor: Dev3RGBA
    public let selectionBackground: Dev3RGBA
    public let ansi: [Dev3RGBA]

    public init(palette: Dev3ThemePalette) {
        let terminal = palette.terminal
        background = terminal.backgroundValue
        foreground = terminal.foregroundValue
        cursor = terminal.cursorValue
        selectionBackground = terminal.selectionBackgroundValue
        ansi = [
            terminal.blackValue,
            terminal.redValue,
            terminal.greenValue,
            terminal.yellowValue,
            terminal.blueValue,
            terminal.magentaValue,
            terminal.cyanValue,
            terminal.whiteValue,
            terminal.brightBlackValue,
            terminal.brightRedValue,
            terminal.brightGreenValue,
            terminal.brightYellowValue,
            terminal.brightBlueValue,
            terminal.brightMagentaValue,
            terminal.brightCyanValue,
            terminal.brightWhiteValue
        ]
    }
}
