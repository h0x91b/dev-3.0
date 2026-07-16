@testable import Dev3TerminalKit
import Foundation
import Testing

@Test("PTY chunks drain in order across display frames")
func frameBackpressureOrder() async {
    let buffer = Dev3TerminalFrameBuffer()
    #expect(await buffer.append(Data("hello ".utf8)))
    let secondAppend = Task {
        await buffer.append(Data("world".utf8))
    }

    #expect(await buffer.drainFrame() == Data("hello ".utf8))
    #expect(await secondAppend.value)
    #expect(await buffer.drainFrame() == Data("world".utf8))
    #expect(await buffer.drainFrame() == nil)
    #expect(
        await buffer.statistics() == Dev3TerminalFrameStatistics(
            receivedChunks: 2,
            receivedBytes: 11,
            renderedFrames: 2,
            renderedBytes: 11
        )
    )
}

@Test("Flood output backpressures after one pending frame", .timeLimit(.minutes(1)))
func floodBenchmark() async {
    let buffer = Dev3TerminalFrameBuffer()
    let chunk = Data("0123456789abcdef".utf8)
    let chunkCount = 10000
    let producer = Task {
        for _ in 0 ..< chunkCount {
            guard await buffer.append(chunk) else { return }
        }
    }

    await eventuallyFrameBuffer("The producer should fill one frame and suspend") {
        await buffer.statistics().receivedChunks == 1
    }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await buffer.statistics().receivedChunks == 1)

    #expect(await buffer.drainFrame() == chunk)
    await eventuallyFrameBuffer("Draining should admit exactly one waiting chunk") {
        await buffer.statistics().receivedChunks == 2
    }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await buffer.statistics().receivedChunks == 2)

    producer.cancel()
    await producer.value
    #expect(await buffer.drainFrame() == chunk)
}

private func eventuallyFrameBuffer(
    _ failureMessage: String,
    condition: () async -> Bool
) async {
    for _ in 0 ..< 100 {
        if await condition() {
            return
        }
        try? await Task.sleep(for: .milliseconds(10))
    }
    Issue.record(Comment(rawValue: failureMessage))
}
