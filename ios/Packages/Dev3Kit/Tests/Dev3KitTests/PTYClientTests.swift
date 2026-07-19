@testable import Dev3Kit
import Foundation
import Testing

private struct PTYRequestBuilder: AuthenticatedRequestBuilding {
    let origin = URL(string: "http://dev3.test:4242")

    func authenticatedRequest(path: String, queryItems: [URLQueryItem]) async throws -> URLRequest {
        guard let origin,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        else {
            throw WebSocketTransportError.invalidURL
        }
        components.path = path
        components.queryItems = queryItems
        guard let url = components.url else {
            throw WebSocketTransportError.invalidURL
        }
        var request = URLRequest(url: url)
        request.setValue("dev3_session=pty-token", forHTTPHeaderField: "Cookie")
        return request
    }
}

private final class PTYTransportFactory: WebSocketTransportCreating, @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [FakePTYTransport]
    private var requests: [URLRequest] = []

    init(_ transports: [FakePTYTransport]) {
        self.transports = transports
    }

    func makeTransport(for request: URLRequest) throws -> any WebSocketTransport {
        try lock.withLock {
            requests.append(request)
            guard !transports.isEmpty else {
                throw WebSocketTransportError.failed("No fake PTY transport available.")
            }
            return transports.removeFirst()
        }
    }

    func capturedRequests() -> [URLRequest] {
        lock.withLock { requests }
    }
}

private actor FakePTYTransport: WebSocketTransport {
    private let connectError: WebSocketTransportError?
    private let sendError: WebSocketTransportError?
    private var frames: [WebSocketFrame] = []
    private var queuedInput: [Result<WebSocketFrame, any Error>] = []
    private var receiveWaiter: CheckedContinuation<WebSocketFrame, any Error>?
    private var disconnects = 0

    init(
        connectError: WebSocketTransportError? = nil,
        sendError: WebSocketTransportError? = nil
    ) {
        self.connectError = connectError
        self.sendError = sendError
    }

    func connect() async throws {
        if let connectError {
            throw connectError
        }
    }

    func send(_ frame: WebSocketFrame) async throws {
        if let sendError {
            throw sendError
        }
        frames.append(frame)
    }

    func receive() async throws -> WebSocketFrame {
        if !queuedInput.isEmpty {
            return try queuedInput.removeFirst().get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveWaiter = continuation
        }
    }

    func disconnect(code: Int, reason: String) async {
        disconnects += 1
        let error = WebSocketTransportError.closed(code: code, reason: reason)
        receiveWaiter?.resume(throwing: error)
        receiveWaiter = nil
    }

    func enqueue(_ frame: WebSocketFrame) {
        if let receiveWaiter {
            self.receiveWaiter = nil
            receiveWaiter.resume(returning: frame)
        } else {
            queuedInput.append(.success(frame))
        }
    }

    func close(code: Int, reason: String) {
        let error = WebSocketTransportError.closed(code: code, reason: reason)
        if let receiveWaiter {
            self.receiveWaiter = nil
            receiveWaiter.resume(throwing: error)
        } else {
            queuedInput.append(.failure(error))
        }
    }

    func fail(_ message: String) {
        let error = WebSocketTransportError.failed(message)
        if let receiveWaiter {
            self.receiveWaiter = nil
            receiveWaiter.resume(throwing: error)
        } else {
            queuedInput.append(.failure(error))
        }
    }

    func sentFrames() -> [WebSocketFrame] {
        frames
    }

    func disconnectCount() -> Int {
        disconnects
    }
}

private actor PTYStateRecorder {
    private var values: [PTYConnectionState] = []

    func append(_ value: PTYConnectionState) {
        values.append(value)
    }

    func snapshot() -> [PTYConnectionState] {
        values
    }
}

private func recordStates(
    from stream: AsyncStream<PTYConnectionState>,
    into recorder: PTYStateRecorder
) -> Task<Void, Never> {
    Task {
        for await value in stream {
            await recorder.append(value)
        }
    }
}

private func waitForPTY(
    _ predicate: @escaping @Sendable () async -> Bool,
    timeout: Duration = .seconds(1)
) async {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await predicate() {
            return
        }
        try? await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("Timed out waiting for the PTY state machine")
}

private func makePTYClient(
    transports: [FakePTYTransport],
    reconnectDelays: [Duration] = [.milliseconds(2)],
    resizeInterval: Duration = .milliseconds(20)
) -> (PTYClient, PTYTransportFactory) {
    let factory = PTYTransportFactory(transports)
    let client = PTYClient(
        requestBuilder: PTYRequestBuilder(),
        transportFactory: factory,
        reconnectDelays: reconnectDelays,
        resizeInterval: resizeInterval
    )
    return (client, factory)
}

@Suite("PTY client framing and reconnect FSM")
struct PTYClientTests {
    @Test("Task and project sessions preserve canonical proxy identifiers")
    func sessionIdentifiers() {
        #expect(PTYSession.task("task-1").identifier == "task-1")
        #expect(PTYSession.project("project-1").identifier == "project-project-1")
    }

    @Test("Connect authenticates the exact proxy session and raw bytes stay ordered")
    func connectionAndRawIO() async throws {
        let socket = FakePTYTransport()
        let (client, factory) = makePTYClient(transports: [socket])
        var output = client.output.makeAsyncIterator()

        try await client.connect(to: .task("task-7"))
        #expect(await client.stateSnapshot() == .connected(.task("task-7")))
        let request = try #require(factory.capturedRequests().first)
        #expect(request.url?.absoluteString == "http://dev3.test:4242/pty?session=task-7")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "dev3_session=pty-token")

        let input = Data([0x1B, 0x5B, 0x41])
        try await client.send(input)
        #expect(await socket.sentFrames() == [.data(input)])

        await socket.enqueue(.data(Data([0x00, 0xFF])))
        await socket.enqueue(.text("hello"))
        #expect(await output.next() == Data([0x00, 0xFF]))
        #expect(await output.next() == Data("hello".utf8))
        await client.disconnect()
    }

    @Test("A fresh client never emits a leading disconnected state before connecting")
    func noLeadingDisconnectedBeforeConnect() async throws {
        let socket = FakePTYTransport()
        let (client, _) = makePTYClient(transports: [socket])
        let recorder = PTYStateRecorder()
        let recording = recordStates(from: client.states, into: recorder)

        // A brand-new client reports `.disconnected` as its snapshot, but must not
        // seed the stream with it — otherwise a subscriber that attaches while the
        // socket is still opening flashes the "Terminal disconnected" recovery card.
        #expect(await client.stateSnapshot() == .disconnected)

        try await client.connect(to: .task("task-fresh"))
        await waitForPTY {
            await recorder.snapshot().contains(.connected(.task("task-fresh")))
        }

        let states = await recorder.snapshot()
        #expect(states.first == .connecting(.task("task-fresh")))
        #expect(!states.contains(.disconnected))
        recording.cancel()
        await client.disconnect()
    }

    @Test("Recoverable task resolution surfaces needs-resume without opening a socket")
    func needsResume() async throws {
        let (client, factory) = makePTYClient(transports: [])
        let sessionState = Dev3TaskSessionState(panes: [
            Dev3PaneSession(
                paneId: "%1",
                agentCmd: "codex",
                sessionId: "s1",
                agentId: "codex",
                configId: "xhigh",
                accountId: nil
            )
        ])

        try await client.connect(
            to: .task("task-7"),
            resolution: .needsResume(sessionState)
        )

        #expect(await client.stateSnapshot() == .needsResume(
            session: .task("task-7"),
            state: sessionState
        ))
        #expect(factory.capturedRequests().isEmpty)
    }

    @Test("Resize frames are exact, rate-limited, coalesced, and restored after kick")
    func resizeCoalescingAndReconnectRestore() async throws {
        let first = FakePTYTransport()
        let second = FakePTYTransport()
        let (client, _) = makePTYClient(
            transports: [first, second],
            resizeInterval: .milliseconds(20)
        )
        try await client.connect(to: .task("task-resize"))

        try await client.resize(columns: 80, rows: 24)
        try await client.resize(columns: 81, rows: 25)
        try await client.resize(columns: 120, rows: 40)
        try await Task.sleep(for: .milliseconds(35))

        #expect(await first.sentFrames() == [
            .text("\u{1B}]resize;80;24\u{7}"),
            .text("\u{1B}]resize;120;40\u{7}")
        ])

        await client.kick()
        #expect(await second.sentFrames() == [.text("\u{1B}]resize;120;40\u{7}")])
        await client.disconnect()
    }

    @Test("Invalid size and disconnected input fail before touching transport")
    func invalidLocalOperations() async {
        let (client, _) = makePTYClient(transports: [])

        await #expect(throws: PTYClientError.notConnected) {
            try await client.send(Data("x".utf8))
        }
        await #expect(throws: PTYClientError.invalidSize(columns: 0, rows: 24)) {
            try await client.resize(columns: 0, rows: 24)
        }
        await #expect(throws: PTYClientError.invalidSession) {
            try await client.connect(to: .task(""))
        }
    }

    @Test("4000 and 4001 close codes are typed terminal failures without retry")
    func nonRetryableCloseCodes() async throws {
        for (code, reason, expected) in [
            (
                4000,
                "Missing session parameter",
                PTYClientError.missingSessionParameter("Missing session parameter")
            ),
            (4001, "Unknown session", PTYClientError.unknownSession("Unknown session"))
        ] {
            let socket = FakePTYTransport()
            let (client, factory) = makePTYClient(transports: [socket])
            try await client.connect(to: .task("task-close"))

            await socket.close(code: code, reason: reason)
            await waitForPTY {
                await client.stateSnapshot() == .failed(session: .task("task-close"), error: expected)
            }

            #expect(expected.closeCode == code)
            #expect(!expected.isRetryable)
            #expect(factory.capturedRequests().count == 1)
            #expect(await socket.disconnectCount() == 1)
            await client.disconnect()
        }
    }

    @Test("4002 and 4003 availability closes reconnect with their typed cause")
    func retryableCloseCodes() async throws {
        for (code, reason, expected) in [
            (4002, "PTY server not available", PTYClientError.serverUnavailable("PTY server not available")),
            (4003, "PTY upstream error", PTYClientError.upstreamError("PTY upstream error"))
        ] {
            let first = FakePTYTransport()
            let second = FakePTYTransport()
            let (client, factory) = makePTYClient(transports: [first, second])
            let recorder = PTYStateRecorder()
            let recording = recordStates(from: client.states, into: recorder)
            try await client.connect(to: .task("task-retry"))

            await first.close(code: code, reason: reason)
            await waitForPTY {
                guard factory.capturedRequests().count == 2 else { return false }
                return await client.stateSnapshot() == .connected(.task("task-retry"))
            }

            let reconnects = await recorder.snapshot().compactMap { state -> PTYClientError? in
                guard case let .reconnecting(_, _, _, cause) = state else { return nil }
                return cause
            }
            #expect(reconnects == [expected])
            #expect(expected.closeCode == code)
            #expect(expected.isRetryable)
            #expect(await first.disconnectCount() == 1)
            recording.cancel()
            await client.disconnect()
        }
    }

    @Test("Transport backoff grows, caps, and resets after a successful reconnect")
    func backoffGrowthAndReset() async throws {
        let connected = FakePTYTransport()
        let failedOnce = FakePTYTransport(connectError: .failed("offline-1"))
        let failedTwice = FakePTYTransport(connectError: .failed("offline-2"))
        let recovered = FakePTYTransport()
        let (client, factory) = makePTYClient(
            transports: [connected, failedOnce, failedTwice, recovered],
            reconnectDelays: [.milliseconds(1), .milliseconds(2)]
        )
        let recorder = PTYStateRecorder()
        let recording = recordStates(from: client.states, into: recorder)
        try await client.connect(to: .task("task-backoff"))

        await connected.fail("network down")
        await waitForPTY {
            guard factory.capturedRequests().count == 4 else { return false }
            return await client.stateSnapshot() == .connected(.task("task-backoff"))
        }
        await waitForPTY {
            await recorder.snapshot().filter { state in
                if case .reconnecting = state {
                    return true
                }
                return false
            }.count == 3
        }

        let reconnects = await recorder.snapshot().compactMap { state -> (Int, Duration)? in
            guard case let .reconnecting(_, attempt, delay, _) = state else { return nil }
            return (attempt, delay)
        }
        #expect(reconnects.map(\.0) == [1, 2, 3])
        #expect(reconnects.map(\.1) == [
            .milliseconds(1),
            .milliseconds(2),
            .milliseconds(2)
        ])
        #expect(await connected.disconnectCount() == 1)
        #expect(await failedOnce.disconnectCount() == 1)
        #expect(await failedTwice.disconnectCount() == 1)
        recording.cancel()
        await client.disconnect()
    }

    @Test("Send failure disconnects the exact candidate before retry scheduling")
    func sendFailureCleansUpCandidate() async throws {
        let failed = FakePTYTransport(sendError: .failed("write failed"))
        let replacement = FakePTYTransport()
        let (client, _) = makePTYClient(
            transports: [failed, replacement],
            reconnectDelays: [.seconds(1)]
        )
        try await client.connect(to: .task("task-send"))

        await #expect(throws: PTYClientError.transport("write failed")) {
            try await client.send(Data("input".utf8))
        }

        #expect(await failed.disconnectCount() == 1)
        if case let .reconnecting(session, _, _, cause) = await client.stateSnapshot() {
            #expect(session == .task("task-send"))
            #expect(cause == .transport("write failed"))
        } else {
            Issue.record("Expected a reconnecting state after send failure")
        }
        await client.disconnect()
    }

    @Test("Kick cancels delayed retry and replaces the visible session immediately")
    func kickReplacesBackoff() async throws {
        let first = FakePTYTransport()
        let replacement = FakePTYTransport()
        let (client, factory) = makePTYClient(
            transports: [first, replacement],
            reconnectDelays: [.seconds(1)]
        )
        try await client.connect(to: .project("project-7"))
        await first.close(code: 4002, reason: "unavailable")
        await waitForPTY {
            if case .reconnecting = await client.stateSnapshot() {
                return true
            }
            return false
        }

        await client.kick()

        #expect(await client.stateSnapshot() == .connected(.project("project-7")))
        #expect(factory.capturedRequests().count == 2)
        await client.disconnect()
    }

    @Test("Disconnect cancels delayed retry and duplicate old closes stay ignored")
    func disconnectAndDuplicateClose() async throws {
        let first = FakePTYTransport()
        let replacement = FakePTYTransport()
        let (client, factory) = makePTYClient(
            transports: [first, replacement],
            reconnectDelays: [.milliseconds(40)]
        )
        try await client.connect(to: .task("task-stop"))
        await first.close(code: 4002, reason: "down")
        await first.close(code: 4002, reason: "duplicate")
        await client.disconnect()
        try await Task.sleep(for: .milliseconds(60))

        #expect(await client.stateSnapshot() == .disconnected)
        #expect(factory.capturedRequests().count == 1)
    }
}
