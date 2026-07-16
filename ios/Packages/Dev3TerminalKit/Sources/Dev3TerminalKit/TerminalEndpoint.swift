import Foundation

public enum Dev3TerminalConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int, delay: Duration)
    case needsResume
    case failed(message: String)
}

public enum Dev3TerminalOutputEvent: Equatable, Sendable {
    case data(Data)
    case reset
}

public struct Dev3TerminalOutputSequence: AsyncSequence, Sendable {
    public typealias Element = Dev3TerminalOutputEvent

    private let nextImplementation: @Sendable () async -> Element?

    init(next: @escaping @Sendable () async -> Element?) {
        nextImplementation = next
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(next: nextImplementation)
    }

    public struct Iterator: AsyncIteratorProtocol {
        private let nextImplementation: @Sendable () async -> Element?

        fileprivate init(next: @escaping @Sendable () async -> Element?) {
            nextImplementation = next
        }

        public mutating func next() async -> Element? {
            await nextImplementation()
        }
    }
}

public struct Dev3TerminalEndpoint: Sendable {
    static let maxBufferedOutputBytes = 4 * 1024 * 1024

    public let identity: String
    /// Creates a newest-view lease without exposing the endpoint's sole PTY iterator.
    public var output: Dev3TerminalOutputSequence {
        makeOutputStream()
    }

    public var clipboardText: AsyncStream<String> {
        makeClipboardStream()
    }

    public var connectionStates: AsyncStream<Dev3TerminalConnectionState> {
        makeConnectionStateStream()
    }

    private let makeOutputStream: @Sendable () -> Dev3TerminalOutputSequence
    private let makeClipboardStream: @Sendable () -> AsyncStream<String>
    private let makeConnectionStateStream: @Sendable () -> AsyncStream<Dev3TerminalConnectionState>
    private let sendImplementation: @Sendable (Data) async throws -> Void
    private let resizeImplementation: @Sendable (Int, Int) async throws -> Void

    public init(
        identity: String,
        output: AsyncStream<Data>,
        clipboardText: AsyncStream<String> = .finished,
        connectionStates: AsyncStream<Dev3TerminalConnectionState> = .finished,
        send: @escaping @Sendable (Data) async throws -> Void,
        resize: @escaping @Sendable (Int, Int) async throws -> Void
    ) {
        self.init(
            identity: identity,
            output: output,
            clipboardText: clipboardText,
            connectionStates: connectionStates,
            maxBufferedOutputBytes: Self.maxBufferedOutputBytes,
            recoverOutputOverflow: {},
            send: send,
            resize: resize
        )
    }

    init(
        identity: String,
        output: AsyncStream<Data>,
        clipboardText: AsyncStream<String>,
        connectionStates: AsyncStream<Dev3TerminalConnectionState>,
        maxBufferedOutputBytes: Int = Self.maxBufferedOutputBytes,
        recoverOutputOverflow: @escaping @Sendable () async -> Void,
        send: @escaping @Sendable (Data) async throws -> Void,
        resize: @escaping @Sendable (Int, Int) async throws -> Void
    ) {
        self.identity = identity
        let outputRelay = Dev3TerminalOutputRelay(
            source: output,
            maxBufferedBytes: maxBufferedOutputBytes,
            recoverOverflow: recoverOutputOverflow
        )
        let clipboardRelay = Dev3TerminalStreamRelay(
            source: clipboardText,
            bufferingPolicy: .bufferingNewest(1),
            replaysLatest: false
        )
        let connectionStateRelay = Dev3TerminalStreamRelay(
            source: connectionStates,
            bufferingPolicy: .bufferingNewest(1),
            replaysLatest: true
        )
        makeOutputStream = { outputRelay.subscribe() }
        makeClipboardStream = { clipboardRelay.subscribe() }
        makeConnectionStateStream = { connectionStateRelay.subscribe() }
        sendImplementation = send
        resizeImplementation = resize
    }

    public func send(_ data: Data) async throws {
        try await sendImplementation(data)
    }

    public func resize(columns: Int, rows: Int) async throws {
        try await resizeImplementation(columns, rows)
    }
}

private final class Dev3TerminalOutputRelay: @unchecked Sendable {
    private static let preferredChunkBytes = 64 * 1024
    private typealias Event = Dev3TerminalOutputEvent
    private typealias Waiter = CheckedContinuation<Void, Never>

    private struct Subscription {
        let id: UUID
        var waiter: Waiter?
    }

    private struct State {
        var subscription: Subscription?
        var bufferedEvents: [Event] = []
        var bufferedBytes = 0
        var hasStarted = false
        var isFinished = false
        var overflowRecoveryID: UUID?
    }

    private struct SubscriptionUpdate {
        let isFinished: Bool
        let shouldStart: Bool
        let previous: Waiter?
    }

    private let source: AsyncStream<Data>
    private let maxBufferedBytes: Int
    private let recoverOverflow: @Sendable () async -> Void
    private let lock = NSLock()
    private var state = State()
    private var sourceTask: Task<Void, Never>?
    private var overflowTask: Task<Void, Never>?

    init(
        source: AsyncStream<Data>,
        maxBufferedBytes: Int,
        recoverOverflow: @escaping @Sendable () async -> Void
    ) {
        self.source = source
        self.maxBufferedBytes = max(1, maxBufferedBytes)
        self.recoverOverflow = recoverOverflow
    }

    deinit {
        sourceTask?.cancel()
        overflowTask?.cancel()
        finish()
    }

    func subscribe() -> Dev3TerminalOutputSequence {
        let subscriptionID = UUID()
        let update = lock.withLock { () -> SubscriptionUpdate in
            guard !state.isFinished || !state.bufferedEvents.isEmpty else {
                return SubscriptionUpdate(isFinished: true, shouldStart: false, previous: nil)
            }
            let previous = state.subscription?.waiter
            state.subscription = Subscription(id: subscriptionID)
            guard !state.hasStarted else {
                return SubscriptionUpdate(
                    isFinished: false,
                    shouldStart: false,
                    previous: previous
                )
            }
            state.hasStarted = true
            return SubscriptionUpdate(
                isFinished: false,
                shouldStart: true,
                previous: previous
            )
        }
        update.previous?.resume()
        if update.isFinished {
            return Dev3TerminalOutputSequence { nil }
        }
        if update.shouldStart {
            // Start lazily so the upstream AsyncStream preserves events emitted before the first view.
            // The pump then remains alive across every downstream cancellation until endpoint teardown.
            startSourcePump()
        }
        return Dev3TerminalOutputSequence { [self] in
            return await next(subscriptionID)
        }
    }

    private func startSourcePump() {
        let task = Task { [weak self, source] in
            for await data in source {
                guard !Task.isCancelled else { break }
                self?.publish(data)
            }
            self?.finish()
        }
        lock.withLock {
            sourceTask = task
        }
    }

    private func publish(_ data: Data) {
        guard !data.isEmpty else { return }
        var lowerBound = data.startIndex
        while lowerBound < data.endIndex {
            let chunkSize = min(Self.preferredChunkBytes, maxBufferedBytes)
            let upperBound = min(lowerBound + chunkSize, data.endIndex)
            let chunk = Data(data[lowerBound ..< upperBound])
            publishChunk(chunk)
            lowerBound = upperBound
        }
    }

    private func publishChunk(_ chunk: Data) {
        let update = lock.withLock {
            () -> (waiter: Waiter?, recoveryID: UUID?) in
            guard !state.isFinished else { return (nil, nil) }

            var recoveryID: UUID?
            if state.bufferedBytes + chunk.count > maxBufferedBytes {
                // The queue is relay-owned: a view handoff cannot silently erase a transport gap.
                state.bufferedEvents.removeAll(keepingCapacity: false)
                state.bufferedBytes = 0
                state.bufferedEvents.append(.reset)
                if state.overflowRecoveryID == nil {
                    let newRecoveryID = UUID()
                    state.overflowRecoveryID = newRecoveryID
                    recoveryID = newRecoveryID
                }
            }
            state.bufferedEvents.append(.data(chunk))
            state.bufferedBytes += chunk.count

            var waiter: Waiter?
            if var subscription = state.subscription {
                waiter = subscription.waiter
                subscription.waiter = nil
                state.subscription = subscription
            }
            return (waiter, recoveryID)
        }
        // A waiter is only a wake signal. `next` must reacquire the lock and validate its lease
        // before it can remove an event from the relay-global queue.
        update.waiter?.resume()
        guard let recoveryID = update.recoveryID else { return }
        let task = Task { [weak self, recoverOverflow] in
            await recoverOverflow()
            self?.finishOverflowRecovery(recoveryID)
        }
        lock.withLock {
            if state.overflowRecoveryID == recoveryID {
                overflowTask = task
            }
        }
    }

    private func finishOverflowRecovery(_ recoveryID: UUID) {
        lock.withLock {
            guard state.overflowRecoveryID == recoveryID else { return }
            state.overflowRecoveryID = nil
            overflowTask = nil
        }
    }

    private func next(_ subscriptionID: UUID) async -> Event? {
        while true {
            let event = lock.withLock { () -> Event?? in
                guard !Task.isCancelled,
                      state.subscription?.id == subscriptionID
                else {
                    return .some(nil)
                }
                if !state.bufferedEvents.isEmpty {
                    let event = state.bufferedEvents.removeFirst()
                    if case let .data(data) = event {
                        state.bufferedBytes -= data.count
                    }
                    if state.bufferedEvents.isEmpty {
                        state.bufferedEvents.removeAll(keepingCapacity: false)
                    }
                    return .some(event)
                }
                return state.isFinished ? .some(nil) : nil
            }
            if let event {
                return event
            }

            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    let shouldResume = lock.withLock { () -> Bool in
                        guard !Task.isCancelled,
                              var subscription = state.subscription,
                              subscription.id == subscriptionID,
                              state.bufferedEvents.isEmpty,
                              !state.isFinished,
                              subscription.waiter == nil
                        else {
                            return true
                        }
                        subscription.waiter = continuation
                        state.subscription = subscription
                        return false
                    }
                    if shouldResume {
                        continuation.resume()
                    }
                }
            } onCancel: {
                remove(subscriptionID)
            }
        }
    }

    private func remove(_ subscriptionID: UUID) {
        let waiter = lock.withLock { () -> Waiter? in
            guard state.subscription?.id == subscriptionID else { return nil }
            let waiter = state.subscription?.waiter
            state.subscription = nil
            return waiter
        }
        waiter?.resume()
    }

    private func finish() {
        let waiter = lock.withLock {
            guard !state.isFinished else { return nil as Waiter? }
            state.isFinished = true
            let waiter = state.subscription?.waiter
            state.subscription?.waiter = nil
            return waiter
        }
        waiter?.resume()
    }
}

public extension AsyncStream {
    static var finished: AsyncStream<Element> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }
}
