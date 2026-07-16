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

private actor AdapterOutputRecorder {
    private var events: [Dev3TerminalOutputEvent] = []

    func append(_ event: Dev3TerminalOutputEvent) {
        events.append(event)
    }

    func snapshot() -> [Dev3TerminalOutputEvent] {
        events
    }
}

private actor AdapterRecoveryGate {
    private var count = 0
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func recover() async {
        count += 1
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func snapshot() -> Int {
        count
    }

    func open() {
        let pending = continuations
        continuations.removeAll()
        for continuation in pending {
            continuation.resume()
        }
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

    #expect(await output.next() == .data(Data("/tmp\r\n".utf8)))
    #expect(await transport.frames() == [
        .data(Data("pwd\r".utf8)),
        .text("\u{1B}]resize;84;26\u{7}")
    ])

    await client.disconnect()
}

@Test("PTY output survives a cancelled consumer and terminal reattach", .timeLimit(.minutes(1)))
func ptyOutputSurvivesConsumerReplacement() async throws {
    let transport = AdapterTransport()
    let client = PTYClient(
        requestBuilder: AdapterRequestBuilder(),
        transportFactory: AdapterTransportFactory(transport: transport),
        reconnectDelays: [.seconds(60)]
    )
    let endpoint = Dev3TerminalEndpoint(identity: "task-output-reuse", ptyClient: client)
    let firstRecorder = AdapterOutputRecorder()
    let firstOutput = endpoint.output
    let firstConsumer = Task {
        for await event in firstOutput {
            await firstRecorder.append(event)
        }
    }

    try await client.connect(to: .task("task-output-reuse"))
    await transport.emit(.data(Data("first\r\n".utf8)))
    #expect(await eventuallyOutput([.data(Data("first\r\n".utf8))], from: firstRecorder))

    firstConsumer.cancel()
    await firstConsumer.value
    await client.disconnect()

    let secondRecorder = AdapterOutputRecorder()
    let secondOutput = endpoint.output
    let secondConsumer = Task {
        for await event in secondOutput {
            await secondRecorder.append(event)
        }
    }
    try await client.connect(to: .task("task-output-reuse"))
    await transport.emit(.data(Data("second\r\n".utf8)))
    #expect(await eventuallyOutput([.data(Data("second\r\n".utf8))], from: secondRecorder))

    secondConsumer.cancel()
    await secondConsumer.value
    await client.disconnect()
}

@Test("Output overflow clears the byte gap, resets the parser, and recovers once")
func outputOverflowResetsConsumer() async {
    let source = AsyncStream.makeStream(of: Data.self)
    let recovery = AdapterRecoveryGate()
    let endpoint = Dev3TerminalEndpoint(
        identity: "tiny-output-buffer",
        output: source.stream,
        clipboardText: .finished,
        connectionStates: .finished,
        maxBufferedOutputBytes: 4,
        recoverOutputOverflow: {
            await recovery.recover()
        },
        send: { _ in },
        resize: { _, _ in }
    )
    let abandonedOutput = endpoint.output
    let abandonedConsumer = Task {
        var iterator = abandonedOutput.makeAsyncIterator()
        return await iterator.next()
    }
    abandonedConsumer.cancel()
    #expect(await abandonedConsumer.value == nil)

    source.continuation.yield(Data("ABCD".utf8))
    source.continuation.yield(Data("EFGH".utf8))
    #expect(await eventuallyRecovery(recovery, count: 1))

    let output = endpoint.output
    var iterator = output.makeAsyncIterator()
    #expect(await iterator.next() == .reset)
    #expect(await iterator.next() == .data(Data("EFGH".utf8)))

    source.continuation.yield(Data("IJKLMNOP".utf8))
    let replacement = endpoint.output
    var replacementIterator = replacement.makeAsyncIterator()
    #expect(await replacementIterator.next() == .reset)
    #expect(await replacementIterator.next() == .data(Data("MNOP".utf8)))
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await recovery.snapshot() == 1)
    await recovery.open()
    source.continuation.finish()
}

@Test("Output queue survives an absent consumer and newest-lease replacement")
func outputQueueSurvivesConsumerHandoff() async {
    let source = AsyncStream.makeStream(of: Data.self)
    let endpoint = Dev3TerminalEndpoint(
        identity: "output-global-queue",
        output: source.stream,
        send: { _ in },
        resize: { _, _ in }
    )
    let firstOutput = endpoint.output
    let firstConsumer = Task {
        var iterator = firstOutput.makeAsyncIterator()
        return await iterator.next()
    }
    firstConsumer.cancel()
    #expect(await firstConsumer.value == nil)

    source.continuation.yield(Data("while-absent".utf8))
    try? await Task.sleep(for: .milliseconds(20))
    _ = endpoint.output
    source.continuation.yield(Data("while-passive".utf8))
    try? await Task.sleep(for: .milliseconds(20))

    let newestOutput = endpoint.output
    var newestIterator = newestOutput.makeAsyncIterator()
    #expect(await newestIterator.next() == .data(Data("while-absent".utf8)))
    #expect(await newestIterator.next() == .data(Data("while-passive".utf8)))
    source.continuation.finish()
}

@Test("Waiting output lease cannot receive bytes after replacement")
func outputWaiterRevalidatesNewestLease() async {
    let source = AsyncStream.makeStream(of: Data.self)
    let endpoint = Dev3TerminalEndpoint(
        identity: "output-waiter-handoff",
        output: source.stream,
        send: { _ in },
        resize: { _, _ in }
    )
    let firstOutput = endpoint.output
    let firstConsumer = Task {
        var iterator = firstOutput.makeAsyncIterator()
        return await iterator.next()
    }
    await Task.yield()

    let replacement = endpoint.output
    source.continuation.yield(Data("replacement-only".utf8))
    var replacementIterator = replacement.makeAsyncIterator()
    #expect(await firstConsumer.value == nil)
    #expect(await replacementIterator.next() == .data(Data("replacement-only".utf8)))
    source.continuation.finish()
}

@Test("Connection state replays the relay-global latest value")
func connectionStateReplaysLatestAcrossHandoff() async {
    let states = AsyncStream.makeStream(of: Dev3TerminalConnectionState.self)
    let endpoint = Dev3TerminalEndpoint(
        identity: "state-stream-handoff",
        output: .finished,
        connectionStates: states.stream,
        send: { _ in },
        resize: { _, _ in }
    )

    let firstStates = endpoint.connectionStates
    var firstStateIterator = firstStates.makeAsyncIterator()
    states.continuation.yield(.connected)
    #expect(await firstStateIterator.next() == .connected)
    let replacementStates = endpoint.connectionStates
    var replacementStateIterator = replacementStates.makeAsyncIterator()
    #expect(await replacementStateIterator.next() == .connected)

    let abandonedStates = endpoint.connectionStates
    let abandonedStateConsumer = Task {
        var iterator = abandonedStates.makeAsyncIterator()
        _ = await iterator.next()
        return await iterator.next()
    }
    await Task.yield()
    abandonedStateConsumer.cancel()
    #expect(await abandonedStateConsumer.value == nil)
    states.continuation.yield(.needsResume)
    try? await Task.sleep(for: .milliseconds(20))
    let statesAfterAbsence = endpoint.connectionStates
    var statesAfterAbsenceIterator = statesAfterAbsence.makeAsyncIterator()
    #expect(await statesAfterAbsenceIterator.next() == .needsResume)
    states.continuation.finish()
}

@Test("Clipboard delivery follows the newest lease without replaying absence")
func clipboardUsesLinearizedHandoff() async {
    let clipboard = AsyncStream.makeStream(of: String.self)
    let endpoint = Dev3TerminalEndpoint(
        identity: "clipboard-stream-handoff",
        output: .finished,
        clipboardText: clipboard.stream,
        send: { _ in },
        resize: { _, _ in }
    )
    let firstClipboard = endpoint.clipboardText
    let firstClipboardConsumer = Task {
        var iterator = firstClipboard.makeAsyncIterator()
        return await iterator.next()
    }
    await Task.yield()
    let replacementClipboard = endpoint.clipboardText
    clipboard.continuation.yield("replacement")
    var replacementClipboardIterator = replacementClipboard.makeAsyncIterator()
    #expect(await firstClipboardConsumer.value == nil)
    #expect(await replacementClipboardIterator.next() == "replacement")

    let abandonedClipboard = endpoint.clipboardText
    let abandonedClipboardConsumer = Task {
        var iterator = abandonedClipboard.makeAsyncIterator()
        return await iterator.next()
    }
    abandonedClipboardConsumer.cancel()
    #expect(await abandonedClipboardConsumer.value == nil)
    clipboard.continuation.yield("dropped-without-consumer")
    try? await Task.sleep(for: .milliseconds(20))
    let clipboardAfterAbsence = endpoint.clipboardText
    clipboard.continuation.yield("fresh")
    var clipboardAfterAbsenceIterator = clipboardAfterAbsence.makeAsyncIterator()
    #expect(await clipboardAfterAbsenceIterator.next() == "fresh")
    clipboard.continuation.finish()
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

private func eventuallyOutput(
    _ expected: [Dev3TerminalOutputEvent],
    from recorder: AdapterOutputRecorder
) async -> Bool {
    for _ in 0 ..< 100 {
        if await recorder.snapshot() == expected {
            return true
        }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return false
}

private func eventuallyRecovery(_ recovery: AdapterRecoveryGate, count: Int) async -> Bool {
    for _ in 0 ..< 100 {
        if await recovery.snapshot() == count {
            return true
        }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return false
}
