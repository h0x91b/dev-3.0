import Foundation

public enum RemoteSessionState: String, CaseIterable, Equatable, Sendable {
    case idle
    case authenticating
    case connecting
    case connected
    case reconnecting
    case expired
}

public enum SessionLaunch: Equatable, Sendable {
    case saved(PairedServer)
    case pairing(PairingCredential, displayName: String? = nil)

    var origin: URL {
        switch self {
        case let .saved(server):
            server.origin
        case let .pairing(credential, _):
            credential.origin
        }
    }
}

public enum SessionConnectionEvent: Equatable, Sendable {
    case opened
    case closed(code: Int, reason: String)
    case failed
}

public protocol SessionConnectionControlling: Sendable {
    func setSessionEventHandler(_ handler: (@Sendable (SessionConnectionEvent) -> Void)?) async
    func connect() async throws
    func disconnect() async
}

@MainActor
public protocol SessionScheduling: AnyObject {
    func schedule(
        after delay: TimeInterval,
        operation: @escaping @MainActor @Sendable () -> Void
    ) -> UUID
    func cancel(_ token: UUID)
}

@MainActor
public final class MainActorSessionScheduler: SessionScheduling {
    private var tasks: [UUID: Task<Void, Never>] = [:]

    public init() {}

    public func schedule(
        after delay: TimeInterval,
        operation: @escaping @MainActor @Sendable () -> Void
    ) -> UUID {
        let token = UUID()
        tasks[token] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.tasks[token] = nil
            operation()
        }
        return token
    }

    public func cancel(_ token: UUID) {
        tasks.removeValue(forKey: token)?.cancel()
    }
}

public enum SessionExpirationReason: Equatable, Sendable {
    case noSavedSession
    case exchangeAndRefreshRejected
    case refreshRejected
    case sessionRejectedAfterClose
    case invalidServerResponse
    case secureStoreUnavailable
}

@MainActor
public final class SessionClient {
    public static let refreshInterval: TimeInterval = 15 * 60
    public static let initialBackoff: TimeInterval = 2
    public static let maximumBackoff: TimeInterval = 15

    public private(set) var state = RemoteSessionState.idle
    public private(set) var currentServer: PairedServer?
    public let requestFactory: SessionRequestFactory

    public var onStateChange: ((RemoteSessionState) -> Void)?
    public var onServerChange: ((PairedServer) -> Void)?
    public var onExpired: ((SessionExpirationReason) -> Void)?
    public var onError: ((String) -> Void)?

    private let launch: SessionLaunch
    private let store: PairedServerStore
    private let transport: any SessionHTTPTransporting
    private let connection: any SessionConnectionControlling
    private let scheduler: any SessionScheduling
    private let refreshInterval: TimeInterval
    private let initialBackoff: TimeInterval
    private let maximumBackoff: TimeInterval

    private var started = false
    private var destroyed = false
    private var qrSpent = false
    private var attempts = 0
    private var retryTimer: UUID?
    private var refreshTimer: UUID?

    public convenience init(
        launch: SessionLaunch,
        store: PairedServerStore,
        transport: any SessionHTTPTransporting,
        connection: any SessionConnectionControlling,
        scheduler: any SessionScheduling = MainActorSessionScheduler(),
        refreshInterval: TimeInterval = SessionClient.refreshInterval,
        initialBackoff: TimeInterval = SessionClient.initialBackoff,
        maximumBackoff: TimeInterval = SessionClient.maximumBackoff
    ) throws {
        try self.init(
            launch: launch,
            store: store,
            transport: transport,
            connectionFactory: { _ in connection },
            scheduler: scheduler,
            refreshInterval: refreshInterval,
            initialBackoff: initialBackoff,
            maximumBackoff: maximumBackoff
        )
    }

    public init(
        launch: SessionLaunch,
        store: PairedServerStore,
        transport: any SessionHTTPTransporting,
        connectionFactory: (any AuthenticatedRequestBuilding) -> any SessionConnectionControlling,
        scheduler: any SessionScheduling = MainActorSessionScheduler(),
        refreshInterval: TimeInterval = SessionClient.refreshInterval,
        initialBackoff: TimeInterval = SessionClient.initialBackoff,
        maximumBackoff: TimeInterval = SessionClient.maximumBackoff
    ) throws {
        self.launch = launch
        self.store = store
        self.transport = transport
        self.scheduler = scheduler
        self.refreshInterval = refreshInterval
        self.initialBackoff = initialBackoff
        self.maximumBackoff = maximumBackoff
        let requestFactory: SessionRequestFactory
        switch launch {
        case let .saved(server):
            currentServer = server
            requestFactory = SessionRequestFactory(server: server)
        case let .pairing(credential, _):
            requestFactory = try SessionRequestFactory(origin: credential.origin)
        }
        self.requestFactory = requestFactory
        connection = connectionFactory(requestFactory)
    }
}

public extension SessionClient {
    func start() {
        guard !started, !destroyed else { return }
        started = true
        Task { [weak self] in
            guard let self else { return }
            await installConnectionHandler()
            await bootAuthentication()
        }
    }

    func kick() {
        guard started, !destroyed, state != .expired, state != .authenticating else { return }
        cancelRetry()
        Task { [weak self] in
            guard let self else { return }
            await disconnectIgnoringEvents()
            await attemptConnection()
        }
    }

    func refreshNow() {
        guard started, !destroyed, currentServer != nil, state != .expired else { return }
        Task { [weak self] in
            await self?.performPeriodicRefresh()
        }
    }

    func destroy() {
        guard !destroyed else { return }
        destroyed = true
        cancelRetry()
        cancelRefresh()
        let connection = connection
        Task {
            await connection.setSessionEventHandler(nil)
            await connection.disconnect()
        }
    }
}

private extension SessionClient {
    private func installConnectionHandler() async {
        await connection.setSessionEventHandler { [weak self] event in
            Task { @MainActor [weak self] in
                await self?.handleConnectionEvent(event)
            }
        }
    }

    private func bootAuthentication() async {
        guard !isDead else { return }
        setState(.authenticating)
        switch launch {
        case let .saved(server):
            await activate(server)
            await refreshForBoot(expirationReason: .noSavedSession)
        case let .pairing(credential, displayName):
            await authenticatePairing(credential, displayName: displayName)
        }
    }

    private func authenticatePairing(_ credential: PairingCredential, displayName: String?) async {
        do {
            let instance = try await transport.fetchInstance(origin: credential.origin)
            guard !isDead else { return }
            let fallback = try await pairingFallback(instance: instance, origin: credential.origin)

            guard !qrSpent else {
                await usePairingFallback(fallback)
                return
            }

            let response = try await transport.exchange(origin: credential.origin, token: credential.token)
            guard !isDead else { return }
            qrSpent = true
            try await handlePairingResponse(
                response,
                credential: credential,
                instance: instance,
                displayName: displayName,
                fallback: fallback
            )
        } catch let error as SessionHTTPError {
            if case .unsupportedProtocol = error {
                onError?(error.localizedDescription)
                expire(.invalidServerResponse)
            } else {
                scheduleBootRetry()
            }
        } catch {
            scheduleBootRetry()
        }
    }

    private func pairingFallback(instance: RemoteInstanceInfo, origin: URL) async throws -> PairedServer? {
        if let matchingInstance = try await store.server(instanceId: instance.instanceId) {
            return matchingInstance
        }
        return try await store.server(origin: origin)
    }

    private func usePairingFallback(_ fallback: PairedServer?) async {
        guard let fallback else {
            expire(.exchangeAndRefreshRejected)
            return
        }
        await activate(fallback)
        await refreshForBoot(expirationReason: .exchangeAndRefreshRejected)
    }

    private func handlePairingResponse(
        _ response: SessionAuthResponse,
        credential: PairingCredential,
        instance: RemoteInstanceInfo,
        displayName: String?,
        fallback: PairedServer?
    ) async throws {
        guard response.isAccepted, let sessionToken = response.sessionToken else {
            if fallback != nil {
                await usePairingFallback(fallback)
            } else if response.isRejected {
                expire(.exchangeAndRefreshRejected)
            } else {
                scheduleBootRetry()
            }
            return
        }
        let server = try PairedServer(
            origin: credential.origin,
            sessionToken: sessionToken,
            name: displayName ?? instance.name,
            instanceId: instance.instanceId
        )
        try await persistAndActivate(server)
        attempts = 0
        startRefreshLoop()
        await attemptConnection()
    }

    private func refreshForBoot(expirationReason: SessionExpirationReason) async {
        do {
            let response = try await transport.refresh(requestFactory: requestFactory)
            guard !isDead else { return }
            if response.isAccepted, let sessionToken = response.sessionToken {
                try await rotateSessionToken(sessionToken)
                attempts = 0
                startRefreshLoop()
                await attemptConnection()
            } else if response.isRejected {
                expire(expirationReason)
            } else {
                scheduleBootRetry()
            }
        } catch {
            scheduleBootRetry()
        }
    }

    private func attemptConnection() async {
        guard !isDead else { return }
        setState(state == .connected || state == .reconnecting ? .reconnecting : .connecting)
        do {
            try await connection.connect()
            guard !isDead else { return }
            attempts = 0
            setState(.connected)
        } catch {
            guard !isDead else { return }
            setState(.reconnecting)
            scheduleConnectionRetry()
        }
    }

    private func handleConnectionEvent(_ event: SessionConnectionEvent) async {
        guard !isDead else { return }
        switch event {
        case .opened:
            attempts = 0
            setState(.connected)
        case .failed:
            setState(.reconnecting)
            await probeAfterConnectionClose()
        case .closed:
            setState(.reconnecting)
            await probeAfterConnectionClose()
        }
    }

    private func probeAfterConnectionClose() async {
        do {
            let response = try await transport.refresh(requestFactory: requestFactory)
            guard !isDead else { return }
            if response.isAccepted, let sessionToken = response.sessionToken {
                try await rotateSessionToken(sessionToken)
                scheduleConnectionRetry()
            } else if response.isRejected {
                expire(.sessionRejectedAfterClose)
            } else {
                scheduleConnectionRetry()
            }
        } catch {
            scheduleConnectionRetry()
        }
    }

    private func performPeriodicRefresh() async {
        cancelRefresh()
        do {
            let response = try await transport.refresh(requestFactory: requestFactory)
            guard !isDead else { return }
            if response.isAccepted, let sessionToken = response.sessionToken {
                try await rotateSessionToken(sessionToken)
                startRefreshLoop()
            } else if response.isRejected {
                expire(.refreshRejected)
            } else {
                startRefreshLoop()
            }
        } catch {
            guard !isDead else { return }
            startRefreshLoop()
        }
    }

    private func persistAndActivate(_ server: PairedServer) async throws {
        do {
            _ = try await store.upsert(server)
            await activate(server)
        } catch {
            expire(.secureStoreUnavailable)
            throw error
        }
    }

    private func rotateSessionToken(_ token: String) async throws {
        guard let currentServer else { throw SessionRequestError.invalidCredential }
        let refreshed = try PairedServer(
            origin: currentServer.origin,
            sessionToken: token,
            name: currentServer.name,
            instanceId: currentServer.instanceId
        )
        try await persistAndActivate(refreshed)
    }

    private func activate(_ server: PairedServer) async {
        currentServer = server
        await requestFactory.update(server: server)
        onServerChange?(server)
    }

    private func startRefreshLoop() {
        guard refreshTimer == nil, !isDead else { return }
        refreshTimer = scheduler.schedule(after: refreshInterval) { [weak self] in
            self?.refreshTimer = nil
            self?.refreshNow()
        }
    }

    private func scheduleBootRetry() {
        guard retryTimer == nil, !isDead else { return }
        setState(currentServer == nil ? .connecting : .reconnecting)
        retryTimer = scheduler.schedule(after: nextBackoffDelay()) { [weak self] in
            self?.retryTimer = nil
            Task { [weak self] in
                await self?.bootAuthentication()
            }
        }
    }

    private func scheduleConnectionRetry() {
        guard retryTimer == nil, !isDead else { return }
        retryTimer = scheduler.schedule(after: nextBackoffDelay()) { [weak self] in
            self?.retryTimer = nil
            Task { [weak self] in
                await self?.attemptConnection()
            }
        }
    }

    private func nextBackoffDelay() -> TimeInterval {
        let delay = min(initialBackoff * pow(2, Double(attempts)), maximumBackoff)
        attempts += 1
        return delay
    }

    private func disconnectIgnoringEvents() async {
        await connection.setSessionEventHandler(nil)
        await connection.disconnect()
        guard !isDead else { return }
        await installConnectionHandler()
    }

    private func expire(_ reason: SessionExpirationReason) {
        guard !isDead else { return }
        cancelRetry()
        cancelRefresh()
        setState(.expired)
        onExpired?(reason)
        Task { [weak self] in
            guard let self else { return }
            await disconnectIgnoringEvents()
        }
    }

    private func setState(_ next: RemoteSessionState) {
        guard state != next else { return }
        state = next
        onStateChange?(next)
    }

    private func cancelRetry() {
        guard let retryTimer else { return }
        scheduler.cancel(retryTimer)
        self.retryTimer = nil
    }

    private func cancelRefresh() {
        guard let refreshTimer else { return }
        scheduler.cancel(refreshTimer)
        self.refreshTimer = nil
    }

    private var isDead: Bool {
        destroyed || state == .expired
    }
}
