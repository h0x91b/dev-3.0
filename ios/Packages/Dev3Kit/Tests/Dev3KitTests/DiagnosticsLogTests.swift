@testable import Dev3Kit
import Foundation
import Testing

struct DiagnosticsLogTests {
    @Test("Records entries oldest-first")
    func recordsEntries() {
        let log = DiagnosticsLog()
        log.record(category: "a", "first")
        log.record(category: "b", "second")

        let entries = log.entries()
        #expect(entries.map(\.message) == ["first", "second"])
        #expect(entries.last?.category == "b")
    }

    @Test("Trims to capacity, keeping the most recent entries")
    func trimsToCapacity() {
        let log = DiagnosticsLog(capacity: 3)
        for index in 0 ..< 5 {
            log.record(category: "n", "\(index)")
        }

        #expect(log.entries().map(\.message) == ["2", "3", "4"])
    }

    @Test("Export contains recorded messages and clear empties the buffer")
    func exportAndClear() {
        let log = DiagnosticsLog(clock: { Date(timeIntervalSince1970: 0) })
        log.record(category: "http", "GET /instance 404")

        #expect(log.export().contains("GET /instance 404"))

        log.clear()
        #expect(log.entries().isEmpty)
        #expect(!log.export().contains("GET /instance 404"))
    }
}
