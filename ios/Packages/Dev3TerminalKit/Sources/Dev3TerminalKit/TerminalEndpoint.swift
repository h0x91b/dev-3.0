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
            bufferingPolicy: .bufferingNewest(1)
        )
        let connectionStateRelay = Dev3TerminalStreamRelay(
            source: connectionStates,
            bufferingPolicy: .bufferingNewest(1)
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
    private typealias Waiter = CheckedContinuation<Event?, Never>

    private struct Subscription {
        let id: UUID
        var bufferedEvents: [Event] = []
        var bufferedBytes = 0
        var waiter: Waiter?
    }

    private struct State {
        var subscription: Subscription?
        var hasStarted = false
        var isFinished = false
        var isRecoveringOverflow = false
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
            guard !state.isFinished else {
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
        update.previous?.resume(returning: nil)
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
            () -> (waiter: Waiter?, shouldRecover: Bool) in
            guard var subscription = state.subscription else { return (nil, false) }
            if let waiter = subscription.waiter {
                subscription.waiter = nil
                state.subscription = subscription
                return (waiter, false)
            }

            var shouldRecover = false
            if subscription.bufferedBytes + chunk.count > maxBufferedBytes {
                // Never join bytes across a gap: discard the old queue and reset SwiftTerm before
                // delivering the suffix that triggered transport recovery.
                subscription.bufferedEvents = [.reset]
                subscription.bufferedBytes = 0
                if !state.isRecoveringOverflow {
                    state.isRecoveringOverflow = true
                    shouldRecover = true
                }
            }
            subscription.bufferedEvents.append(.data(chunk))
            subscription.bufferedBytes += chunk.count
            state.subscription = subscription
            return (nil, shouldRecover)
        }
        update.waiter?.resume(returning: .data(chunk))
        guard update.shouldRecover else { return }
        let task = Task { [weak self, recoverOverflow] in
            await recoverOverflow()
            self?.finishOverflowRecovery()
        }
        lock.withLock {
            overflowTask?.cancel()
            overflowTask = task
        }
    }

    private func finishOverflowRecovery() {
        lock.withLock {
            state.isRecoveringOverflow = false
            overflowTask = nil
        }
    }

    private func next(_ subscriptionID: UUID) async -> Event? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let result = lock.withLock { () -> Event?? in
                    guard !Task.isCancelled,
                          var subscription = state.subscription,
                          subscription.id == subscriptionID,
                          !state.isFinished
                    else {
                        return .some(nil)
                    }
                    if !subscription.bufferedEvents.isEmpty {
                        let event = subscription.bufferedEvents.removeFirst()
                        if case let .data(data) = event {
                            subscription.bufferedBytes -= data.count
                        }
                        state.subscription = subscription
                        return .some(event)
                    }
                    guard subscription.waiter == nil else { return .some(nil) }
                    subscription.waiter = continuation
                    state.subscription = subscription
                    return nil
                }
                if let result {
                    continuation.resume(returning: result)
                }
            }
        } onCancel: {
            remove(subscriptionID)
        }
    }

    private func remove(_ subscriptionID: UUID) {
        let waiter = lock.withLock { () -> Waiter? in
            guard state.subscription?.id == subscriptionID else { return nil }
            let waiter = state.subscription?.waiter
            state.subscription = nil
            state.isRecoveringOverflow = false
            return waiter
        }
        waiter?.resume(returning: nil)
    }

    private func finish() {
        let waiter = lock.withLock {
            guard !state.isFinished else { return nil as Waiter? }
            state.isFinished = true
            let waiter = state.subscription?.waiter
            state.subscription = nil
            state.isRecoveringOverflow = false
            return waiter
        }
        waiter?.resume(returning: nil)
    }
}

private final class Dev3TerminalStreamRelay<Element: Sendable>: @unchecked Sendable {
    private typealias Continuation = AsyncStream<Element>.Continuation

    private struct Subscription {
        let id: UUID
        let continuation: Continuation
    }

    private struct State {
        var subscription: Subscription?
        var hasStarted = false
        var isFinished = false
    }

    private struct SubscriptionUpdate {
        let isFinished: Bool
        let shouldStart: Bool
        let previous: Continuation?
    }

    private let source: AsyncStream<Element>
    private let bufferingPolicy: Continuation.BufferingPolicy
    private let lock = NSLock()
    private var state = State()
    private var sourceTask: Task<Void, Never>?

    init(
        source: AsyncStream<Element>,
        bufferingPolicy: AsyncStream<Element>.Continuation.BufferingPolicy
    ) {
        self.source = source
        self.bufferingPolicy = bufferingPolicy
    }

    deinit {
        sourceTask?.cancel()
        finish()
    }

    func subscribe() -> AsyncStream<Element> {
        let pair = AsyncStream.makeStream(
            of: Element.self,
            bufferingPolicy: bufferingPolicy
        )
        let subscriptionID = UUID()
        pair.continuation.onTermination = { [weak self] _ in
            self?.remove(subscriptionID)
        }

        let update = lock.withLock { () -> SubscriptionUpdate in
            guard !state.isFinished else {
                return SubscriptionUpdate(isFinished: true, shouldStart: false, previous: nil)
            }
            let previous = state.subscription?.continuation
            state.subscription = Subscription(
                id: subscriptionID,
                continuation: pair.continuation
            )
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
        update.previous?.finish()
        if update.isFinished {
            pair.continuation.finish()
        } else if update.shouldStart {
            startSourcePump()
        }
        return pair.stream
    }

    private func startSourcePump() {
        let task = Task { [weak self, source] in
            for await element in source {
                guard !Task.isCancelled else { break }
                self?.publish(element)
            }
            self?.finish()
        }
        lock.withLock {
            sourceTask = task
        }
    }

    private func publish(_ element: Element) {
        guard let subscription = lock.withLock({ state.subscription }) else { return }
        if case .terminated = subscription.continuation.yield(element) {
            remove(subscription.id)
        }
    }

    private func remove(_ subscriptionID: UUID) {
        lock.withLock {
            guard state.subscription?.id == subscriptionID else { return }
            state.subscription = nil
        }
    }

    private func finish() {
        let continuation = lock.withLock {
            guard !state.isFinished else { return nil as Continuation? }
            state.isFinished = true
            let continuation = state.subscription?.continuation
            state.subscription = nil
            return continuation
        }
        continuation?.finish()
    }
}

public extension AsyncStream {
    static var finished: AsyncStream<Element> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }
}
