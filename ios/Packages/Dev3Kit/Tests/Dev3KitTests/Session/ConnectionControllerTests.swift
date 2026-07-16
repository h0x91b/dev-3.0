@testable import Dev3Kit
import Foundation
import Testing

@MainActor
@Suite("Connection controller", .serialized)
struct ConnectionControllerTests {
    @Test("Start loads the active server, starts discovery, and reconnects")
    func startReconnectsActiveServer() async throws {
        let saved = try makeServer(name: "Studio Mac")
        let harness = try await ControllerHarness(servers: [saved], active: saved)

        await harness.controller.start()
        await settleController()

        #expect(harness.discovery.didStart)
        #expect(harness.pathObserver.didStart)
        #expect(harness.controller.savedServers.map(\.instanceId) == [saved.instanceId])
        #expect(harness.controller.activeServer?.sessionToken == "refreshed-1")
        #expect(harness.controller.sessionState == .connected)
        #expect(harness.connections.items.count == 1)
    }

    @Test("Manual or scanned pairing stores the chosen server name")
    func pairingStoresDisplayName() async throws {
        let harness = try await ControllerHarness()
        await harness.controller.start()
        let credential = try PairingCredential(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            token: "pairing-code"
        )

        harness.controller.pair(credential, displayName: "Pocket Studio")
        await settleController()

        #expect(harness.controller.sessionState == .connected)
        #expect(harness.controller.activeServer?.name == "Pocket Studio")
        #expect(try await harness.store.load().activeServer?.name == "Pocket Studio")
    }

    @Test("Bonjour can move a saved credential to a newly resolved local origin")
    func discoveredOriginRebindsSavedCredential() async throws {
        let saved = try makeServer(origin: "https://old.example.test", name: "Studio Mac")
        let harness = try await ControllerHarness(servers: [saved], active: saved)
        await harness.controller.start()
        await settleController()
        let localOrigin = try #require(URL(string: "http://192.168.1.8:4242"))
        let discovered = DiscoveredInstance(
            serviceName: "dev3 Studio Mac",
            instanceId: saved.instanceId,
            protocolVersion: 1,
            appVersion: "1.36.0",
            origin: localOrigin
        )

        await harness.controller.connect(to: discovered)
        await settleController()

        #expect(harness.controller.activeServer?.origin == localOrigin)
        #expect(try await harness.store.load().activeServer?.origin == localOrigin)
        #expect(harness.connections.items.count == 2)
    }

    @Test("Deleting the active server selects and reconnects the remaining server")
    func deleteSelectsRemainingServer() async throws {
        let first = try makeServer(instanceId: "instance-1", name: "Alpha")
        let second = try makeServer(origin: "https://beta.example.test", instanceId: "instance-2", name: "Beta")
        let harness = try await ControllerHarness(servers: [first, second], active: second)
        await harness.controller.start()
        await settleController()

        await harness.controller.delete(second)
        await settleController()

        #expect(harness.controller.activeServer?.instanceId == first.instanceId)
        #expect(harness.controller.savedServers.map(\.instanceId) == [first.instanceId])
        #expect(harness.controller.sessionState == .connected)
        #expect(harness.connections.items.count == 2)
    }

    @Test("Foreground and recovered paths refresh and replace live connections")
    func lifecycleKick() async throws {
        let saved = try makeServer(name: "Studio Mac")
        let harness = try await ControllerHarness(servers: [saved], active: saved)
        await harness.controller.start()
        await settleController()
        let connection = try #require(harness.connections.items.first)

        harness.controller.foregrounded()
        await settleController()
        let callsAfterForeground = await connection.connectCallCount
        harness.pathObserver.emitReachable()
        await settleController()

        #expect(callsAfterForeground >= 2)
        #expect(await connection.connectCallCount >= 3)
        #expect(await harness.transport.refreshCallCount >= 3)
    }

    private func makeServer(
        origin: String = "http://127.0.0.1:4242",
        instanceId: String = "instance-1",
        name: String
    ) throws -> PairedServer {
        try PairedServer(
            origin: #require(URL(string: origin)),
            sessionToken: "saved-session",
            name: name,
            instanceId: instanceId
        )
    }
}

@MainActor
private final class ControllerHarness {
    let store: PairedServerStore
    let transport = ControllerTransport()
    let discovery = ControllerDiscovery()
    let pathObserver = ControllerPathObserver()
    let connections = ControllerConnectionPool()
    let controller: ConnectionController

    init(servers: [PairedServer] = [], active: PairedServer? = nil) async throws {
        store = PairedServerStore(secureStore: ControllerMemoryStore())
        for server in servers {
            _ = try await store.upsert(server, makeActive: server.instanceId == active?.instanceId)
        }
        if let active {
            _ = try await store.setActive(instanceId: active.instanceId)
        }
        controller = ConnectionController(
            store: store,
            transport: transport,
            discovery: discovery,
            pathObserver: pathObserver,
            connectionFactory: { [connections] _ in
                connections.make()
            },
            schedulerFactory: ControllerScheduler.init
        )
    }
}

private actor ControllerTransport: SessionHTTPTransporting {
    private(set) var refreshCallCount = 0

    func fetchInstance(origin _: URL) async throws -> RemoteInstanceInfo {
        RemoteInstanceInfo(
            instanceId: "instance-1",
            name: "Development Mac",
            appVersion: "1.36.0",
            protocolVersion: 1
        )
    }

    func exchange(origin _: URL, token _: String) async throws -> SessionAuthResponse {
        SessionAuthResponse(statusCode: 200, sessionToken: "exchanged-session")
    }

    func refresh(requestFactory _: SessionRequestFactory) async throws -> SessionAuthResponse {
        refreshCallCount += 1
        return SessionAuthResponse(statusCode: 200, sessionToken: "refreshed-\(refreshCallCount)")
    }
}

private actor ControllerConnection: SessionConnectionControlling {
    private var handler: (@Sendable (SessionConnectionEvent) -> Void)?
    private(set) var connectCallCount = 0
    private(set) var disconnectCallCount = 0

    func setSessionEventHandler(_ handler: (@Sendable (SessionConnectionEvent) -> Void)?) async {
        self.handler = handler
    }

    func connect() async throws {
        connectCallCount += 1
    }

    func disconnect() async {
        disconnectCallCount += 1
    }
}

@MainActor
private final class ControllerConnectionPool {
    private(set) var items: [ControllerConnection] = []

    func make() -> ControllerConnection {
        let connection = ControllerConnection()
        items.append(connection)
        return connection
    }
}

@MainActor
private final class ControllerDiscovery: BonjourDiscovering {
    var onInstancesChanged: (([DiscoveredInstance]) -> Void)?
    var onError: ((String) -> Void)?
    private(set) var didStart = false

    func start() {
        didStart = true
    }

    func stop() {}
}

@MainActor
private final class ControllerPathObserver: NetworkPathObserving {
    var onReachable: (() -> Void)?
    private(set) var didStart = false

    func start() {
        didStart = true
    }

    func stop() {}

    func emitReachable() {
        onReachable?()
    }
}

@MainActor
private final class ControllerScheduler: SessionScheduling {
    func schedule(
        after _: TimeInterval,
        operation _: @escaping @MainActor @Sendable () -> Void
    ) -> UUID {
        UUID()
    }

    func cancel(_: UUID) {}
}

private final class ControllerMemoryStore: SecureDataStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func read(account _: String) throws -> Data? {
        lock.withLock { data }
    }

    func write(_ data: Data, account _: String) throws {
        lock.withLock { self.data = data }
    }

    func delete(account _: String) throws {
        lock.withLock { data = nil }
    }
}

@MainActor
private func settleController() async {
    for _ in 0 ..< 200 {
        await Task.yield()
    }
}
