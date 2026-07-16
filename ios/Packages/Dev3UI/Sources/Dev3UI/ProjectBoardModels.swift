import Dev3Kit
import Foundation

public enum ProjectBoardColumnKind: Equatable, Sendable {
    case builtin(Dev3TaskStatus)
    case custom(Dev3CustomColumn)
}

public struct ProjectBoardColumn: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let kind: ProjectBoardColumnKind
    public let tasks: [Dev3Task]

    public init(
        id: String,
        title: String,
        kind: ProjectBoardColumnKind,
        tasks: [Dev3Task]
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.tasks = tasks
    }

    public var status: Dev3TaskStatus? {
        guard case let .builtin(status) = kind else { return nil }
        return status
    }
}

public enum ProjectBoardProjection {
    private static let beforeCustom: [Dev3TaskStatus] = [
        .todo,
        .inProgress,
        .userQuestions,
        .reviewByAI,
        .reviewByUser
    ]
    private static let afterCustom: [Dev3TaskStatus] = [
        .reviewByColleague,
        .completed,
        .cancelled
    ]
    private static let allBuiltin = beforeCustom + afterCustom

    public static func columns(
        project: Dev3Project,
        tasks: [Dev3Task],
        dropPosition: TaskDropPosition = .top,
        explicitlyCollapsedColumnIDs: Set<String> = []
    ) -> [ProjectBoardColumn] {
        let customColumns = project.customColumns ?? []
        let customColumnIDs = Set(customColumns.map(\.id))
        let aiReviewHasItems = tasks.contains {
            $0.status == .reviewByAI && !isInCustomColumn($0, validColumnIDs: customColumnIDs)
        }
        let slots = orderedSlots(project: project, aiReviewHasItems: aiReviewHasItems)
            .filter { !explicitlyCollapsedColumnIDs.contains($0.id) }

        return slots.map { slot in
            let slotTasks: [Dev3Task] = switch slot.kind {
            case let .builtin(status):
                tasks.filter {
                    $0.status == status && !isInCustomColumn($0, validColumnIDs: customColumnIDs)
                }
            case let .custom(column):
                tasks.filter { $0.customColumnId == column.id }
            }

            let sortedTasks: [Dev3Task] = if slot.status == .completed || slot.status == .cancelled {
                slotTasks.sorted(by: TaskOrdering.terminalRecencyPrecedes)
            } else {
                slotTasks.sorted {
                    TaskOrdering.boardPrecedes($0, $1, dropPosition: dropPosition)
                }
            }
            return ProjectBoardColumn(
                id: slot.id,
                title: slot.title,
                kind: slot.kind,
                tasks: sortedTasks
            )
        }
    }

    public static func preferredInitialColumnID(_ columns: [ProjectBoardColumn]) -> String? {
        if let questions = columns.first(where: { $0.status == .userQuestions && !$0.tasks.isEmpty }) {
            return questions.id
        }
        if let review = columns.first(where: { $0.status == .reviewByUser && !$0.tasks.isEmpty }) {
            return review.id
        }
        return columns.first?.id
    }

    private struct Slot {
        let id: String
        let title: String
        let kind: ProjectBoardColumnKind

        var status: Dev3TaskStatus? {
            guard case let .builtin(status) = kind else { return nil }
            return status
        }
    }

    // This mirrors the intentionally compatibility-heavy insertion behavior in getBoardColumns.ts.
    // swiftlint:disable:next function_body_length
    private static func orderedSlots(project: Dev3Project, aiReviewHasItems: Bool) -> [Slot] {
        let customColumns = project.customColumns ?? []
        let customByID = Dictionary(uniqueKeysWithValues: customColumns.map { ($0.id, $0) })

        func shouldHide(_ status: Dev3TaskStatus) -> Bool {
            let isVirtual = project.kind == .virtual
            if isVirtual, status == .reviewByAI || status == .reviewByColleague {
                return true
            }
            if status == .reviewByColleague, project.peerReviewEnabled == false {
                return true
            }
            let aiReviewEnabled = project.builtinColumnAgents == nil ||
                project.builtinColumnAgents?[Dev3TaskStatus.reviewByAI.rawValue] != nil
            return status == .reviewByAI && !aiReviewEnabled && !aiReviewHasItems
        }

        func builtinSlot(_ status: Dev3TaskStatus) -> Slot {
            Slot(
                id: status.rawValue,
                title: project.customStatusLabels?[status.rawValue] ?? status.displayName,
                kind: .builtin(status)
            )
        }

        func customSlot(_ column: Dev3CustomColumn) -> Slot {
            Slot(id: column.id, title: column.name, kind: .custom(column))
        }

        guard let order = project.columnOrder, !order.isEmpty else {
            return beforeCustom.filter { !shouldHide($0) }.map(builtinSlot) +
                customColumns.map(customSlot) +
                afterCustom.filter { !shouldHide($0) }.map(builtinSlot)
        }

        let builtinByID = Dictionary(uniqueKeysWithValues: allBuiltin.map { ($0.rawValue, $0) })
        var result: [Slot] = []
        var used = Set<String>()
        for id in order {
            if let status = builtinByID[id] {
                used.insert(id)
                if !shouldHide(status) {
                    result.append(builtinSlot(status))
                }
            } else if let column = customByID[id], used.insert(id).inserted {
                result.append(customSlot(column))
            }
        }

        insertMissing(
            .reviewByAI,
            before: .reviewByUser,
            shouldHide: shouldHide,
            used: &used,
            result: &result,
            slot: builtinSlot
        )
        insertMissing(
            .reviewByColleague,
            before: .completed,
            shouldHide: shouldHide,
            used: &used,
            result: &result,
            slot: builtinSlot
        )

        for status in allBuiltin where !used.contains(status.rawValue) && !shouldHide(status) {
            result.append(builtinSlot(status))
            used.insert(status.rawValue)
        }
        for column in customColumns where used.insert(column.id).inserted {
            result.append(customSlot(column))
        }
        return result
    }

    // swiftlint:disable:next function_parameter_count
    private static func insertMissing(
        _ status: Dev3TaskStatus,
        before nextStatus: Dev3TaskStatus,
        shouldHide: (Dev3TaskStatus) -> Bool,
        used: inout Set<String>,
        result: inout [Slot],
        slot: (Dev3TaskStatus) -> Slot
    ) {
        guard !used.contains(status.rawValue), !shouldHide(status) else { return }
        let insertionIndex = result.firstIndex { $0.status == nextStatus } ?? result.endIndex
        result.insert(slot(status), at: insertionIndex)
        used.insert(status.rawValue)
    }

    private static func isInCustomColumn(_ task: Dev3Task, validColumnIDs: Set<String>) -> Bool {
        guard let customColumnId = task.customColumnId else { return false }
        return validColumnIDs.contains(customColumnId)
    }
}

public extension Dev3TaskStatus {
    var displayName: String {
        switch self {
        case .todo:
            "To do"
        case .inProgress:
            "In progress"
        case .userQuestions:
            "Has questions"
        case .reviewByAI:
            "AI review"
        case .reviewByUser:
            "Your review"
        case .reviewByColleague:
            "PR review"
        case .completed:
            "Completed"
        case .cancelled:
            "Cancelled"
        }
    }
}
