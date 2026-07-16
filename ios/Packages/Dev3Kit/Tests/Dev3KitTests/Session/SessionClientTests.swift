@testable import Dev3Kit
import Foundation
import Testing

@MainActor
@Suite("Session client", .serialized)
struct SessionClientTests {
    @Test("Pairing exchanges a native token, persists it, and connects")
    func pairingSuccess() async throws {
        let harness = try await SessionHarness(pairing: true)

        harness.client.start()
        await settle()

        #expect(harness.client.state == .connected)
        #expect(harness.states == [.authenticating, .connecting, .connected])
        #expect(harness.client.currentServer?.sessionToken == "exchanged-session")
        #expect(try await harness.store.load().activeServer == harness.client.currentServer)
        #expect(await harness.transport.exchangeCallCount == 1)
        #expect(await harness.connection.connectCallCount == 1)
    }

    @Test("A consumed QR reuses a stored credential for the same instance and refreshes it")
    func consumedQrFallback() async throws {
        let saved = try makeServer(token: "saved-session")
        let harness = try await SessionHarness(
            pairing: true,
            savedServer: saved,
            exchange: [.success(SessionAuthResponse(statusCode: 401, sessionToken: nil))],
            refresh: [.success(SessionAuthResponse(statusCode: 200, sessionToken: "refreshed-session"))]
        )

        harness.client.start()
        await settle()

        #expect(harness.client.state == .connected)
        #expect(harness.client.currentServer?.sessionToken == "refreshed-session")
        #expect(await harness.transport.refreshCallCount == 1)
    }

    @Test("A consumed QR without a stored credential expires instead of inventing a refresh")
    func consumedQrWithoutCredential() async throws {
        let harness = try await SessionHarness(
            pairing: true,
            exchange: [.success(SessionAuthResponse(statusCode: 401, sessionToken: nil))]
        )

        harness.client.start()
        await settle()

        #expect(harness.client.state == .expired)
        #expect(harness.expirations == [.exchangeAndRefreshRejected])
        #expect(await harness.transport.refreshCallCount == 0)
        #expect(await harness.connection.connectCallCount == 0)
    }

    @Test("A saved session refreshes before connecting and rotates atomically")
    func savedSessionBoot() async throws {
        let harness = try await SessionHarness(pairing: false)

        harness.client.start()
        await settle()

        let request = try await harness.client.requestFactory.authenticatedRequest(path: "/health")
        #expect(harness.client.state == .connected)
        #expect(request.value(forHTTPHeaderField: "Cookie") == "dev3_session=refreshed-session")
    }

    @Test(
        "Saved-session authentication rejection expires for both authoritative statuses",
        arguments: [401, 403]
    )
    func savedSessionRejected(status: Int) async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [.success(SessionAuthResponse(statusCode: status, sessionToken: nil))]
        )

        harness.client.start()
        await settle()

        #expect(harness.client.state == .expired)
        #expect(harness.expirations == [.noSavedSession])
        #expect(await harness.connection.connectCallCount == 0)
    }

    @Test("Boot network failures back off 2, 4, 8, then 15 seconds and recover")
    func bootBackoff() async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [
                .failure(.offline),
                .failure(.offline),
                .failure(.offline),
                .failure(.offline),
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "recovered"))
            ]
        )

        harness.client.start()
        await settle()
        #expect(harness.scheduler.retryDelays == [2])

        await harness.scheduler.advance(by: 2)
        #expect(harness.scheduler.retryDelays == [2, 4])
        await harness.scheduler.advance(by: 4)
        #expect(harness.scheduler.retryDelays == [2, 4, 8])
        await harness.scheduler.advance(by: 8)
        #expect(harness.scheduler.retryDelays == [2, 4, 8, 15])
        await harness.scheduler.advance(by: 15)

        #expect(harness.client.state == .connected)
        #expect(harness.client.currentServer?.sessionToken == "recovered")
    }

    @Test("A 401 after socket close expires and leaves no event handler installed")
    func closeWithDeadSession() async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "boot")),
                .success(SessionAuthResponse(statusCode: 401, sessionToken: nil))
            ]
        )
        harness.client.start()
        await settle()

        await harness.connection.emit(.closed(code: 1006, reason: ""))
        await settle()

        #expect(harness.client.state == .expired)
        #expect(harness.expirations == [.sessionRejectedAfterClose])
        #expect(await harness.connection.hasHandler == false)
        await harness.connection.emit(.opened)
        await settle()
        #expect(harness.client.state == .expired)
    }

    @Test("A network failure after close reconnects after two seconds")
    func closeWithNetworkFailure() async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "boot")),
                .failure(.offline)
            ]
        )
        harness.client.start()
        await settle()

        await harness.connection.emit(.closed(code: 1006, reason: ""))
        await settle()
        #expect(harness.client.state == .reconnecting)
        #expect(harness.scheduler.retryDelays.last == 2)

        await harness.scheduler.advance(by: 2)
        #expect(await harness.connection.connectCallCount == 2)
        #expect(harness.client.state == .connected)
    }

    @Test("Connection backoff doubles and resets after a successful open")
    func connectionBackoffReset() async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "boot")),
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "after-close"))
            ],
            connectionOutcomes: [false, false, true, true]
        )
        harness.client.start()
        await settle()
        #expect(harness.scheduler.retryDelays == [2])

        await harness.scheduler.advance(by: 2)
        #expect(harness.scheduler.retryDelays == [2, 4])
        await harness.scheduler.advance(by: 4)
        #expect(harness.client.state == .connected)

        await harness.connection.emit(.closed(code: 1006, reason: ""))
        await settle()
        #expect(harness.scheduler.retryDelays.last == 2)
    }

    @Test("Rolling refresh runs every fifteen minutes and an authoritative rejection expires")
    func rollingRefresh() async throws {
        let harness = try await SessionHarness(
            pairing: false,
            refresh: [
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "boot")),
                .success(SessionAuthResponse(statusCode: 200, sessionToken: "rolled")),
                .success(SessionAuthResponse(statusCode: 403, sessionToken: nil))
            ]
        )
        harness.client.start()
        await settle()

        await harness.scheduler.advance(by: 15 * 60)
        #expect(harness.client.currentServer?.sessionToken == "rolled")
        #expect(harness.client.state == .connected)
        await harness.scheduler.advance(by: 15 * 60)
        #expect(harness.client.state == .expired)
        #expect(harness.expirations == [.refreshRejected])
    }

    @Test("Kick replaces a live connection immediately and is a no-op after expiry")
    func kick() async throws {
        let harness = try await SessionHarness(pairing: false)
        harness.client.start()
        await settle()

        harness.client.kick()
        await settle()
        #expect(await harness.connection.disconnectCallCount == 1)
        #expect(await harness.connection.connectCallCount == 2)

        await harness.connection.emit(.closed(code: 1006, reason: ""))
        await settle()
        harness.client.destroy()
        await settle()
        let callsAfterDestroy = await harness.connection.connectCallCount
        harness.client.kick()
        await settle()
        #expect(await harness.connection.connectCallCount == callsAfterDestroy)
    }

    @Test("Destroy disconnects after the session client is immediately released")
    func destroyOutlivesClient() async throws {
        var harness: SessionHarness? = try await SessionHarness(pairing: false)
        let connection = try #require(harness?.connection)
        harness?.client.start()
        await settle()
        #expect(await connection.hasHandler)

        weak let releasedClient = harness?.client
        harness?.client.destroy()
        harness = nil
        #expect(releasedClient == nil)
        await settle()

        #expect(await connection.hasHandler == false)
        #expect(await connection.disconnectCallCount == 1)
    }

    private func makeServer(token: String) throws -> PairedServer {
        try PairedServer(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            sessionToken: token,
            name: "Local dev3",
            instanceId: "instance-1"
        )
    }
}

@MainActor
private final class SessionHarness {
    let store: PairedServerStore
    let transport: MockSessionHTTPTransport
    let connection: MockSessionConnection
    let scheduler: TestSessionScheduler
    let client: SessionClient
    var states: [RemoteSessionState] = []
    var expirations: [SessionExpirationReason] = []

    init(
        pairing: Bool,
        savedServer: PairedServer? = nil,
        exchange: [Result<SessionAuthResponse, MockSessionError>] = [
            .success(SessionAuthResponse(statusCode: 200, sessionToken: "exchanged-session"))
        ],
        refresh: [Result<SessionAuthResponse, MockSessionError>] = [
            .success(SessionAuthResponse(statusCode: 200, sessionToken: "refreshed-session"))
        ],
        connectionOutcomes: [Bool] = [true]
    ) async throws {
        let secureStore = SessionMemorySecureStore()
        store = PairedServerStore(secureStore: secureStore)
        if let savedServer {
            _ = try await store.upsert(savedServer)
        }
        transport = MockSessionHTTPTransport(exchange: exchange, refresh: refresh)
        connection = MockSessionConnection(outcomes: connectionOutcomes)
        scheduler = TestSessionScheduler()
        let defaultServer = try PairedServer(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            sessionToken: "saved-session",
            name: "Local dev3",
            instanceId: "instance-1"
        )
        let server = savedServer ?? defaultServer
        let launch: SessionLaunch = if pairing {
            try .pairing(
                PairingCredential(
                    origin: #require(URL(string: "http://127.0.0.1:4242")),
                    token: "pairing-code"
                )
            )
        } else {
            .saved(server)
        }
        client = try SessionClient(
            launch: launch,
            store: store,
            transport: transport,
            connection: connection,
            scheduler: scheduler
        )
        client.onStateChange = { [weak self] in self?.states.append($0) }
        client.onExpired = { [weak self] in self?.expirations.append($0) }
    }
}

private actor MockSessionHTTPTransport: SessionHTTPTransporting {
    private let instance = RemoteInstanceInfo(
        instanceId: "instance-1",
        name: "Local dev3",
        appVersion: "1.36.0",
        protocolVersion: 1
    )
    private var exchangeOutcomes: [Result<SessionAuthResponse, MockSessionError>]
    private var refreshOutcomes: [Result<SessionAuthResponse, MockSessionError>]
    private(set) var exchangeCallCount = 0
    private(set) var refreshCallCount = 0

    init(
        exchange: [Result<SessionAuthResponse, MockSessionError>],
        refresh: [Result<SessionAuthResponse, MockSessionError>]
    ) {
        exchangeOutcomes = exchange
        refreshOutcomes = refresh
    }

    func fetchInstance(origin _: URL) async throws -> RemoteInstanceInfo {
        instance
    }

    func exchange(origin _: URL, token _: String) async throws -> SessionAuthResponse {
        exchangeCallCount += 1
        return try next(&exchangeOutcomes)
    }

    func refresh(requestFactory _: SessionRequestFactory) async throws -> SessionAuthResponse {
        refreshCallCount += 1
        return try next(&refreshOutcomes)
    }

    private func next(
        _ outcomes: inout [Result<SessionAuthResponse, MockSessionError>]
    ) throws -> SessionAuthResponse {
        guard !outcomes.isEmpty else { throw MockSessionError.offline }
        let result = outcomes.count == 1 ? outcomes[0] : outcomes.removeFirst()
        return try result.get()
    }
}

private actor MockSessionConnection: SessionConnectionControlling {
    private var handler: (@Sendable (SessionConnectionEvent) -> Void)?
    private var outcomes: [Bool]
    private(set) var connectCallCount = 0
    private(set) var disconnectCallCount = 0

    init(outcomes: [Bool]) {
        self.outcomes = outcomes
    }

    var hasHandler: Bool {
        handler != nil
    }

    func setSessionEventHandler(_ handler: (@Sendable (SessionConnectionEvent) -> Void)?) async {
        self.handler = handler
    }

    func connect() async throws {
        connectCallCount += 1
        let succeeds = outcomes.count == 1 ? outcomes[0] : outcomes.removeFirst()
        if !succeeds {
            throw MockSessionError.offline
        }
    }

    func disconnect() async {
        disconnectCallCount += 1
    }

    func emit(_ event: SessionConnectionEvent) {
        handler?(event)
    }
}

@MainActor
private final class TestSessionScheduler: SessionScheduling {
    private struct Entry {
        let token: UUID
        let deadline: TimeInterval
        let operation: @MainActor @Sendable () -> Void
    }

    private var now: TimeInterval = 0
    private var entries: [Entry] = []
    private(set) var scheduledDelays: [TimeInterval] = []

    var retryDelays: [TimeInterval] {
        scheduledDelays.filter { $0 <= SessionClient.maximumBackoff }
    }

    func schedule(
        after delay: TimeInterval,
        operation: @escaping @MainActor @Sendable () -> Void
    ) -> UUID {
        let token = UUID()
        entries.append(Entry(token: token, deadline: now + delay, operation: operation))
        scheduledDelays.append(delay)
        return token
    }

    func cancel(_ token: UUID) {
        entries.removeAll(where: { $0.token == token })
    }

    func advance(by interval: TimeInterval) async {
        let target = now + interval
        while let next = entries.filter({ $0.deadline <= target }).min(by: { $0.deadline < $1.deadline }) {
            entries.removeAll(where: { $0.token == next.token })
            now = next.deadline
            next.operation()
            await settle()
        }
        now = target
        await settle()
    }
}

private final class SessionMemorySecureStore: SecureDataStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Data?

    func read(account _: String) throws -> Data? {
        lock.withLock { storage }
    }

    func write(_ data: Data, account _: String) throws {
        lock.withLock { storage = data }
    }

    func delete(account _: String) throws {
        lock.withLock { storage = nil }
    }
}

private enum MockSessionError: Error, Sendable {
    case offline
}

@MainActor
private func settle() async {
    for _ in 0 ..< 100 {
        await Task.yield()
    }
}
