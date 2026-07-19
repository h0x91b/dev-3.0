import Dev3Kit
import Foundation

public enum TaskDropPosition: String, Equatable, Sendable {
    case top
    case bottom
}

enum TaskOrdering {
    static func priorityRank(_ priority: Dev3TaskPriority?) -> Int {
        switch priority ?? .p3 {
        case .p0:
            0
        case .p1:
            1
        case .p2:
            2
        case .p3:
            3
        case .p4:
            4
        }
    }

    /// Parsing strategies are value types reused across every comparison:
    /// the previous per-call ISO8601DateFormatter construction copied ICU
    /// locale tables inside O(n log n) sort comparators and blocked the main
    /// thread long enough to trip the iOS scene-update watchdog on large
    /// boards — and its default options rejected the fractional seconds the
    /// desktop always emits, so it never parsed anything (decision 149).
    private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let isoPlain = Date.ISO8601FormatStyle()

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return (try? isoFractional.parse(value)) ?? (try? isoPlain.parse(value))
    }

    static func readinessPrecedes(_ lhs: Dev3Task, _ rhs: Dev3Task) -> Bool {
        let lhsPriority = priorityRank(lhs.priority)
        let rhsPriority = priorityRank(rhs.priority)
        if lhsPriority != rhsPriority {
            return lhsPriority < rhsPriority
        }

        let lhsMovedAt = date(lhs.movedAt)
        let rhsMovedAt = date(rhs.movedAt)
        switch (lhsMovedAt, rhsMovedAt) {
        case let (lhs?, rhs?) where lhs != rhs:
            return lhs < rhs
        case (.some, .none):
            return true
        case (.none, .some):
            return false
        default:
            if lhs.seq != rhs.seq {
                return lhs.seq < rhs.seq
            }
            return lhs.id < rhs.id
        }
    }

    static func terminalRecencyPrecedes(_ lhs: Dev3Task, _ rhs: Dev3Task) -> Bool {
        let lhsDate = date(lhs.movedAt) ?? date(lhs.createdAt) ?? .distantPast
        let rhsDate = date(rhs.movedAt) ?? date(rhs.createdAt) ?? .distantPast
        if lhsDate != rhsDate {
            return lhsDate > rhsDate
        }
        return lhs.id < rhs.id
    }

    static func boardPrecedes(
        _ lhs: Dev3Task,
        _ rhs: Dev3Task,
        dropPosition: TaskDropPosition
    ) -> Bool {
        let lhsPriority = priorityRank(lhs.priority)
        let rhsPriority = priorityRank(rhs.priority)
        if lhsPriority != rhsPriority {
            return lhsPriority < rhsPriority
        }
        if let result = explicitColumnOrder(lhs, rhs) {
            return result
        }
        if let result = variantGroupOrder(lhs, rhs) {
            return result
        }
        return movedAtOrder(lhs, rhs, dropPosition: dropPosition)
    }

    private static func explicitColumnOrder(_ lhs: Dev3Task, _ rhs: Dev3Task) -> Bool? {
        switch (lhs.columnOrder, rhs.columnOrder) {
        case let (lhs?, rhs?) where lhs != rhs:
            lhs < rhs
        case (.some, .none):
            true
        case (.none, .some):
            false
        default:
            nil
        }
    }

    private static func variantGroupOrder(_ lhs: Dev3Task, _ rhs: Dev3Task) -> Bool? {
        let lhsGroup = lhs.groupId ?? ""
        let rhsGroup = rhs.groupId ?? ""
        guard lhsGroup != rhsGroup else {
            guard !lhsGroup.isEmpty, lhs.variantIndex != rhs.variantIndex else { return nil }
            return (lhs.variantIndex ?? 0) < (rhs.variantIndex ?? 0)
        }
        if lhsGroup.isEmpty {
            return false
        }
        if rhsGroup.isEmpty {
            return true
        }
        return lhsGroup < rhsGroup
    }

    private static func movedAtOrder(
        _ lhs: Dev3Task,
        _ rhs: Dev3Task,
        dropPosition: TaskDropPosition
    ) -> Bool {
        let lhsMovedAt = date(lhs.movedAt)
        let rhsMovedAt = date(rhs.movedAt)
        switch (lhsMovedAt, rhsMovedAt) {
        case let (lhs?, rhs?) where lhs != rhs:
            return dropPosition == .top ? lhs > rhs : lhs < rhs
        case (.some, .none):
            return dropPosition == .top
        case (.none, .some):
            return dropPosition == .bottom
        default:
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt < rhs.createdAt
            }
            return lhs.id < rhs.id
        }
    }
}
