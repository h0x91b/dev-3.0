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
    private struct PendingAppend {
        let id: UUID
        let data: Data
        let continuation: CheckedContinuation<Bool, Never>
    }

    private var pending = Data()
    private var pendingAppend: PendingAppend?
    private var receivedChunks = 0
    private var receivedBytes = 0
    private var renderedFrames = 0
    private var renderedBytes = 0

    public init() {}

    /// Accepts output from one serial producer. A second chunk waits until the display drains the
    /// first, preventing this frame boundary from becoming another unbounded transport buffer.
    public func append(_ data: Data) async -> Bool {
        guard !data.isEmpty else { return true }
        if pending.isEmpty {
            accept(data)
            return true
        }

        let appendID = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(returning: false)
                    return
                }
                if pending.isEmpty {
                    accept(data)
                    continuation.resume(returning: true)
                    return
                }
                precondition(
                    pendingAppend == nil,
                    "Dev3TerminalFrameBuffer requires one serial producer"
                )
                pendingAppend = PendingAppend(
                    id: appendID,
                    data: data,
                    continuation: continuation
                )
            }
        } onCancel: {
            Task { await self.cancelAppend(appendID) }
        }
    }

    public func drainFrame() -> Data? {
        guard !pending.isEmpty else { return nil }
        let frame = pending
        pending.removeAll(keepingCapacity: false)
        renderedFrames += 1
        renderedBytes += frame.count
        admitPendingAppend()
        return frame
    }

    public func discardPending() {
        pending.removeAll(keepingCapacity: false)
        let append = pendingAppend
        pendingAppend = nil
        append?.continuation.resume(returning: false)
    }

    public func statistics() -> Dev3TerminalFrameStatistics {
        Dev3TerminalFrameStatistics(
            receivedChunks: receivedChunks,
            receivedBytes: receivedBytes,
            renderedFrames: renderedFrames,
            renderedBytes: renderedBytes
        )
    }

    private func accept(_ data: Data) {
        pending = data
        receivedChunks += 1
        receivedBytes += data.count
    }

    private func admitPendingAppend() {
        guard let append = pendingAppend else { return }
        pendingAppend = nil
        accept(append.data)
        append.continuation.resume(returning: true)
    }

    private func cancelAppend(_ appendID: UUID) {
        guard pendingAppend?.id == appendID else { return }
        let append = pendingAppend
        pendingAppend = nil
        append?.continuation.resume(returning: false)
    }
}
