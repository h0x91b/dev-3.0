import Foundation

/// Severity of a diagnostics line. `info` is the always-on default that records
/// hosts, paths, statuses, and FSM transitions. `debug` is the opt-in verbose
/// tier (gestures, low-level tracing) that is dropped unless the user enables
/// "Verbose logging" in Settings — keeping the default log readable and small.
public enum DiagnosticLevel: String, Sendable, CaseIterable, Comparable {
    case info
    case debug

    private var severityRank: Int {
        switch self {
        case .info:
            0
        case .debug:
            1
        }
    }

    public static func < (lhs: DiagnosticLevel, rhs: DiagnosticLevel) -> Bool {
        lhs.severityRank < rhs.severityRank
    }
}

/// A single diagnostics line. Free of secrets by construction — callers log
/// hosts, paths, statuses, and FSM transitions, never tokens or cookies.
public struct DiagnosticEntry: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let timestamp: Date
    public let category: String
    public let level: DiagnosticLevel
    public let message: String

    public init(
        id: UUID = UUID(),
        timestamp: Date,
        category: String,
        level: DiagnosticLevel = .info,
        message: String
    ) {
        self.id = id
        self.timestamp = timestamp
        self.category = category
        self.level = level
        self.message = message
    }

    public func formatted(using formatter: ISO8601DateFormatter) -> String {
        let prefix = "\(formatter.string(from: timestamp)) [\(category)]"
        switch level {
        case .info:
            return "\(prefix) \(message)"
        case .debug:
            return "\(prefix) (debug) \(message)"
        }
    }
}

/// In-memory, thread-safe ring buffer of recent diagnostics. Stays entirely on
/// the device; the user exports it explicitly from the Diagnostics screen. It
/// exists so an opaque pairing/connection failure (which otherwise shows only a
/// spinner) leaves a readable trail. Never record a session token, QR token, or
/// cookie value here — log the origin host, path, HTTP status, and FSM state.
///
/// Levels: `record(category:_:)` logs at `.info` and is always kept. Callers can
/// opt into `.debug` (via `record(category:level:_:)` or `debug(category:_:)`)
/// for high-volume tracing; those entries are only retained while verbose
/// logging is enabled, so the info-level trail stays legible by default.
public final class DiagnosticsLog: @unchecked Sendable {
    public static let shared = DiagnosticsLog()

    private let lock = NSLock()
    private var storage: [DiagnosticEntry] = []
    private var verboseEnabled: Bool
    private let capacity: Int
    private let clock: @Sendable () -> Date

    public init(
        capacity: Int = 500,
        verboseEnabled: Bool = false,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.capacity = capacity
        self.verboseEnabled = verboseEnabled
        self.clock = clock
    }

    /// Whether `.debug` entries are currently retained. Persisted by the app's
    /// "Verbose logging" Settings toggle and applied at launch.
    public var isVerboseEnabled: Bool {
        lock.withLock { verboseEnabled }
    }

    public func setVerboseEnabled(_ enabled: Bool) {
        lock.withLock { verboseEnabled = enabled }
    }

    /// Records a line. `.debug` lines are dropped unless verbose logging is on;
    /// the default level keeps every existing call site at `.info`.
    public func record(category: String, level: DiagnosticLevel = .info, _ message: String) {
        let entry = DiagnosticEntry(
            timestamp: clock(),
            category: category,
            level: level,
            message: message
        )
        lock.withLock {
            if level == .debug, !verboseEnabled {
                return
            }
            storage.append(entry)
            if storage.count > capacity {
                storage.removeFirst(storage.count - capacity)
            }
        }
    }

    /// Convenience for verbose tracing. No-op unless verbose logging is enabled.
    public func debug(category: String, _ message: String) {
        record(category: category, level: .debug, message)
    }

    /// Snapshot of recorded entries, oldest first.
    public func entries() -> [DiagnosticEntry] {
        lock.withLock { storage }
    }

    public func clear() {
        lock.withLock { storage.removeAll() }
    }

    /// Plain-text dump suitable for sharing. Small (bounded by `capacity`), so
    /// no compression is needed for a mail attachment.
    public func export(header: String = "dev3 iOS diagnostics") -> String {
        let formatter = ISO8601DateFormatter()
        let lines = entries().map { $0.formatted(using: formatter) }
        return ([header, String(repeating: "─", count: 40)] + lines).joined(separator: "\n")
    }
}
