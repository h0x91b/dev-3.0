@testable import Dev3TerminalKit
import Foundation
import Testing

private enum SubmitTestError: Error {
    case expected
}

private actor SubmitEventRecorder {
    private var events: [String] = []

    func record(_ event: String) {
        events.append(event)
    }

    func snapshot() -> [String] {
        events
    }
}

private struct SubmitTransport: Dev3TerminalSubmitTransport {
    let recorder: SubmitEventRecorder
    var bracketedPaste = false
    var modeFails = false
    var pasteFails = false
    var submitFails = false

    func hasBracketedPaste() async throws -> Bool {
        await recorder.record("mode")
        if modeFails {
            throw SubmitTestError.expected
        }
        return bracketedPaste
    }

    func paste(_ text: String) async throws {
        await recorder.record("paste:\(text)")
        if pasteFails {
            throw SubmitTestError.expected
        }
    }

    func sendInput(_ data: Data) async throws {
        await recorder.record("send:\(data.hex)")
        if submitFails {
            throw SubmitTestError.expected
        }
    }
}

private struct SubmitScheduler: Dev3TerminalSubmitScheduling {
    let recorder: SubmitEventRecorder
    var fails = false

    func sleep(for duration: Duration) async throws {
        await recorder.record("sleep:\(duration.components.seconds):\(duration.components.attoseconds)")
        if fails {
            throw SubmitTestError.expected
        }
    }
}

@Test("DEC 2004 submits one carriage return immediately")
func bracketedPasteSubmit() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder, bracketedPaste: true)
    let scheduler = SubmitScheduler(recorder: recorder)

    let outcome = await Dev3TerminalSubmit.pastedText(
        "run the tests",
        transport: transport,
        scheduler: scheduler
    )

    #expect(outcome == .submittedImmediately)
    #expect(await recorder.snapshot() == ["mode", "paste:run the tests", "send:0d"])
}

@Test("Raw paste waits exactly 150 milliseconds before one carriage return")
func unbracketedPasteSubmit() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder)
    let scheduler = SubmitScheduler(recorder: recorder)

    let outcome = await Dev3TerminalSubmit.pastedText(
        "prompt",
        transport: transport,
        scheduler: scheduler
    )

    #expect(outcome == .submittedAfterSettle)
    #expect(
        await recorder.snapshot() == [
            "mode",
            "paste:prompt",
            "sleep:0:150000000000000000",
            "send:0d"
        ]
    )
    #expect(Dev3TerminalSubmit.unbracketedPasteSettleDelay == .milliseconds(150))
}

@Test("Mode query failure uses the safe delayed path")
func modeQueryFailure() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder, modeFails: true)
    let scheduler = SubmitScheduler(recorder: recorder)

    let outcome = await Dev3TerminalSubmit.pastedText("prompt", transport: transport, scheduler: scheduler)

    #expect(outcome == .submittedAfterSettle)
    #expect(await (recorder.snapshot()).contains("sleep:0:150000000000000000"))
}

@Test("Paste failure sends and schedules nothing")
func pasteFailure() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder, bracketedPaste: true, pasteFails: true)
    let scheduler = SubmitScheduler(recorder: recorder)

    let outcome = await Dev3TerminalSubmit.pastedText("prompt", transport: transport, scheduler: scheduler)

    #expect(outcome == .pasteFailed)
    #expect(await recorder.snapshot() == ["mode", "paste:prompt"])
}

@Test("Cancelled settle never sends carriage return")
func settleCancellation() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder)
    let scheduler = SubmitScheduler(recorder: recorder, fails: true)

    let outcome = await Dev3TerminalSubmit.pastedText("prompt", transport: transport, scheduler: scheduler)

    #expect(outcome == .settleCancelled)
    #expect(
        await recorder.snapshot() == [
            "mode",
            "paste:prompt",
            "sleep:0:150000000000000000"
        ]
    )
}

@Test("Submit transport failure is reported after exactly one send attempt")
func submitFailure() async {
    let recorder = SubmitEventRecorder()
    let transport = SubmitTransport(recorder: recorder, bracketedPaste: true, submitFails: true)

    let outcome = await Dev3TerminalSubmit.pastedText("prompt", transport: transport)

    #expect(outcome == .submitFailed)
    #expect(await recorder.snapshot() == ["mode", "paste:prompt", "send:0d"])
}

private extension Data {
    var hex: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
