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

    @Test("Records default to info level")
    func defaultsToInfo() {
        let log = DiagnosticsLog()
        log.record(category: "a", "plain")

        #expect(log.entries().last?.level == .info)
    }

    @Test("Drops debug entries while verbose logging is disabled")
    func dropsDebugWhenNotVerbose() {
        let log = DiagnosticsLog()
        #expect(log.isVerboseEnabled == false)

        log.record(category: "gesture", level: .debug, "tap")
        log.debug(category: "gesture", "swipe")
        log.record(category: "http", "GET /instance 200")

        #expect(log.entries().map(\.message) == ["GET /instance 200"])
    }

    @Test("Retains debug entries once verbose logging is enabled")
    func retainsDebugWhenVerbose() {
        let log = DiagnosticsLog()
        log.setVerboseEnabled(true)
        #expect(log.isVerboseEnabled)

        log.record(category: "http", "GET /instance 200")
        log.debug(category: "gesture", "swipe left")

        let entries = log.entries()
        #expect(entries.map(\.message) == ["GET /instance 200", "swipe left"])
        #expect(entries.last?.level == .debug)
    }

    @Test("Disabling verbose logging stops retaining new debug entries")
    func togglingVerboseOff() {
        let log = DiagnosticsLog(verboseEnabled: true)
        log.debug(category: "gesture", "kept")
        log.setVerboseEnabled(false)
        log.debug(category: "gesture", "dropped")

        #expect(log.entries().map(\.message) == ["kept"])
    }

    @Test("Debug lines are tagged in the exported dump")
    func exportTagsDebug() {
        let log = DiagnosticsLog(verboseEnabled: true, clock: { Date(timeIntervalSince1970: 0) })
        log.record(category: "http", "GET /instance 200")
        log.debug(category: "gesture", "swipe left")

        let export = log.export()
        #expect(export.contains("[http] GET /instance 200"))
        #expect(export.contains("[gesture] (debug) swipe left"))
    }
}
