public struct TaskInfoConnectionPolicy: Equatable, Sendable {
    public let hasLiveService: Bool

    public init(hasLiveService: Bool) {
        self.hasLiveService = hasLiveService
    }

    public func canMutate(isConnected: Bool) -> Bool {
        hasLiveService && isConnected
    }
}
