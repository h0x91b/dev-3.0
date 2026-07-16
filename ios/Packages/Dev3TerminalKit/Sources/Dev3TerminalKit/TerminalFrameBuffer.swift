import Foundation

public struct Dev3TerminalFrameStatistics: Equatable, Sendable {
    public let receivedChunks: Int
    public let receivedBytes: Int
    public let renderedFrames: Int
    public let renderedBytes: Int

    public var coalescingRatio: Double {
        guard renderedFrames > 0 else { return 0 }
        return Double(receivedChunks) / Double(renderedFrames)
    }
}

public actor Dev3TerminalFrameBuffer {
    private var pending = Data()
    private var receivedChunks = 0
    private var receivedBytes = 0
    private var renderedFrames = 0
    private var renderedBytes = 0

    public init() {}

    public func append(_ data: Data) {
        guard !data.isEmpty else { return }
        pending.append(data)
        receivedChunks += 1
        receivedBytes += data.count
    }

    public func drainFrame() -> Data? {
        guard !pending.isEmpty else { return nil }
        let frame = pending
        pending.removeAll(keepingCapacity: true)
        renderedFrames += 1
        renderedBytes += frame.count
        return frame
    }

    public func statistics() -> Dev3TerminalFrameStatistics {
        Dev3TerminalFrameStatistics(
            receivedChunks: receivedChunks,
            receivedBytes: receivedBytes,
            renderedFrames: renderedFrames,
            renderedBytes: renderedBytes
        )
    }
}
