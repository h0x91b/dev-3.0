import Dev3Kit
import Foundation

public extension Dev3TerminalEndpoint {
    /// Adapts one visible PTY client without taking ownership of its connection lifecycle.
    init(
        identity: String,
        ptyClient: PTYClient,
        clipboardText: AsyncStream<String> = .finished
    ) {
        self.init(
            identity: identity,
            output: ptyClient.output,
            clipboardText: clipboardText,
            connectionStates: Self.connectionStates(from: ptyClient.states),
            send: { data in
                try await ptyClient.send(data)
            },
            resize: { columns, rows in
                try await ptyClient.resize(columns: columns, rows: rows)
            }
        )
    }

    static func connectionState(from state: PTYConnectionState) -> Dev3TerminalConnectionState {
        switch state {
        case .disconnected:
            .disconnected
        case .connecting:
            .connecting
        case .connected:
            .connected
        case let .reconnecting(_, attempt, delay, _):
            .reconnecting(attempt: attempt, delay: delay)
        case .needsResume:
            .needsResume
        case let .failed(_, error):
            .failed(message: error.localizedDescription)
        }
    }

    private static func connectionStates(
        from source: AsyncStream<PTYConnectionState>
    ) -> AsyncStream<Dev3TerminalConnectionState> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                for await state in source {
                    guard !Task.isCancelled else { break }
                    continuation.yield(connectionState(from: state))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

/// A task-scoped destination for events routed by the app's single RPC push consumer.
public struct Dev3TerminalEventChannel: Sendable {
    public let clipboardText: AsyncStream<String>

    private let taskID: String
    private let clipboardContinuation: AsyncStream<String>.Continuation

    public init(taskID: String) {
        self.taskID = taskID
        let pair = AsyncStream.makeStream(
            of: String.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        clipboardText = pair.stream
        clipboardContinuation = pair.continuation
    }

    /// Route each push here from AppStore; do not create another iterator over RPCClient.pushes.
    public func route(_ event: RPCPushEvent) {
        guard case let .osc52Clipboard(payload) = event else { return }
        routeClipboard(taskID: payload.taskId, text: payload.text)
    }

    public func finish() {
        clipboardContinuation.finish()
    }

    private func routeClipboard(taskID routedTaskID: String, text: String) {
        guard routedTaskID == taskID else { return }
        clipboardContinuation.yield(text)
    }
}
