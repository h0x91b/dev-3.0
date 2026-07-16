@testable import Dev3TerminalKit
import Foundation
import Testing

@Test("PTY chunks coalesce into one display frame")
func frameCoalescing() async {
    let buffer = Dev3TerminalFrameBuffer()
    await buffer.append(Data("hello ".utf8))
    await buffer.append(Data("world".utf8))

    let frame = await buffer.drainFrame()
    #expect(frame == Data("hello world".utf8))
    #expect(await buffer.drainFrame() == nil)
    #expect(
        await buffer.statistics() == Dev3TerminalFrameStatistics(
            receivedChunks: 2,
            receivedBytes: 11,
            renderedFrames: 1,
            renderedBytes: 11
        )
    )
}

@Test("Flood output remains one ordered frame", .timeLimit(.minutes(1)))
func floodBenchmark() async {
    let buffer = Dev3TerminalFrameBuffer()
    let chunk = Data("0123456789abcdef".utf8)
    let chunkCount = 10000
    let clock = ContinuousClock()
    let start = clock.now

    for _ in 0 ..< chunkCount {
        await buffer.append(chunk)
    }
    let frame = await buffer.drainFrame()
    let elapsed = start.duration(to: clock.now)
    let statistics = await buffer.statistics()

    #expect(frame?.count == chunk.count * chunkCount)
    #expect(statistics.receivedChunks == chunkCount)
    #expect(statistics.renderedFrames == 1)
    #expect(statistics.coalescingRatio == Double(chunkCount))
    #expect(elapsed < .seconds(5))
}
