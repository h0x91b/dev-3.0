import Dev3Kit
import Foundation

public enum ReadinessTierKind: Equatable, Sendable {
    case needsYou
    case custom
    case waiting
}

public struct ReadinessTier: Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ReadinessTierKind
    public let title: String
    public let projectId: String?
    public let customColumnId: String?
    public let color: String?
    public let tasks: [Dev3Task]

    public init(
        id: String,
        kind: ReadinessTierKind,
        title: String,
        projectId: String? = nil,
        customColumnId: String? = nil,
        color: String? = nil,
        tasks: [Dev3Task]
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.projectId = projectId
        self.customColumnId = customColumnId
        self.color = color
        self.tasks = tasks
    }
}

public enum TaskReadiness {
    private static let needsYouStatuses: Set<Dev3TaskStatus> = [
        .userQuestions,
        .reviewByUser,
        .reviewByColleague
    ]

    private static let waitingStatuses: Set<Dev3TaskStatus> = [
        .inProgress,
        .reviewByAI
    ]

    public static func needsUser(_ task: Dev3Task) -> Bool {
        task.customColumnId == nil && needsYouStatuses.contains(task.status)
    }

    public static func isActive(_ task: Dev3Task) -> Bool {
        task.customColumnId != nil ||
            needsYouStatuses.contains(task.status) ||
            waitingStatuses.contains(task.status)
    }

    public static func tiers(tasks: [Dev3Task], projects: [Dev3Project]) -> [ReadinessTier] {
        var needsYou: [Dev3Task] = []
        var waiting: [Dev3Task] = []
        var customTasks: [String: [Dev3Task]] = [:]

        for task in tasks {
            if let customColumnId = task.customColumnId {
                let key = customKey(projectId: task.projectId, columnId: customColumnId)
                customTasks[key, default: []].append(task)
            } else if needsYouStatuses.contains(task.status) {
                needsYou.append(task)
            } else if waitingStatuses.contains(task.status) {
                waiting.append(task)
            }
        }

        var result: [ReadinessTier] = []
        if !needsYou.isEmpty {
            result.append(ReadinessTier(
                id: "needs-you",
                kind: .needsYou,
                title: "Needs you",
                tasks: needsYou.sorted(by: TaskOrdering.readinessPrecedes)
            ))
        }

        for project in projects {
            for column in orderedCustomColumns(project) {
                let key = customKey(projectId: project.id, columnId: column.id)
                guard let tasks = customTasks[key], !tasks.isEmpty else { continue }
                result.append(ReadinessTier(
                    id: "custom:\(key)",
                    kind: .custom,
                    title: column.name,
                    projectId: project.id,
                    customColumnId: column.id,
                    color: column.color,
                    tasks: tasks.sorted(by: TaskOrdering.readinessPrecedes)
                ))
            }
        }

        if !waiting.isEmpty {
            result.append(ReadinessTier(
                id: "waiting",
                kind: .waiting,
                title: "Waiting",
                tasks: waiting.sorted(by: TaskOrdering.readinessPrecedes)
            ))
        }
        return result
    }

    static func orderedCustomColumns(_ project: Dev3Project) -> [Dev3CustomColumn] {
        let columns = project.customColumns ?? []
        guard let order = project.columnOrder, !order.isEmpty else { return columns }

        let columnsByID = Dictionary(uniqueKeysWithValues: columns.map { ($0.id, $0) })
        var used = Set<String>()
        var result: [Dev3CustomColumn] = []
        for id in order {
            guard let column = columnsByID[id], used.insert(id).inserted else { continue }
            result.append(column)
        }
        result.append(contentsOf: columns.filter { used.insert($0.id).inserted })
        return result
    }

    private static func customKey(projectId: String, columnId: String) -> String {
        "\(projectId)|\(columnId)"
    }
}
