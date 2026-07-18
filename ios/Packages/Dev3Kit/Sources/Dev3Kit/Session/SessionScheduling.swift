import Foundation

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
