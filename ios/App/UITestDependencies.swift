#if DEBUG
    import Dev3Kit
    import Foundation

    @MainActor
    enum UITestDependencies {
        static func makeController() -> ConnectionController {
            ConnectionController(
                store: PairedServerStore(secureStore: UITestSecureStore()),
                transport: UITestSessionTransport(),
                discovery: UITestDiscovery(),
                pathObserver: UITestPathObserver(),
                connectionFactory: { _ in UITestSessionConnection() }
            )
        }
    }

    private actor UITestSessionTransport: SessionHTTPTransporting {
        func fetchInstance(origin _: URL) async throws -> RemoteInstanceInfo {
            RemoteInstanceInfo(
                instanceId: "ui-test-instance",
                name: "Simulator dev3",
                appVersion: "1.0.0",
                protocolVersion: 1
            )
        }

        func exchange(origin _: URL, token _: String) async throws -> SessionAuthResponse {
            SessionAuthResponse(statusCode: 200, sessionToken: "ui-test-session")
        }

        func refresh(requestFactory _: SessionRequestFactory) async throws -> SessionAuthResponse {
            SessionAuthResponse(statusCode: 200, sessionToken: "ui-test-refreshed-session")
        }
    }

    private actor UITestSessionConnection: SessionConnectionControlling {
        func setSessionEventHandler(_: (@Sendable (SessionConnectionEvent) -> Void)?) async {}
        func connect() async throws {}
        func disconnect() async {}
    }

    @MainActor
    private final class UITestDiscovery: BonjourDiscovering {
        var onInstancesChanged: (([DiscoveredInstance]) -> Void)?
        var onError: ((String) -> Void)?

        func start() {}
        func stop() {}
    }

    @MainActor
    private final class UITestPathObserver: NetworkPathObserving {
        var onReachable: (() -> Void)?

        func start() {}
        func stop() {}
    }

    private final class UITestSecureStore: SecureDataStoring, @unchecked Sendable {
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
#endif
