import Dev3Kit
import Foundation

public struct ProjectDashboardItem: Equatable, Identifiable, Sendable {
    public let project: Dev3Project
    public let activeTaskCount: Int
    public let attentionTaskCount: Int
    public let lastActivity: Date?

    public init(
        project: Dev3Project,
        activeTaskCount: Int,
        attentionTaskCount: Int,
        lastActivity: Date?
    ) {
        self.project = project
        self.activeTaskCount = activeTaskCount
        self.attentionTaskCount = attentionTaskCount
        self.lastActivity = lastActivity
    }

    public var id: String {
        project.id
    }

    public var supportsGitActions: Bool {
        project.kind != .virtual
    }
}

public enum ProjectPullState: Equatable, Sendable {
    case idle
    case pulling
    case succeeded(String)
    case failed(String)
}

public enum ProjectsDashboardProjection {
    public static func items(
        projects: [Dev3Project],
        tasksByProject: [String: [Dev3Task]],
        explicitAttentionTaskIDs: Set<String> = []
    ) -> [ProjectDashboardItem] {
        orderedProjects(projects.filter { $0.deleted != true }).map { project in
            let tasks = tasksByProject[project.id] ?? []
            let activeTasks = tasks.filter(TaskReadiness.isActive)
            let attentionCount = activeTasks.filter {
                TaskReadiness.needsUser($0) || explicitAttentionTaskIDs.contains($0.id)
            }.count
            let lastActivity = tasks.compactMap(taskLastActivity).max()
            return ProjectDashboardItem(
                project: project,
                activeTaskCount: activeTasks.count,
                attentionTaskCount: attentionCount,
                lastActivity: lastActivity
            )
        }
    }

    private static func orderedProjects(_ projects: [Dev3Project]) -> [Dev3Project] {
        let builtinOperations = projects.filter { $0.kind == .virtual && $0.builtin == true }
        guard !builtinOperations.isEmpty else { return projects }
        return builtinOperations + projects.filter { !($0.kind == .virtual && $0.builtin == true) }
    }

    private static func taskLastActivity(_ task: Dev3Task) -> Date? {
        [task.updatedAt, task.movedAt, task.createdAt]
            .compactMap(TaskOrdering.date)
            .max()
    }
}
