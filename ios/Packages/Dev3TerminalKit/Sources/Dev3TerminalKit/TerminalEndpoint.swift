import Foundation

public enum Dev3TerminalConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int, delay: Duration)
    case needsResume
    case failed(message: String)
}

public struct Dev3TerminalEndpoint: Sendable {
    public let identity: String
    public let output: AsyncStream<Data>
    public let clipboardText: AsyncStream<String>
    public let connectionStates: AsyncStream<Dev3TerminalConnectionState>

    private let sendImplementation: @Sendable (Data) async throws -> Void
    private let resizeImplementation: @Sendable (Int, Int) async throws -> Void

    public init(
        identity: String,
        output: AsyncStream<Data>,
        clipboardText: AsyncStream<String> = .finished,
        connectionStates: AsyncStream<Dev3TerminalConnectionState> = .finished,
        send: @escaping @Sendable (Data) async throws -> Void,
        resize: @escaping @Sendable (Int, Int) async throws -> Void
    ) {
        self.identity = identity
        self.output = output
        self.clipboardText = clipboardText
        self.connectionStates = connectionStates
        sendImplementation = send
        resizeImplementation = resize
    }

    public func send(_ data: Data) async throws {
        try await sendImplementation(data)
    }

    public func resize(columns: Int, rows: Int) async throws {
        try await resizeImplementation(columns, rows)
    }
}

public extension AsyncStream {
    static var finished: AsyncStream<Element> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }
}
