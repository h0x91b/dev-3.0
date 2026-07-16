@testable import Dev3Kit
@testable import Dev3TerminalKit
import Foundation
import Testing

private struct AdapterRequestBuilder: AuthenticatedRequestBuilding {
    func authenticatedRequest(path: String, queryItems: [URLQueryItem]) throws -> URLRequest {
        guard var components = URLComponents(string: "https://dev3.test") else {
            throw URLError(.badURL)
        }
        components.path = path
        components.queryItems = queryItems
        guard let url = components.url else { throw URLError(.badURL) }
        return URLRequest(url: url)
    }
}

private struct AdapterTransportFactory: WebSocketTransportCreating {
    let transport: AdapterTransport

    func makeTransport(for _: URLRequest) -> any WebSocketTransport {
        transport
    }
}

private actor AdapterTransport: WebSocketTransport {
    private var sentFrames: [WebSocketFrame] = []
    private var queuedFrames: [WebSocketFrame] = []
    private var receiveContinuation: CheckedContinuation<WebSocketFrame, any Error>?

    func connect() async throws {}

    func send(_ frame: WebSocketFrame) async throws {
        sentFrames.append(frame)
    }

    func receive() async throws -> WebSocketFrame {
        if !queuedFrames.isEmpty {
            return queuedFrames.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func disconnect(code: Int, reason: String) async {
        receiveContinuation?.resume(throwing: WebSocketTransportError.closed(code: code, reason: reason))
        receiveContinuation = nil
    }

    func emit(_ frame: WebSocketFrame) {
        if let receiveContinuation {
            self.receiveContinuation = nil
            receiveContinuation.resume(returning: frame)
        } else {
            queuedFrames.append(frame)
        }
    }

    func frames() -> [WebSocketFrame] {
        sentFrames
    }
}

@Test("PTY adapter forwards output, input, resize, and transport-neutral state")
func ptyAdapterForwardsTransport() async throws {
    let transport = AdapterTransport()
    let client = PTYClient(
        requestBuilder: AdapterRequestBuilder(),
        transportFactory: AdapterTransportFactory(transport: transport),
        reconnectDelays: [.seconds(60)],
        resizeInterval: .zero
    )
    let endpoint = Dev3TerminalEndpoint(identity: "task-a", ptyClient: client)
    var output = endpoint.output.makeAsyncIterator()
    var states = endpoint.connectionStates.makeAsyncIterator()

    #expect(await states.next() == .disconnected)
    try await client.connect(to: .task("task-a"))
    let stateAfterConnect = await states.next()
    if stateAfterConnect == .connecting {
        #expect(await states.next() == .connected)
    } else {
        #expect(stateAfterConnect == .connected)
    }

    try await endpoint.send(Data("pwd\r".utf8))
    try await endpoint.resize(columns: 84, rows: 26)
    await transport.emit(.data(Data("/tmp\r\n".utf8)))

    #expect(await output.next() == Data("/tmp\r\n".utf8))
    #expect(await transport.frames() == [
        .data(Data("pwd\r".utf8)),
        .text("\u{1B}]resize;84;26\u{7}")
    ])

    await client.disconnect()
}

@Test("PTY state mapping removes transport session and error details")
func ptyStateMapping() throws {
    let session = PTYSession.task("task-a")
    let sessionState = try JSONDecoder().decode(
        Dev3TaskSessionState.self,
        from: Data(#"{"panes":[]}"#.utf8)
    )

    #expect(Dev3TerminalEndpoint.connectionState(from: .disconnected) == .disconnected)
    #expect(Dev3TerminalEndpoint.connectionState(from: .connecting(session)) == .connecting)
    #expect(Dev3TerminalEndpoint.connectionState(from: .connected(session)) == .connected)
    #expect(
        Dev3TerminalEndpoint.connectionState(
            from: .reconnecting(
                session: session,
                attempt: 3,
                delay: .seconds(8),
                cause: .serverUnavailable("retry")
            )
        ) == .reconnecting(attempt: 3, delay: .seconds(8))
    )
    #expect(
        Dev3TerminalEndpoint.connectionState(
            from: .needsResume(session: session, state: sessionState)
        ) == .needsResume
    )
    #expect(
        Dev3TerminalEndpoint.connectionState(
            from: .failed(session: session, error: .unknownSession("Task ended"))
        ) == .failed(message: "Task ended")
    )
}

@Test("Task event channel routes only matching OSC52 clipboard text")
func taskEventChannelFiltersClipboard() async {
    let channel = Dev3TerminalEventChannel(taskID: "task-a")
    var clipboard = channel.clipboardText.makeAsyncIterator()

    channel.route(.qrTokenConsumed)
    channel.route(.osc52Clipboard(OSC52ClipboardPush(
        taskId: "task-b",
        text: "wrong task",
        len: 10
    )))
    channel.route(.osc52Clipboard(OSC52ClipboardPush(
        taskId: "task-a",
        text: "first",
        len: 5
    )))
    #expect(await clipboard.next() == "first")

    channel.route(.osc52Clipboard(OSC52ClipboardPush(
        taskId: "task-a",
        text: "stale",
        len: 5
    )))
    channel.route(.osc52Clipboard(OSC52ClipboardPush(
        taskId: "task-a",
        text: "latest",
        len: 6
    )))
    #expect(await clipboard.next() == "latest")
    channel.finish()
}
