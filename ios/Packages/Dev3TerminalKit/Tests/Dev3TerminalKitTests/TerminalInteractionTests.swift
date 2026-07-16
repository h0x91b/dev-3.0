@testable import Dev3TerminalKit
import Foundation
import Testing

private enum TerminalInteractionTestError: Error {
    case expected
}

private actor TerminalInteractionRecorder {
    private var payloads: [Data] = []
    private var focusStates: [Bool] = []

    func send(_ data: Data) {
        payloads.append(data)
    }

    func focus(_ active: Bool) {
        focusStates.append(active)
    }

    func recordedPayloads() -> [Data] {
        payloads
    }

    func recordedFocusStates() -> [Bool] {
        focusStates
    }
}

@Test("Bracketed paste is sent as one atomic DEC 2004 payload")
func bracketedPastePayload() async throws {
    let recorder = TerminalInteractionRecorder()
    let interaction = Dev3TerminalInteraction { data in
        await recorder.send(data)
    }
    interaction.updateBracketedPaste(true)

    try await interaction.paste("hello\nworld")

    #expect(await recorder.recordedPayloads() == [Data("\u{1B}[200~hello\nworld\u{1B}[201~".utf8)])
    #expect(try await interaction.hasBracketedPaste())
}

@Test("Raw paste and input preserve exact bytes")
func rawPasteAndInput() async throws {
    let recorder = TerminalInteractionRecorder()
    let interaction = Dev3TerminalInteraction { data in
        await recorder.send(data)
    }

    try await interaction.paste("λ")
    try await interaction.sendInput(Data([0x00, 0x0D, 0xFF]))

    #expect(await recorder.recordedPayloads() == [Data("λ".utf8), Data([0x00, 0x0D, 0xFF])])
    #expect(try await !interaction.hasBracketedPaste())
}

@Test("Terminal focus lifecycle acquires and releases exactly once")
func terminalFocusLifecycle() async throws {
    let recorder = TerminalInteractionRecorder()
    let lifecycle = Dev3TerminalFocusLifecycle { active in
        await recorder.focus(active)
    }

    try await lifecycle.setActive(true)
    try await lifecycle.connected()
    try await lifecycle.connected()
    try await lifecycle.setActive(false)
    try await lifecycle.setActive(true)
    await lifecycle.disconnecting()
    await lifecycle.disconnecting()

    #expect(await recorder.recordedFocusStates() == [true, false, true, false])
}

@Test("A failed focus acquire remains retryable")
func failedFocusAcquire() async throws {
    let recorder = TerminalInteractionRecorder()
    let attempts = AttemptCounter()
    let lifecycle = Dev3TerminalFocusLifecycle { active in
        await recorder.focus(active)
        if await attempts.incremented() == 1 {
            throw TerminalInteractionTestError.expected
        }
    }

    try await lifecycle.setActive(true)
    await #expect(throws: TerminalInteractionTestError.self) {
        try await lifecycle.connected()
    }
    try await lifecycle.connected()
    await lifecycle.disconnecting()

    #expect(await recorder.recordedFocusStates() == [true, true, false])
}

private actor AttemptCounter {
    private var value = 0

    func incremented() -> Int {
        value += 1
        return value
    }
}
