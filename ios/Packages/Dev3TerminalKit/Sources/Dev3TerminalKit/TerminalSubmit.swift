import Foundation

public protocol Dev3TerminalSubmitTransport: Sendable {
    func hasBracketedPaste() async throws -> Bool
    func paste(_ text: String) async throws
    func sendInput(_ data: Data) async throws
}

public protocol Dev3TerminalSubmitScheduling: Sendable {
    func sleep(for duration: Duration) async throws
}

public struct Dev3ContinuousTerminalSubmitScheduler: Dev3TerminalSubmitScheduling {
    public init() {}

    public func sleep(for duration: Duration) async throws {
        try await ContinuousClock().sleep(for: duration)
    }
}

public enum Dev3TerminalSubmitOutcome: Equatable, Sendable {
    case submittedImmediately
    case submittedAfterSettle
    case pasteFailed
    case settleCancelled
    case submitFailed
}

public enum Dev3TerminalSubmit {
    public static let unbracketedPasteSettleDelay = Duration.milliseconds(150)
    public static let carriageReturn = Data([0x0D])

    @discardableResult
    public static func pastedText(
        _ text: String,
        transport: any Dev3TerminalSubmitTransport,
        scheduler: any Dev3TerminalSubmitScheduling = Dev3ContinuousTerminalSubmitScheduler()
    ) async -> Dev3TerminalSubmitOutcome {
        let hasBracketedPaste = await (try? transport.hasBracketedPaste()) ?? false

        do {
            try await transport.paste(text)
        } catch {
            return .pasteFailed
        }

        if !hasBracketedPaste {
            do {
                try await scheduler.sleep(for: unbracketedPasteSettleDelay)
            } catch {
                return .settleCancelled
            }
        }

        do {
            try await transport.sendInput(carriageReturn)
            return hasBracketedPaste ? .submittedImmediately : .submittedAfterSettle
        } catch {
            return .submitFailed
        }
    }
}
