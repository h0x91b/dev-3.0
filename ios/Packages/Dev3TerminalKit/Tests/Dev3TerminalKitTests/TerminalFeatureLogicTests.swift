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

@Test("Only raw accessory Enter uses SwiftTerm text input")
func rawAccessoryEnterRouting() {
    #expect(Dev3TerminalAccessoryRouting.usesTerminalTextInput(key: .enter, inputMode: .raw))
    #expect(!Dev3TerminalAccessoryRouting.usesTerminalTextInput(key: .enter, inputMode: .compose))
    #expect(!Dev3TerminalAccessoryRouting.usesTerminalTextInput(key: .tab, inputMode: .raw))
    #expect(Dev3TerminalAccessoryKey.enter.bytes(control: false) == Data([0x0D]))
}

@Test("Raw submit revisions are idempotent and preserve coalesced taps")
func rawSubmitRevisionState() {
    var state = Dev3TerminalRawSubmitState()

    #expect(state.consume(0) == 0)
    #expect(state.consume(0) == 0)
    #expect(state.consume(2) == 2)
    #expect(state.consume(2) == 0)
    #expect(state.consume(3) == 1)
    #expect(state.consume(0) == 1)
}

@Test("Pinch resize defers transient grids until the final dimensions")
func pinchResizeGate() {
    var gate = Dev3TerminalResizeGate()

    #expect(gate.request(columns: 80, rows: 24) == Dev3TerminalGridSize(columns: 80, rows: 24))

    gate.beginGesture()
    #expect(gate.request(columns: 80, rows: 23) == nil)
    #expect(gate.request(columns: 80, rows: 22) == nil)
    #expect(gate.endGesture(columns: 80, rows: 21) == Dev3TerminalGridSize(columns: 80, rows: 21))
    #expect(gate.request(columns: 80, rows: 21) == Dev3TerminalGridSize(columns: 80, rows: 21))
}

@Test("Resize gate ignores invalid grid dimensions")
func pinchResizeGateRejectsInvalidDimensions() {
    var gate = Dev3TerminalResizeGate()

    #expect(gate.request(columns: 0, rows: 24) == nil)
    gate.beginGesture()
    #expect(gate.request(columns: 80, rows: 0) == nil)
    #expect(gate.endGesture(columns: 0, rows: 0) == nil)
}

@Test("Explicit terminal navigation creates redraw revisions, polls do not")
func terminalNavigationRefreshRevisions() {
    var refresh = Dev3TerminalNavigationRefresh()

    #expect(refresh.record(.observation) == nil)
    #expect(refresh.revision == 0)
    #expect(refresh.record(.paneSelection) == 1)
    #expect(refresh.record(.windowSelection) == 2)
    #expect(refresh.record(.paneSelection) == 3)
}

@Test("Resize accumulator keeps the latest valid grid across rapid zoom updates")
func terminalResizeAccumulatorKeepsLatestGrid() {
    var accumulator = Dev3TerminalResizeAccumulator()

    #expect(accumulator.update(columns: 80, rows: 44) == Dev3TerminalGridSize(columns: 80, rows: 44))
    #expect(accumulator.update(columns: 80, rows: 44) == nil)
    #expect(accumulator.update(columns: 80, rows: 43) == Dev3TerminalGridSize(columns: 80, rows: 43))
    #expect(accumulator.latest == Dev3TerminalGridSize(columns: 80, rows: 43))
}

@Test("Resize accumulator rejects invalid dimensions without dropping the latest grid")
func terminalResizeAccumulatorRejectsInvalidDimensions() {
    var accumulator = Dev3TerminalResizeAccumulator()

    #expect(accumulator.update(columns: 80, rows: 44) != nil)
    #expect(accumulator.update(columns: 0, rows: 0) == nil)
    #expect(accumulator.latest == Dev3TerminalGridSize(columns: 80, rows: 44))
}

@Test("Explicit pane and window selection request a PTY refresh, polling does not")
func terminalNavigationRefreshIntent() {
    #expect(Dev3TerminalNavigationRefresh.shouldRefreshTerminal(for: .paneSelection))
    #expect(Dev3TerminalNavigationRefresh.shouldRefreshTerminal(for: .windowSelection))
    #expect(!Dev3TerminalNavigationRefresh.shouldRefreshTerminal(for: .observation))
}
