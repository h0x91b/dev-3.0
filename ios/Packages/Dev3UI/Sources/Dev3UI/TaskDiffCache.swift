import Dev3Kit
import Foundation

/// In-memory cache of diff payloads keyed by task + mode + compare parameters.
///
/// Owned *above* diff navigation (one instance per connected session) so that
/// reopening a task's diff — whether from the review flow or Task Info →
/// "Changes" — renders the last-seen result instantly while a fresh copy loads
/// in the background (stale-while-revalidate). It is deliberately not persisted:
/// a relaunch cold-loads, and entries are cleared when the active server changes
/// so one instance's diffs never leak into another.
@MainActor
public final class TaskDiffCache {
    public struct Key: Hashable, Sendable {
        public let serverID: String
        public let projectID: String
        public let taskID: String
        public let mode: Dev3TaskDiffMode
        public let compareRef: String?
        public let count: Int?

        public init(
            serverID: String,
            projectID: String,
            taskID: String,
            mode: Dev3TaskDiffMode,
            compareRef: String?,
            count: Int?
        ) {
            self.serverID = serverID
            self.projectID = projectID
            self.taskID = taskID
            self.mode = mode
            self.compareRef = compareRef
            self.count = count
        }
    }

    private var store: [Key: Dev3TaskDiff] = [:]

    public init() {}

    public func value(for key: Key) -> Dev3TaskDiff? {
        store[key]
    }

    public func set(_ value: Dev3TaskDiff, for key: Key) {
        store[key] = value
    }

    /// Drops every entry for a server. Call when the active server changes so a
    /// stale diff from a previous instance can never render for the new one.
    public func clear(serverID: String) {
        store = store.filter { $0.key.serverID != serverID }
    }

    public func clearAll() {
        store.removeAll()
    }
}
