import Foundation

public enum PTYSession: Equatable, Sendable {
    case task(String)
    case project(String)

    public var identifier: String {
        switch self {
        case let .task(taskId):
            taskId
        case let .project(projectId):
            "project-\(projectId)"
        }
    }
}

public struct PTYSize: Equatable, Sendable {
    public let columns: Int
    public let rows: Int

    public init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
    }
}

public enum PTYClientError: Error, Equatable, LocalizedError, Sendable {
    case invalidSession
    case invalidSize(columns: Int, rows: Int)
    case notConnected
    case missingSessionParameter(String)
    case unknownSession(String)
    case serverUnavailable(String)
    case upstreamError(String)
    case closed(code: Int, reason: String)
    case transport(String)
    case connectionReplaced

    public var errorDescription: String? {
        switch self {
        case .invalidSession:
            "The PTY session identifier is invalid."
        case let .invalidSize(columns, rows):
            "The PTY size \(columns)×\(rows) is invalid."
        case .notConnected:
            "The PTY is not connected."
        case let .missingSessionParameter(reason), let .unknownSession(reason),
             let .serverUnavailable(reason), let .upstreamError(reason):
            reason
        case let .closed(code, reason):
            reason.isEmpty ? "PTY connection closed with code \(code)." : reason
        case let .transport(message):
            message
        case .connectionReplaced:
            "The PTY connection was replaced."
        }
    }

    public var closeCode: Int? {
        switch self {
        case .missingSessionParameter:
            4000
        case .unknownSession:
            4001
        case .serverUnavailable:
            4002
        case .upstreamError:
            4003
        case let .closed(code, _):
            code
        default:
            nil
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .serverUnavailable, .upstreamError, .transport:
            true
        case let .closed(code, _):
            code != 4000 && code != 4001
        default:
            false
        }
    }

    static func map(_ error: any Error) -> PTYClientError {
        if let error = error as? PTYClientError {
            return error
        }
        if case let WebSocketTransportError.closed(code, reason) = error {
            switch code {
            case 4000:
                return .missingSessionParameter(reason)
            case 4001:
                return .unknownSession(reason)
            case 4002:
                return .serverUnavailable(reason)
            case 4003:
                return .upstreamError(reason)
            default:
                return .closed(code: code, reason: reason)
            }
        }
        return .transport(error.localizedDescription)
    }
}

public enum PTYConnectionState: Equatable, Sendable {
    case disconnected
    case connecting(PTYSession)
    case connected(PTYSession)
    case reconnecting(
        session: PTYSession,
        attempt: Int,
        delay: Duration,
        cause: PTYClientError
    )
    case needsResume(session: PTYSession, state: Dev3TaskSessionState)
    case failed(session: PTYSession, error: PTYClientError)
}

/// Ordered raw PTY transport. Rendering and input interpretation belong to Dev3TerminalKit.
public actor PTYClient {
    // Swift requires this spelling for actor stored properties; SwiftFormat enforces it.
    // swiftlint:disable:next modifier_order
    public nonisolated let output: AsyncStream<Data>
    // swiftlint:disable:next modifier_order
    public nonisolated let states: AsyncStream<PTYConnectionState>

    private let requestBuilder: any AuthenticatedRequestBuilding
    private let transportFactory: any WebSocketTransportCreating
    private let reconnectDelays: [Duration]
    private let resizeInterval: Duration
    private let clock = ContinuousClock()
    private let outputContinuation: AsyncStream<Data>.Continuation
    private let stateContinuation: AsyncStream<PTYConnectionState>.Continuation

    private var state = PTYConnectionState.disconnected
    private var desiredSession: PTYSession?
    private var transport: (any WebSocketTransport)?
    private var generation: UInt64 = 0
    private var activeGeneration: UInt64?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var resizeTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var latestSize: PTYSize?
    private var lastResizeSentAt: ContinuousClock.Instant?

    public init(
        requestBuilder: any AuthenticatedRequestBuilding,
        transportFactory: any WebSocketTransportCreating = URLSessionWebSocketTransportFactory(),
        reconnectDelays: [Duration] = [
            .seconds(2),
            .seconds(4),
            .seconds(8),
            .seconds(15)
        ],
        resizeInterval: Duration = .milliseconds(50)
    ) {
        self.requestBuilder = requestBuilder
        self.transportFactory = transportFactory
        self.reconnectDelays = reconnectDelays.isEmpty ? [.seconds(15)] : reconnectDelays
        self.resizeInterval = resizeInterval

        let outputPair = AsyncStream.makeStream(of: Data.self)
        output = outputPair.stream
        outputContinuation = outputPair.continuation

        let statePair = AsyncStream.makeStream(of: PTYConnectionState.self)
        states = statePair.stream
        stateContinuation = statePair.continuation
        stateContinuation.yield(.disconnected)
    }

    public func stateSnapshot() -> PTYConnectionState {
        state
    }

    /// Starts or replaces the visible session. A recoverable RPC answer is surfaced
    /// without opening a socket so the caller can offer Resume or Restart first.
    public func connect(
        to session: PTYSession,
        resolution: Dev3PTYResolution? = nil
    ) async throws {
        guard Self.isValid(session) else { throw PTYClientError.invalidSession }
        desiredSession = session
        reconnectAttempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil

        if case let .needsResume(sessionState)? = resolution {
            await replaceTransport(reason: "Session needs resume")
            transition(to: .needsResume(session: session, state: sessionState))
            return
        }

        try await open(session: session)
    }

    public func disconnect() async {
        desiredSession = nil
        reconnectAttempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        resizeTask?.cancel()
        resizeTask = nil
        await replaceTransport(reason: "Client disconnected")
        transition(to: .disconnected)
    }

    /// Immediately replaces the visible socket after foreground or path recovery.
    public func kick() async {
        guard let desiredSession else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        do {
            try await open(session: desiredSession)
        } catch {
            // `open` has already published the typed failure and scheduled retry.
        }
    }

    public func send(_ data: Data) async throws {
        guard let candidate = transport, let activeGeneration else {
            throw PTYClientError.notConnected
        }
        do {
            try await candidate.send(.data(data))
        } catch {
            let mapped = PTYClientError.map(error)
            await handleFailure(
                mapped,
                transport: candidate,
                generation: activeGeneration
            )
            throw mapped
        }
    }

    /// Coalesces rapid refits to at most one resize frame per interval.
    public func resize(columns: Int, rows: Int) async throws {
        guard columns > 0, rows > 0 else {
            throw PTYClientError.invalidSize(columns: columns, rows: rows)
        }
        latestSize = PTYSize(columns: columns, rows: rows)
        guard activeGeneration != nil else { return }
        await scheduleOrSendResize()
    }
}

private extension PTYClient {
    static func isValid(_ session: PTYSession) -> Bool {
        let identifier = session.identifier
        return !identifier.isEmpty &&
            identifier.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }

    func open(session: PTYSession) async throws {
        await replaceTransport(reason: "Connection replaced")
        generation &+= 1
        let connectionGeneration = generation
        let request: URLRequest
        let candidate: any WebSocketTransport

        do {
            request = try await requestBuilder.authenticatedRequest(
                path: "/pty",
                queryItems: [URLQueryItem(name: "session", value: session.identifier)]
            )
            candidate = try transportFactory.makeTransport(for: request)
        } catch {
            let mapped = PTYClientError.map(error)
            scheduleReconnect(after: mapped, session: session)
            throw mapped
        }

        transport = candidate
        activeGeneration = connectionGeneration
        transition(to: .connecting(session))
        do {
            try await candidate.connect()
        } catch {
            guard activeGeneration == connectionGeneration else {
                throw PTYClientError.connectionReplaced
            }
            let mapped = PTYClientError.map(error)
            activeGeneration = nil
            transport = nil
            await candidate.disconnect(code: 1001, reason: "Connection failed")
            if activeGeneration == nil, desiredSession == session {
                scheduleReconnect(after: mapped, session: session)
            }
            throw mapped
        }

        guard activeGeneration == connectionGeneration, desiredSession == session else {
            await candidate.disconnect(code: 1000, reason: "Superseded connection")
            throw PTYClientError.connectionReplaced
        }

        reconnectAttempt = 0
        lastResizeSentAt = nil
        transition(to: .connected(session))
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(transport: candidate, generation: connectionGeneration)
        }
        if latestSize != nil {
            await sendLatestResize(generation: connectionGeneration)
        }
    }

    func replaceTransport(reason: String) async {
        generation &+= 1
        activeGeneration = nil
        receiveTask?.cancel()
        receiveTask = nil
        resizeTask?.cancel()
        resizeTask = nil
        lastResizeSentAt = nil
        let previous = transport
        transport = nil
        if let previous {
            await previous.disconnect(code: 1000, reason: reason)
        }
    }

    func receiveLoop(
        transport candidate: any WebSocketTransport,
        generation: UInt64
    ) async {
        while !Task.isCancelled {
            do {
                let frame = try await candidate.receive()
                guard !Task.isCancelled, activeGeneration == generation else { return }
                switch frame {
                case let .data(data):
                    outputContinuation.yield(data)
                case let .text(text):
                    outputContinuation.yield(Data(text.utf8))
                }
            } catch is CancellationError {
                return
            } catch {
                await handleFailure(
                    PTYClientError.map(error),
                    transport: candidate,
                    generation: generation
                )
                return
            }
        }
    }

    func handleFailure(
        _ error: PTYClientError,
        transport failedTransport: any WebSocketTransport,
        generation: UInt64
    ) async {
        guard activeGeneration == generation, let session = desiredSession else { return }
        activeGeneration = nil
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil
        resizeTask?.cancel()
        resizeTask = nil
        await failedTransport.disconnect(code: 1001, reason: "Connection failed")
        guard activeGeneration == nil, desiredSession == session else { return }
        scheduleReconnect(after: error, session: session)
    }

    func scheduleReconnect(after error: PTYClientError, session: PTYSession) {
        guard desiredSession == session else { return }
        guard error.isRetryable else {
            transition(to: .failed(session: session, error: error))
            return
        }

        reconnectAttempt += 1
        let delay = reconnectDelays[min(reconnectAttempt - 1, reconnectDelays.count - 1)]
        transition(to: .reconnecting(
            session: session,
            attempt: reconnectAttempt,
            delay: delay,
            cause: error
        ))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            await self?.retry(session: session)
        }
    }

    func retry(session: PTYSession) async {
        guard desiredSession == session else { return }
        reconnectTask = nil
        do {
            try await open(session: session)
        } catch {
            // `open` publishes and schedules every retryable failure.
        }
    }

    func scheduleOrSendResize() async {
        guard let activeGeneration else { return }
        let now = clock.now
        guard let lastResizeSentAt else {
            await sendLatestResize(generation: activeGeneration)
            return
        }
        let elapsed = lastResizeSentAt.duration(to: now)
        guard elapsed < resizeInterval else {
            await sendLatestResize(generation: activeGeneration)
            return
        }

        resizeTask?.cancel()
        let delay = resizeInterval - elapsed
        resizeTask = Task { [weak self] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            await self?.sendLatestResize(generation: activeGeneration)
        }
    }

    func sendLatestResize(generation: UInt64) async {
        guard activeGeneration == generation,
              let transport,
              let latestSize
        else {
            return
        }
        resizeTask = nil
        let frame = "\u{1B}]resize;\(latestSize.columns);\(latestSize.rows)\u{7}"
        do {
            try await transport.send(.text(frame))
            guard activeGeneration == generation else { return }
            lastResizeSentAt = clock.now
        } catch {
            await handleFailure(
                PTYClientError.map(error),
                transport: transport,
                generation: generation
            )
        }
    }

    func transition(to newState: PTYConnectionState) {
        guard state != newState else { return }
        state = newState
        stateContinuation.yield(newState)
    }
}
