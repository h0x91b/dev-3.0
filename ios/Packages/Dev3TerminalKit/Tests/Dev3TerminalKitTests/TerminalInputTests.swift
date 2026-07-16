@testable import Dev3TerminalKit
import Foundation
import Testing

@Test("Shift functional keys match the desktop tmux sequences")
func shiftFunctionalKeys() throws {
    let expected: [Dev3TerminalFunctionalKey: String] = [
        .tab: "\u{1B}[Z",
        .enter: "\u{1B}\r",
        .home: "\u{1B}[1;2H",
        .end: "\u{1B}[1;2F",
        .insert: "\u{1B}[2;2~",
        .delete: "\u{1B}[3;2~",
        .pageUp: "\u{1B}[5;2~",
        .pageDown: "\u{1B}[6;2~",
        .f1: "\u{1B}[1;2P",
        .f2: "\u{1B}[1;2Q",
        .f3: "\u{1B}[1;2R",
        .f4: "\u{1B}[1;2S",
        .f5: "\u{1B}[15;2~",
        .f6: "\u{1B}[17;2~",
        .f7: "\u{1B}[18;2~",
        .f8: "\u{1B}[19;2~",
        .f9: "\u{1B}[20;2~",
        .f10: "\u{1B}[21;2~",
        .f11: "\u{1B}[23;2~",
        .f12: "\u{1B}[24;2~"
    ]

    #expect(expected.count == Dev3TerminalFunctionalKey.allCases.count)
    for key in Dev3TerminalFunctionalKey.allCases {
        let sequence = try #require(Dev3TerminalInputEncoder.shiftSequence(for: key))
        #expect(String(bytes: sequence, encoding: .utf8) == expected[key])
    }
    #expect(Dev3TerminalInputEncoder.shiftEnter == Data([0x1B, 0x0D]))
}

@Test("Shift overrides reject additional modifiers")
func shiftModifierGuard() {
    #expect(Dev3TerminalInputEncoder.shiftSequence(for: .enter, hasControl: true) == nil)
    #expect(Dev3TerminalInputEncoder.shiftSequence(for: .enter, hasAlternate: true) == nil)
    #expect(Dev3TerminalInputEncoder.shiftSequence(for: .enter, hasCommand: true) == nil)
}

@Test("Compose mode cannot focus the raw terminal")
func composeModeGuard() {
    #expect(!Dev3TerminalInputMode.compose.acceptsDirectTerminalInput)
    #expect(Dev3TerminalInputMode.raw.acceptsDirectTerminalInput)
}
