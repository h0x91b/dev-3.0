@testable import Dev3Kit
import Foundation
import Testing

private struct FixedRequestBuilder: AuthenticatedRequestBuilding {
    let origin: URL?
    let token: String

    func authenticatedRequest(path: String, queryItems: [URLQueryItem]) async throws -> URLRequest {
        guard let origin,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        else {
            throw WebSocketTransportError.invalidURL
        }
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw WebSocketTransportError.invalidURL
        }
        var request = URLRequest(url: url)
        request.setValue("dev3_session=\(token)", forHTTPHeaderField: "Cookie")
        return request
    }
}

private final class FakeTransportFactory: WebSocketTransportCreating, @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [FakeWebSocketTransport]
    private var requests: [URLRequest] = []

    init(_ transports: [FakeWebSocketTransport]) {
        self.transports = transports
    }

    func makeTransport(for request: URLRequest) throws -> any WebSocketTransport {
        try lock.withLock {
            requests.append(request)
            guard !transports.isEmpty else {
                throw WebSocketTransportError.failed("No fake transport available.")
            }
            return transports.removeFirst()
        }
    }

    func capturedRequests() -> [URLRequest] {
        lock.withLock { requests }
    }
}

private actor FakeWebSocketTransport: WebSocketTransport {
    private let waitsForOpen: Bool
    private let connectError: WebSocketTransportError?
    private var openWaiter: CheckedContinuation<Void, any Error>?
    private var receiveWaiter: CheckedContinuation<WebSocketFrame, any Error>?
    private var queuedFrames: [Result<WebSocketFrame, any Error>] = []
    private var sent: [WebSocketFrame] = []
    private var disconnects: [(Int, String)] = []
    private var connectStarted = false

    init(waitsForOpen: Bool = false, connectError: WebSocketTransportError? = nil) {
        self.waitsForOpen = waitsForOpen
        self.connectError = connectError
    }

    func connect() async throws {
        connectStarted = true
        if let connectError {
            throw connectError
        }
        guard waitsForOpen else { return }
        try await withCheckedThrowingContinuation { continuation in
            openWaiter = continuation
        }
    }

    func send(_ frame: WebSocketFrame) async throws {
        sent.append(frame)
    }

    func receive() async throws -> WebSocketFrame {
        if !queuedFrames.isEmpty {
            return try queuedFrames.removeFirst().get()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveWaiter = continuation
        }
    }

    func disconnect(code: Int, reason: String) async {
        disconnects.append((code, reason))
        let error = WebSocketTransportError.closed(code: code, reason: reason)
        openWaiter?.resume(throwing: error)
        openWaiter = nil
        receiveWaiter?.resume(throwing: error)
        receiveWaiter = nil
    }

    func open() {
        openWaiter?.resume()
        openWaiter = nil
    }

    func enqueue(_ frame: WebSocketFrame) {
        if let waiter = receiveWaiter {
            receiveWaiter = nil
            waiter.resume(returning: frame)
        } else {
            queuedFrames.append(.success(frame))
        }
    }

    func close(code: Int, reason: String) {
        let error = WebSocketTransportError.closed(code: code, reason: reason)
        if let waiter = receiveWaiter {
            receiveWaiter = nil
            waiter.resume(throwing: error)
        } else {
            queuedFrames.append(.failure(error))
        }
    }

    func fail(_ message: String) {
        let error = WebSocketTransportError.failed(message)
        if let waiter = receiveWaiter {
            receiveWaiter = nil
            waiter.resume(throwing: error)
        } else {
            queuedFrames.append(.failure(error))
        }
    }

    func sentFrames() -> [WebSocketFrame] {
        sent
    }

    func didStartConnect() -> Bool {
        connectStarted
    }

    func disconnectCount() -> Int {
        disconnects.count
    }
}

private actor SessionEventRecorder {
    private var events: [SessionConnectionEvent] = []

    func append(_ event: SessionConnectionEvent) {
        events.append(event)
    }

    func snapshot() -> [SessionConnectionEvent] {
        events
    }
}

private func makeClient(
    transports: [FakeWebSocketTransport],
    timeout: Duration = .seconds(2)
) -> (RPCClient, FakeTransportFactory) {
    let factory = FakeTransportFactory(transports)
    let client = RPCClient(
        requestBuilder: FixedRequestBuilder(
            origin: URL(string: "http://dev3.test:4242"),
            token: "native-token"
        ),
        transportFactory: factory,
        requestTimeout: timeout
    )
    return (client, factory)
}

private func waitUntil(
    _ predicate: @escaping @Sendable () async -> Bool,
    attempts: Int = 500
) async {
    for _ in 0 ..< attempts {
        if await predicate() {
            return
        }
        await Task.yield()
    }
}

private func textPackets(_ transport: FakeWebSocketTransport) async -> [[String: Any]] {
    await transport.sentFrames().compactMap { frame in
        guard case let .text(text) = frame,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return object
    }
}

private func response(
    id: Int64,
    success: Bool = true,
    payload: String? = nil,
    error: String? = nil
) throws -> String {
    var packet: [String: Any] = ["type": "response", "id": id, "success": success]
    if let payload {
        packet["payload"] = payload
    }
    if let error {
        packet["error"] = error
    }
    let data = try JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw WebSocketTransportError.failed("Fixture response was not valid UTF-8.")
    }
    return text
}

@Suite("RPC client framing and connection FSM")
struct RPCClientTests {
    @Test("Queued requests flush in order and responses correlate out of order")
    func queueCorrelationAndMonotonicIDs() async throws {
        let socket = FakeWebSocketTransport()
        let (client, factory) = makeClient(transports: [socket])

        let queued = Task {
            try await client.call("queued", params: ["value": 1], as: String.self)
        }
        try await Task.sleep(for: .milliseconds(10))
        #expect(await socket.sentFrames().isEmpty)

        try await client.connect()
        await waitUntil { await socket.sentFrames().count == 1 }
        let second = Task {
            try await client.call("second", params: ["value": 2], as: String.self)
        }
        await waitUntil { await socket.sentFrames().count == 2 }

        let packets = await textPackets(socket)
        #expect(packets.count == 2)
        #expect(packets.map { $0["id"] as? Int } == [1, 2])
        #expect(packets.map { $0["method"] as? String } == ["queued", "second"])
        #expect(packets.allSatisfy { $0["type"] as? String == "request" })

        try await socket.enqueue(.text(response(id: 2, payload: "two")))
        try await socket.enqueue(.text(response(id: 1, payload: "one")))
        #expect(try await second.value == "two")
        #expect(try await queued.value == "one")

        let requests = factory.capturedRequests()
        #expect(requests.count == 1)
        #expect(requests[0].url?.absoluteString == "http://dev3.test:4242/rpc")
        #expect(requests[0].value(forHTTPHeaderField: "Cookie") == "dev3_session=native-token")
        await client.disconnect()
    }

    @Test("Every socket open explicitly requires a full refetch")
    func openRequiresRefetch() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        var iterator = client.connectionEvents.makeAsyncIterator()

        try await client.connect()

        #expect(await iterator.next() == .opened(requiresRefetch: true))
        await client.disconnect()
    }

    @Test("Unsent requests keep the browser-compatible timeout")
    func unsentRequestTimeout() async {
        let (client, _) = makeClient(
            transports: [],
            timeout: .milliseconds(25)
        )

        await #expect(throws: RPCClientError.requestTimedOut(method: "never-opened")) {
            try await client.call("never-opened", as: String.self)
        }
    }

    @Test("Close rejects in-flight work but preserves later unsent work for reconnect")
    func closeRejectsSentAndPreservesUnsent() async throws {
        let firstSocket = FakeWebSocketTransport()
        let secondSocket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [firstSocket, secondSocket])
        try await client.connect()

        let inFlight = Task { try await client.call("in-flight", as: String.self) }
        await waitUntil { await firstSocket.sentFrames().count == 1 }
        await firstSocket.close(code: 4003, reason: "PTY upstream error")
        await #expect(
            throws: RPCClientError.connectionClosed(code: 4003, reason: "PTY upstream error")
        ) {
            try await inFlight.value
        }

        let queued = Task { try await client.call("after-close", as: String.self) }
        try await Task.sleep(for: .milliseconds(10))
        #expect(await secondSocket.sentFrames().isEmpty)

        try await client.connect()
        await waitUntil { await secondSocket.sentFrames().count == 1 }
        let packet = await textPackets(secondSocket).first
        #expect(packet?["id"] as? Int == 2)
        try await secondSocket.enqueue(.text(response(id: 2, payload: "recovered")))
        #expect(try await queued.value == "recovered")
        await client.disconnect()
    }

    @Test("Malformed, unrelated, and unknown packet types cannot steal a response")
    func malformedFramesAreIgnored() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        var pushIterator = client.pushes.makeAsyncIterator()
        try await client.connect()
        let request = Task { try await client.call("safe", as: String.self) }
        await waitUntil { await socket.sentFrames().count == 1 }

        await socket.enqueue(.text("{not-json"))
        try await socket.enqueue(.text(response(id: 99, payload: "wrong")))
        await socket.enqueue(.text("{\"type\":\"future\",\"id\":1}"))
        await socket.enqueue(.text(
            "{\"type\":\"message\",\"id\":\"ptyDied\",\"payload\":{}}"
        ))
        await socket.enqueue(.text(
            "{\"type\":\"message\",\"id\":\"terminalBell\",\"payload\":{\"taskId\":\"task-ok\"}}"
        ))
        try await socket.enqueue(.data(Data(response(id: 1, payload: "right").utf8)))

        #expect(await pushIterator.next() == .terminalBell(TaskIdentifierPush(taskId: "task-ok")))
        #expect(try await request.value == "right")
        await client.disconnect()
    }

    @Test("Remote failures and missing success payloads preserve wire semantics")
    func errorsAndVoidResponses() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        try await client.connect()

        let failed = Task { try await client.call("noSuchMethod", as: String.self) }
        await waitUntil { await socket.sentFrames().count == 1 }
        try await socket.enqueue(.text(response(
            id: 1,
            success: false,
            error: "Unknown RPC method"
        )))
        await #expect(throws: RPCClientError.remote("Unknown RPC method")) {
            try await failed.value
        }

        let succeeded = Task { try await client.callVoid("voidMethod") }
        await waitUntil { await socket.sentFrames().count == 2 }
        try await socket.enqueue(.text(response(id: 2)))
        try await succeeded.value
        await client.disconnect()
    }

    @Test("Cancelling a queued request removes it before a later open")
    func cancellationRemovesQueuedRequest() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        let request = Task { try await client.call("cancelled", as: String.self) }
        try await Task.sleep(for: .milliseconds(10))

        request.cancel()
        await #expect(throws: RPCClientError.requestCancelled) {
            try await request.value
        }
        try await client.connect()
        #expect(await socket.sentFrames().isEmpty)
        await client.disconnect()
    }

    @Test("Old-socket and duplicate closes cannot mutate the replacement generation")
    func lateCallbacksAreIgnored() async throws {
        let first = FakeWebSocketTransport()
        let replacement = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [first, replacement])
        let recorder = SessionEventRecorder()
        await client.setSessionEventHandler { event in
            Task { await recorder.append(event) }
        }

        try await client.connect()
        try await client.connect()
        await first.close(code: 4002, reason: "late")
        await replacement.close(code: 4002, reason: "down")
        await replacement.close(code: 4002, reason: "duplicate")
        await waitUntil { await recorder.snapshot().count == 3 }

        #expect(await recorder.snapshot() == [
            .opened,
            .opened,
            .closed(code: 4002, reason: "down")
        ])
    }

    @Test("Typed and future pushes are both observable")
    func typedAndUnknownPushes() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        var iterator = client.pushes.makeAsyncIterator()
        try await client.connect()

        await socket.enqueue(.text(
            "{\"type\":\"message\",\"id\":\"ptyDied\",\"payload\":{\"taskId\":\"task-7\"}}"
        ))
        await socket.enqueue(.text(
            "{\"type\":\"message\",\"id\":\"taskPreparationFailed\",\"payload\":" +
                "{\"taskId\":\"task-7\",\"projectId\":\"project-1\",\"taskTitle\":\"Build\"," +
                "\"error\":\"clone failed\"}}"
        ))
        await socket.enqueue(.text(
            "{\"type\":\"message\",\"id\":\"futurePush\",\"payload\":{\"sequence\":7}}"
        ))

        #expect(await iterator.next() == .ptyDied(TaskIdentifierPush(taskId: "task-7")))
        #expect(await iterator.next() == .taskPreparationFailed(TaskPreparationFailedPush(
            taskId: "task-7",
            projectId: "project-1",
            taskTitle: "Build",
            error: "clone failed"
        )))
        #expect(await iterator.next() == .unknown(
            name: "futurePush",
            payload: .object(["sequence": .integer(7)])
        ))
        await client.disconnect()
    }

    @Test("Facade preserves explicit null context fields and exact method names")
    func facadeWireCapture() async throws {
        let socket = FakeWebSocketTransport()
        let (client, _) = makeClient(transports: [socket])
        try await client.connect()

        let context = Task { try await client.setActiveContext(projectId: nil, taskId: nil) }
        await waitUntil { await socket.sentFrames().count == 1 }
        let packet = await textPackets(socket).first
        #expect(packet?["method"] as? String == "setActiveContext")
        let params = packet?["params"] as? [String: Any]
        #expect(params?["projectId"] is NSNull)
        #expect(params?["taskId"] is NSNull)
        try await socket.enqueue(.text(response(id: 1)))
        try await context.value

        let rename = Task {
            try await client.renameTask(taskId: "t", projectId: "p", customTitle: nil)
        }
        await waitUntil { await socket.sentFrames().count == 2 }
        let renamePacket = await textPackets(socket)[1]
        #expect(renamePacket["method"] as? String == "renameTask")
        #expect((renamePacket["params"] as? [String: Any])?["customTitle"] is NSNull)
        rename.cancel()
        await #expect(throws: RPCClientError.requestCancelled) {
            try await rename.value
        }
        await client.disconnect()
    }
}
