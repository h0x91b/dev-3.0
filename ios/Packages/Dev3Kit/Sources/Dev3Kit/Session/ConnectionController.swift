import Foundation
import Network
import Observation

@MainActor
public protocol NetworkPathObserving: AnyObject {
    var onReachable: (() -> Void)? { get set }

    func start()
    func stop()
}

@MainActor
public final class NetworkPathObserver: NetworkPathObserving {
    public var onReachable: (() -> Void)?

    private let monitor: NWPathMonitor
    private var wasReachable: Bool?

    public init(monitor: NWPathMonitor = NWPathMonitor()) {
        self.monitor = monitor
    }

    public func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.handle(path)
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    public func stop() {
        monitor.cancel()
    }

    private func handle(_ path: NWPath) {
        let reachable = path.status == .satisfied
        defer { wasReachable = reachable }
        guard reachable, wasReachable == false else { return }
        onReachable?()
    }
}

public typealias SessionConnectionFactory =
    @MainActor (any AuthenticatedRequestBuilding) -> any SessionConnectionControlling

@MainActor
@Observable
public final class ConnectionController {
    public private(set) var sessionState = RemoteSessionState.idle
    public private(set) var savedServers: [PairedServer] = []
    public private(set) var activeServer: PairedServer?
    public private(set) var discoveredInstances: [DiscoveredInstance] = []
    public private(set) var isBusy = false
    public var errorMessage: String?
    public var onSessionStateChange: ((RemoteSessionState) -> Void)?
    public var onNetworkReachable: (() -> Void)?

    private let store: PairedServerStore
    private let transport: any SessionHTTPTransporting
    private let discovery: any BonjourDiscovering
    private let pathObserver: any NetworkPathObserving
    private let connectionFactory: SessionConnectionFactory
    private let schedulerFactory: @MainActor () -> any SessionScheduling
    private var session: SessionClient?
    private var hasStarted = false

    public init(
        store: PairedServerStore,
        transport: any SessionHTTPTransporting,
        discovery: any BonjourDiscovering,
        pathObserver: any NetworkPathObserving,
        connectionFactory: @escaping SessionConnectionFactory,
        schedulerFactory: @escaping @MainActor () -> any SessionScheduling = {
            MainActorSessionScheduler()
        }
    ) {
        self.store = store
        self.transport = transport
        self.discovery = discovery
        self.pathObserver = pathObserver
        self.connectionFactory = connectionFactory
        self.schedulerFactory = schedulerFactory
    }

    public func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        installDiscoveryHandlers()
        pathObserver.onReachable = { [weak self] in
            self?.connectionEnvironmentChanged()
            self?.onNetworkReachable?()
        }
        discovery.start()
        pathObserver.start()
        await reloadAndConnectActive()
    }

    public func stop() {
        session?.destroy()
        session = nil
        discovery.stop()
        pathObserver.stop()
        hasStarted = false
        isBusy = false
        sessionState = .idle
        onSessionStateChange?(.idle)
    }

    public func pair(_ credential: PairingCredential, displayName: String? = nil) {
        beginSession(.pairing(credential, displayName: displayName))
    }

    public func connect(to server: PairedServer) async {
        do {
            let snapshot = try await store.setActive(instanceId: server.instanceId)
            apply(snapshot)
            beginSession(.saved(server))
        } catch {
            show(error)
        }
    }

    public func connect(to discovered: DiscoveredInstance) async {
        guard let origin = discovered.origin else {
            errorMessage = "The local instance address is still resolving."
            return
        }
        do {
            guard let saved = try await store.server(instanceId: discovered.instanceId) else {
                errorMessage = "Pair with this instance before reconnecting locally."
                return
            }
            let rebound = try PairedServer(
                origin: origin,
                sessionToken: saved.sessionToken,
                name: saved.name,
                instanceId: saved.instanceId
            )
            let snapshot = try await store.upsert(rebound)
            apply(snapshot)
            beginSession(.saved(rebound))
        } catch {
            show(error)
        }
    }

    public func delete(_ server: PairedServer) async {
        if activeServer?.instanceId == server.instanceId {
            session?.destroy()
            session = nil
        }
        do {
            let snapshot = try await store.delete(instanceId: server.instanceId)
            apply(snapshot)
            if let active = snapshot.activeServer {
                beginSession(.saved(active))
            } else {
                sessionState = .idle
                onSessionStateChange?(.idle)
                isBusy = false
            }
        } catch {
            show(error)
        }
    }

    public func foregrounded() {
        connectionEnvironmentChanged()
    }

    public func clearError() {
        errorMessage = nil
    }
}

private extension ConnectionController {
    func reloadAndConnectActive() async {
        do {
            let snapshot = try await store.load()
            apply(snapshot)
            if let active = snapshot.activeServer {
                beginSession(.saved(active))
            }
        } catch {
            show(error)
        }
    }

    func beginSession(_ launch: SessionLaunch) {
        session?.destroy()
        errorMessage = nil
        isBusy = true
        do {
            let session = try SessionClient(
                launch: launch,
                store: store,
                transport: transport,
                connectionFactory: connectionFactory,
                scheduler: schedulerFactory()
            )
            self.session = session
            bind(session)
            session.start()
        } catch {
            show(error)
        }
    }

    func bind(_ session: SessionClient) {
        session.onStateChange = { [weak self, weak session] state in
            guard let self, self.session === session else { return }
            sessionState = state
            onSessionStateChange?(state)
            isBusy = state == .authenticating || state == .connecting || state == .reconnecting
        }
        session.onServerChange = { [weak self, weak session] server in
            guard let self, self.session === session else { return }
            Task { @MainActor [weak self] in
                await self?.reloadSnapshot(active: server)
            }
        }
        session.onExpired = { [weak self, weak session] _ in
            guard let self, self.session === session else { return }
            isBusy = false
        }
        session.onError = { [weak self, weak session] message in
            guard let self, self.session === session else { return }
            errorMessage = message
        }
    }

    func reloadSnapshot(active server: PairedServer) async {
        do {
            try await apply(store.load())
            activeServer = server
        } catch {
            show(error)
        }
    }

    func apply(_ snapshot: PairedServerSnapshot) {
        savedServers = snapshot.servers
        activeServer = snapshot.activeServer
    }

    func installDiscoveryHandlers() {
        discovery.onInstancesChanged = { [weak self] instances in
            self?.discoveredInstances = instances
        }
        discovery.onError = { [weak self] message in
            guard self?.savedServers.isEmpty == true else { return }
            self?.errorMessage = message
        }
    }

    func connectionEnvironmentChanged() {
        guard session != nil else { return }
        session?.refreshNow()
        session?.kick()
    }

    func show(_ error: any Error) {
        isBusy = false
        errorMessage = (error as? LocalizedError)?.errorDescription ?? "The instance could not be reached."
    }
}
