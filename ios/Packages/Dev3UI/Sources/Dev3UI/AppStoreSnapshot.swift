import Dev3Kit
import Foundation

struct AppStoreSnapshot: Equatable, Sendable {
    var projects: [Dev3Project] = []
    var tasksByProject: [String: [Dev3Task]] = [:]
    var prStatusByTask: [String: TaskPRStatusPush] = [:]
    var clipboardByTask: [String: OSC52ClipboardPush] = [:]
    var attentionByTask: [String: String] = [:]

    mutating func replace(
        projects: [Dev3Project],
        projectTasks: [Dev3ProjectTasks],
        preservingProjectIDs: Set<String> = []
    ) {
        self.projects = projects
            .filter { $0.deleted != true }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let preserved = tasksByProject.filter { preservingProjectIDs.contains($0.key) }
        tasksByProject = Dictionary(uniqueKeysWithValues: projectTasks.map { projectTasks in
            (projectTasks.projectId, Self.sorted(projectTasks.tasks))
        })
        tasksByProject.merge(preserved) { _, preservedTasks in preservedTasks }
    }

    mutating func replaceTasks(_ tasks: [Dev3Task], projectId: String) {
        tasksByProject[projectId] = Self.sorted(tasks)
    }

    mutating func upsert(_ task: Dev3Task, projectId: String) {
        var tasks = tasksByProject[projectId] ?? []
        tasks.removeAll { $0.id == task.id }
        tasks.append(task)
        tasksByProject[projectId] = Self.sorted(tasks)
    }

    mutating func removeTask(taskId: String, projectId: String) {
        tasksByProject[projectId]?.removeAll { $0.id == taskId }
        prStatusByTask[taskId] = nil
        clipboardByTask[taskId] = nil
        attentionByTask[taskId] = nil
    }

    mutating func reduce(_ push: RPCPushEvent) -> AppToast? {
        switch push {
        case let .taskUpdated(update):
            upsert(update.task, projectId: update.projectId)
        case let .taskRemoved(removal):
            removeTask(taskId: removal.taskId, projectId: removal.projectId)
        case let .taskPreparationFailed(failure):
            return AppToast(message: "Task preparation failed: \(failure.error)", level: .error)
        case let .projectUpdated(update):
            reduceProjectUpdate(update)
        case let .taskPRStatus(status):
            prStatusByTask[status.taskId] = status
        case let .osc52Clipboard(clipboard):
            clipboardByTask[clipboard.taskId] = clipboard
        case let .cliAttention(attention):
            attentionByTask[attention.taskId] = attention.reason
        case let .cliToast(toast):
            return AppToast(message: toast.message, level: toast.level)
        case let .webNotification(notification):
            let message = notification.body.isEmpty ? notification.title : notification.body
            return AppToast(message: message, level: notification.level)
        default:
            break
        }
        return nil
    }

    private mutating func reduceProjectUpdate(_ update: ProjectUpdatedPush) {
        projects.removeAll { $0.id == update.project.id }
        if update.project.deleted != true {
            projects.append(update.project)
            projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } else {
            let taskIDs = Set(tasksByProject.removeValue(forKey: update.project.id)?.map(\.id) ?? [])
            prStatusByTask = prStatusByTask.filter { !taskIDs.contains($0.key) }
            clipboardByTask = clipboardByTask.filter { !taskIDs.contains($0.key) }
            attentionByTask = attentionByTask.filter { !taskIDs.contains($0.key) }
        }
    }

    private static func sorted(_ tasks: [Dev3Task]) -> [Dev3Task] {
        tasks.sorted { lhs, rhs in
            lhs.seq == rhs.seq ? lhs.id < rhs.id : lhs.seq < rhs.seq
        }
    }
}
