import Foundation

final class Dev3TerminalStreamRelay<Element: Sendable>: @unchecked Sendable {
    private typealias Continuation = AsyncStream<Element>.Continuation

    private enum Replay {
        case none
        case value(Element)
    }

    private struct Subscription {
        let id: UUID
        let continuation: Continuation
    }

    private struct State {
        var subscription: Subscription?
        var hasStarted = false
        var isFinished = false
        var latest: Replay = .none
    }

    private struct SubscriptionUpdate {
        let isFinished: Bool
        let shouldStart: Bool
        let previous: Continuation?
        let replay: Replay
    }

    private let source: AsyncStream<Element>
    private let bufferingPolicy: Continuation.BufferingPolicy
    private let replaysLatest: Bool
    private let lock = NSLock()
    /// Serializes continuation delivery with lease installation without holding `lock` during
    /// `yield`/`finish`; an `onTermination` callback may safely re-enter `remove`.
    private let deliveryLock = NSLock()
    private var state = State()
    private var sourceTask: Task<Void, Never>?

    init(
        source: AsyncStream<Element>,
        bufferingPolicy: AsyncStream<Element>.Continuation.BufferingPolicy,
        replaysLatest: Bool
    ) {
        self.source = source
        self.bufferingPolicy = bufferingPolicy
        self.replaysLatest = replaysLatest
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

        let update = install(
            subscriptionID: subscriptionID,
            continuation: pair.continuation
        )
        update.previous?.finish()
        if update.isFinished {
            pair.continuation.finish()
        } else if update.shouldStart {
            startSourcePump()
        }
        return pair.stream
    }

    private func install(
        subscriptionID: UUID,
        continuation: Continuation
    ) -> SubscriptionUpdate {
        deliveryLock.withLock {
            let update = lock.withLock { () -> SubscriptionUpdate in
                let replay = replaysLatest ? state.latest : .none
                guard !state.isFinished else {
                    return SubscriptionUpdate(
                        isFinished: true,
                        shouldStart: false,
                        previous: nil,
                        replay: replay
                    )
                }
                let previous = state.subscription?.continuation
                state.subscription = Subscription(
                    id: subscriptionID,
                    continuation: continuation
                )
                let shouldStart = !state.hasStarted
                state.hasStarted = true
                return SubscriptionUpdate(
                    isFinished: false,
                    shouldStart: shouldStart,
                    previous: previous,
                    replay: replay
                )
            }
            if case let .value(element) = update.replay {
                continuation.yield(element)
            }
            return update
        }
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
        deliveryLock.withLock {
            let subscription = lock.withLock { () -> Subscription? in
                guard !state.isFinished else { return nil }
                if replaysLatest {
                    state.latest = .value(element)
                }
                return state.subscription
            }
            guard let subscription else { return }
            if case .terminated = subscription.continuation.yield(element) {
                remove(subscription.id)
            }
        }
    }

    private func remove(_ subscriptionID: UUID) {
        lock.withLock {
            guard state.subscription?.id == subscriptionID else { return }
            state.subscription = nil
        }
    }

    private func finish() {
        deliveryLock.withLock {
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
}
