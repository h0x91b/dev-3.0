@testable import Dev3TerminalKit
import Foundation
import Testing

struct TerminalScrollTests {
    @Test("Wheel-up and wheel-down emit the SGR 1006 sequence tmux reads")
    func wheelSequence() {
        #expect(Dev3TerminalWheelScroll.sequence(up: true, col: 3, row: 5) == Array("\u{1b}[<64;3;5M".utf8))
        #expect(Dev3TerminalWheelScroll.sequence(up: false, col: 3, row: 5) == Array("\u{1b}[<65;3;5M".utf8))
    }

    @Test("Wheel sequence clamps column and row to at least 1")
    func wheelClamps() {
        #expect(Dev3TerminalWheelScroll.sequence(up: true, col: 0, row: -4) == Array("\u{1b}[<64;1;1M".utf8))
    }

    @Test("Accumulator emits one tick per step and carries the remainder")
    func accumulatorSteps() {
        var accumulator = Dev3TerminalScrollAccumulator(step: 10)
        #expect(accumulator.consume(deltaY: 6) == 0)
        #expect(accumulator.consume(deltaY: 6) == 1)
        #expect(accumulator.consume(deltaY: 25) == 2)
    }

    @Test("Downward drag is wheel-up (positive); upward drag is wheel-down (negative)")
    func accumulatorDirection() {
        var accumulator = Dev3TerminalScrollAccumulator(step: 10)
        #expect(accumulator.consume(deltaY: 30) == 3)
        accumulator.reset()
        #expect(accumulator.consume(deltaY: -30) == -3)
    }

    @Test("Reset drops the accumulated remainder")
    func accumulatorReset() {
        var accumulator = Dev3TerminalScrollAccumulator(step: 10)
        _ = accumulator.consume(deltaY: 8)
        accumulator.reset()
        #expect(accumulator.consume(deltaY: 3) == 0)
    }
}
