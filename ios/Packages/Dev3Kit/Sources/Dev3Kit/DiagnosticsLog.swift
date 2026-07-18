import Foundation

/// A single diagnostics line. Free of secrets by construction — callers log
/// hosts, paths, statuses, and FSM transitions, never tokens or cookies.
public struct DiagnosticEntry: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let timestamp: Date
    public let category: String
    public let message: String

    public init(id: UUID = UUID(), timestamp: Date, category: String, message: String) {
        self.id = id
        self.timestamp = timestamp
        self.category = category
        self.message = message
    }

    public func formatted(using formatter: ISO8601DateFormatter) -> String {
        "\(formatter.string(from: timestamp)) [\(category)] \(message)"
    }
}

/// In-memory, thread-safe ring buffer of recent diagnostics. Stays entirely on
/// the device; the user exports it explicitly from the Diagnostics screen. It
/// exists so an opaque pairing/connection failure (which otherwise shows only a
/// spinner) leaves a readable trail. Never record a session token, QR token, or
/// cookie value here — log the origin host, path, HTTP status, and FSM state.
public final class DiagnosticsLog: @unchecked Sendable {
    public static let shared = DiagnosticsLog()

    private let lock = NSLock()
    private var storage: [DiagnosticEntry] = []
    private let capacity: Int
    private let clock: @Sendable () -> Date

    public init(capacity: Int = 500, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.capacity = capacity
        self.clock = clock
    }

    public func record(category: String, _ message: String) {
        let entry = DiagnosticEntry(timestamp: clock(), category: category, message: message)
        lock.withLock {
            storage.append(entry)
            if storage.count > capacity {
                storage.removeFirst(storage.count - capacity)
            }
        }
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
