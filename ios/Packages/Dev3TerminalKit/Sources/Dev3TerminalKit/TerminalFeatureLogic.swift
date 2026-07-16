import Foundation

public enum Dev3TerminalPaneSwipeDecision: Equatable, Sendable {
    case previous
    case next
    case ignore

    public static func decide(horizontal: Double, vertical: Double, paneCount: Int) -> Self {
        guard paneCount > 1,
              abs(horizontal) >= 54,
              abs(horizontal) > abs(vertical) * 1.4 else { return .ignore }
        return horizontal < 0 ? .next : .previous
    }
}

public enum Dev3TerminalAccessoryKey: String, CaseIterable, Identifiable, Sendable {
    case escape = "Esc"
    case control = "Ctrl"
    case tab = "Tab"
    case left = "←"
    case down = "↓"
    case up = "↑"
    case right = "→"
    case enter = "Enter"
    case pipe = "|"
    case tilde = "~"
    case dash = "-"
    case slash = "/"
    case backslash = "\\"

    public var id: String {
        rawValue
    }

    public func bytes(control: Bool) -> Data? {
        (control ? Self.controlBytes : Self.standardBytes)[self]
    }

    private static let standardBytes: [Self: Data] = [
        .escape: Data([0x1B]),
        .tab: Data([0x09]),
        .left: Data("\u{1B}[D".utf8),
        .down: Data("\u{1B}[B".utf8),
        .up: Data("\u{1B}[A".utf8),
        .right: Data("\u{1B}[C".utf8),
        .enter: Data([0x0D]),
        .pipe: Data("|".utf8),
        .tilde: Data("~".utf8),
        .dash: Data("-".utf8),
        .slash: Data("/".utf8),
        .backslash: Data("\\".utf8)
    ]

    private static let controlBytes: [Self: Data] = [
        .escape: Data([0x1B]),
        .tab: Data([0x09]),
        .left: Data("\u{1B}[1;5D".utf8),
        .down: Data("\u{1B}[1;5B".utf8),
        .up: Data("\u{1B}[1;5A".utf8),
        .right: Data("\u{1B}[1;5C".utf8),
        .enter: Data([0x0D]),
        .pipe: Data([0x1C]),
        .backslash: Data([0x1C]),
        .dash: Data([0x1F]),
        .slash: Data([0x1F]),
        .tilde: Data([0x1E])
    ]
}
