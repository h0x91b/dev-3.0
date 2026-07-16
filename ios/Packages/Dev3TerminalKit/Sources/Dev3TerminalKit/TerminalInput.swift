import Foundation

public enum Dev3TerminalInputMode: String, CaseIterable, Sendable {
    case compose
    case raw

    public var acceptsDirectTerminalInput: Bool {
        self == .raw
    }
}

public enum Dev3TerminalFunctionalKey: String, CaseIterable, Sendable {
    case tab
    case enter
    case home
    case end
    case insert
    case delete
    case pageUp
    case pageDown
    case f1
    case f2
    case f3
    case f4
    case f5
    case f6
    case f7
    case f8
    case f9
    case f10
    case f11
    case f12
}

public enum Dev3TerminalInputEncoder {
    public static let shiftEnter = Data([0x1B, 0x0D])

    private static let shiftSequences: [Dev3TerminalFunctionalKey: Data] = [
        .tab: Data("\u{1B}[Z".utf8),
        .enter: shiftEnter,
        .home: Data("\u{1B}[1;2H".utf8),
        .end: Data("\u{1B}[1;2F".utf8),
        .insert: Data("\u{1B}[2;2~".utf8),
        .delete: Data("\u{1B}[3;2~".utf8),
        .pageUp: Data("\u{1B}[5;2~".utf8),
        .pageDown: Data("\u{1B}[6;2~".utf8),
        .f1: Data("\u{1B}[1;2P".utf8),
        .f2: Data("\u{1B}[1;2Q".utf8),
        .f3: Data("\u{1B}[1;2R".utf8),
        .f4: Data("\u{1B}[1;2S".utf8),
        .f5: Data("\u{1B}[15;2~".utf8),
        .f6: Data("\u{1B}[17;2~".utf8),
        .f7: Data("\u{1B}[18;2~".utf8),
        .f8: Data("\u{1B}[19;2~".utf8),
        .f9: Data("\u{1B}[20;2~".utf8),
        .f10: Data("\u{1B}[21;2~".utf8),
        .f11: Data("\u{1B}[23;2~".utf8),
        .f12: Data("\u{1B}[24;2~".utf8)
    ]

    public static func shiftSequence(
        for key: Dev3TerminalFunctionalKey,
        hasControl: Bool = false,
        hasAlternate: Bool = false,
        hasCommand: Bool = false
    ) -> Data? {
        guard !hasControl, !hasAlternate, !hasCommand else { return nil }
        return shiftSequences[key]
    }
}
