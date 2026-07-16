@testable import Dev3TerminalKit
import Foundation
import Testing

struct SwipeCase: Sendable {
    let horizontal: Double
    let vertical: Double
    let panes: Int
    let expected: Dev3TerminalPaneSwipeDecision
}

struct KeyCase: Sendable {
    let key: Dev3TerminalAccessoryKey
    let control: Bool
    let expected: Data
}

@Test("Pane swipe requires a dominant horizontal gesture and multiple panes", arguments: [
    SwipeCase(horizontal: -80, vertical: 12, panes: 2, expected: .next),
    SwipeCase(horizontal: 80, vertical: 12, panes: 2, expected: .previous),
    SwipeCase(horizontal: -80, vertical: 70, panes: 2, expected: .ignore),
    SwipeCase(horizontal: -53, vertical: 0, panes: 2, expected: .ignore),
    SwipeCase(horizontal: -80, vertical: 0, panes: 1, expected: .ignore)
])
func paneSwipeDecision(input: SwipeCase) {
    #expect(
        Dev3TerminalPaneSwipeDecision.decide(
            horizontal: input.horizontal,
            vertical: input.vertical,
            paneCount: input.panes
        ) == input.expected
    )
}

@Test("Accessory keys encode terminal sequences", arguments: [
    KeyCase(key: .escape, control: false, expected: Data([0x1B])),
    KeyCase(key: .tab, control: false, expected: Data([0x09])),
    KeyCase(key: .left, control: false, expected: Data("\u{1B}[D".utf8)),
    KeyCase(key: .right, control: true, expected: Data("\u{1B}[1;5C".utf8)),
    KeyCase(key: .enter, control: false, expected: Data([0x0D])),
    KeyCase(key: .slash, control: true, expected: Data([0x1F])),
    KeyCase(key: .pipe, control: false, expected: Data("|".utf8))
])
func accessoryKeyEncoding(input: KeyCase) {
    #expect(input.key.bytes(control: input.control) == input.expected)
}

@Test("Control is a latch and does not emit bytes")
func controlLatchHasNoBytes() {
    #expect(Dev3TerminalAccessoryKey.control.bytes(control: false) == nil)
    #expect(Dev3TerminalAccessoryKey.control.bytes(control: true) == nil)
}
