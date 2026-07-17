@testable import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Pairing scan", .serialized)
struct PairingScanTests {
    @Test("A scanned code begins pairing immediately — no naming step gates the one-time token")
    func scanExchangesImmediately() async {
        let controller = makeController(transport: ScanAcceptedTransport())
        await controller.start()
        await settleScan()

        let error = PairingScan.begin(
            scannedValue: "http://192.168.1.7:4242/?token=one-time-jwt",
            using: controller
        )
        await settleScan()

        #expect(error == nil)
        #expect(controller.sessionState == .connected)
        // The instance is saved under the scanned host name — no separate
        // "name this instance" tap was required to consume the token.
        #expect(controller.activeServer?.name == "192.168.1.7")
    }

    @Test("A non-dev3 QR reports an error and never starts a pairing attempt")
    func scanRejectsNonPairingCode() async {
        let controller = makeController(transport: ScanAcceptedTransport())
        await controller.start()
        await settleScan()

        let error = PairingScan.begin(scannedValue: "https://example.com/not-a-pairing-link", using: controller)
        await settleScan()

        #expect(error != nil)
        #expect(controller.sessionState == .idle)
        #expect(controller.activeServer == nil)
    }
}

@MainActor
private func makeController(transport: any SessionHTTPTransporting) -> ConnectionController {
    ConnectionController(
        store: PairedServerStore(secureStore: ScanMemorySecureData()),
        transport: transport,
        discovery: ScanDiscovery(),
        pathObserver: ScanPathObserver(),
        connectionFactory: { _ in ScanConnection() },
        schedulerFactory: ScanScheduler.init
    )
}

private actor ScanAcceptedTransport: SessionHTTPTransporting {
    func fetchInstance(origin _: URL) async throws -> RemoteInstanceInfo {
        RemoteInstanceInfo(
            instanceId: "scanned-instance",
            name: "Scanned Mac",
            appVersion: "1",
            protocolVersion: 1
        )
    }

    func exchange(origin _: URL, token _: String) async throws -> SessionAuthResponse {
        SessionAuthResponse(statusCode: 200, sessionToken: "scanned-session")
    }

    func refresh(requestFactory _: SessionRequestFactory) async throws -> SessionAuthResponse {
        SessionAuthResponse(statusCode: 200, sessionToken: "scanned-session")
    }
}

private actor ScanConnection: SessionConnectionControlling {
    func setSessionEventHandler(_: (@Sendable (SessionConnectionEvent) -> Void)?) async {}
    func connect() async throws {}
    func disconnect() async {}
}

@MainActor
private final class ScanDiscovery: BonjourDiscovering {
    var onInstancesChanged: (([DiscoveredInstance]) -> Void)?
    var onError: ((String) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
private final class ScanPathObserver: NetworkPathObserving {
    var onReachable: (() -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
private final class ScanScheduler: SessionScheduling {
    func schedule(after _: TimeInterval, operation _: @escaping @MainActor @Sendable () -> Void) -> UUID {
        UUID()
    }

    func cancel(_: UUID) {}
}

private final class ScanMemorySecureData: SecureDataStoring, @unchecked Sendable {
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
private func settleScan() async {
    for _ in 0 ..< 200 {
        await Task.yield()
    }
}
