import Dev3Kit
import Foundation
import Observation

public protocol TaskInfoServicing: Sendable {
    func renameTask(taskID: String, projectID: String, customTitle: String?) async throws -> Dev3Task
    func moveTask(
        taskID: String,
        projectID: String,
        status: Dev3TaskStatus,
        force: Bool
    ) async throws -> Dev3Task
    func moveTaskToCustomColumn(
        taskID: String,
        projectID: String,
        customColumnID: String
    ) async throws -> Dev3Task
    func setPriority(
        taskID: String,
        projectID: String,
        priority: Dev3TaskPriority
    ) async throws -> [Dev3Task]
    func setWatched(taskID: String, projectID: String, watched: Bool) async throws -> Dev3Task
    func setLabels(taskID: String, projectID: String, labelIDs: [String]) async throws -> Dev3Task
    func setUserOverview(taskID: String, projectID: String, overview: String) async throws -> Dev3Task
    func addNote(taskID: String, projectID: String, content: String) async throws -> Dev3Task
    func updateNote(
        taskID: String,
        projectID: String,
        noteID: String,
        content: String
    ) async throws -> Dev3Task
    func deleteNote(taskID: String, projectID: String, noteID: String) async throws -> Dev3Task
    func deleteTask(taskID: String, projectID: String) async throws
    func branchStatus(taskID: String, projectID: String) async throws -> Dev3BranchStatus
    func refreshPRStatus(taskID: String, projectID: String) async throws
}

@MainActor
@Observable
public final class TaskInfoStore {
    public private(set) var task: Dev3Task
    public private(set) var project: Dev3Project
    public private(set) var pushedPRStatus: TaskPRStatusPush?
    public private(set) var branchStatus: Dev3BranchStatus?
    public private(set) var isConnected: Bool
    public private(set) var isMutating = false
    public private(set) var isRefreshingBranch = false
    public private(set) var isRefreshingPR = false
    public private(set) var isDeleted = false
    public private(set) var errorMessage: String?
    public private(set) var pendingConfirmation: TaskInfoConfirmation?

    public var titleDraft: String
    public var userOverviewDraft: String

    private let service: any TaskInfoServicing
    private let onTaskChanged: @MainActor (Dev3Task) -> Void
    private let onTasksChanged: @MainActor ([Dev3Task]) -> Void
    private let onDeleted: @MainActor (String) -> Void

    public init(
        task: Dev3Task,
        project: Dev3Project,
        service: any TaskInfoServicing,
        isConnected: Bool,
        pushedPRStatus: TaskPRStatusPush? = nil,
        onTaskChanged: @escaping @MainActor (Dev3Task) -> Void = { _ in },
        onTasksChanged: @escaping @MainActor ([Dev3Task]) -> Void = { _ in },
        onDeleted: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.task = task
        self.project = project
        self.service = service
        self.isConnected = isConnected
        self.pushedPRStatus = pushedPRStatus
        self.onTaskChanged = onTaskChanged
        self.onTasksChanged = onTasksChanged
        self.onDeleted = onDeleted
        titleDraft = task.displayTitle
        userOverviewDraft = task.userOverview ?? ""
    }

    public var canMutate: Bool {
        isConnected && !isMutating && !isDeleted
    }

    public var hasDraftChanges: Bool {
        titleDraft.trimmingCharacters(in: .whitespacesAndNewlines) != task.displayTitle ||
            userOverviewDraft.trimmingCharacters(in: .whitespacesAndNewlines) != (task.userOverview ?? "")
    }

    public var destinations: [TaskInfoDestination] {
        let statuses: [Dev3TaskStatus] = if task.status == .todo {
            [.inProgress, .completed, .cancelled]
        } else {
            Dev3TaskStatus.allCases.filter { $0 != task.status }
        }
        let builtin = statuses.map(TaskInfoDestination.status)
        let custom: [TaskInfoDestination] = (project.customColumns ?? []).compactMap { column in
            guard column.id != task.customColumnId else { return nil }
            return TaskInfoDestination.customColumn(id: column.id, name: column.name)
        }
        return builtin + custom
    }

    public func setConnected(_ connected: Bool) {
        isConnected = connected
    }

    public func replace(task updatedTask: Dev3Task, project updatedProject: Dev3Project? = nil) {
        guard updatedTask.id == task.id else { return }
        let titleWasClean = titleDraft == task.displayTitle
        let overviewWasClean = userOverviewDraft == (task.userOverview ?? "")
        task = updatedTask
        if let updatedProject {
            project = updatedProject
        }
        if titleWasClean {
            titleDraft = updatedTask.displayTitle
        }
        if overviewWasClean {
            userOverviewDraft = updatedTask.userOverview ?? ""
        }
    }

    /// AppStore remains the only RPC stream consumer and fans relevant events into this reducer.
    public func receive(_ push: RPCPushEvent) {
        switch push {
        case let .taskUpdated(update) where update.task.id == task.id:
            replace(task: update.task)
        case let .projectUpdated(update) where update.project.id == project.id:
            project = update.project
        case let .taskPRStatus(status) where status.taskId == task.id:
            pushedPRStatus = status
        case let .taskRemoved(removal) where removal.taskId == task.id:
            isDeleted = true
            onDeleted(task.id)
        default:
            break
        }
    }

    public func saveDrafts() async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            let trimmedTitle = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedTitle != task.displayTitle {
                let renamed = try await service.renameTask(
                    taskID: task.id,
                    projectID: project.id,
                    customTitle: trimmedTitle.isEmpty ? nil : trimmedTitle
                )
                apply(renamed)
            }

            let trimmedOverview = userOverviewDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedOverview != (task.userOverview ?? "") {
                let updated = try await service.setUserOverview(
                    taskID: task.id,
                    projectID: project.id,
                    overview: trimmedOverview
                )
                apply(updated)
            }
        } catch {
            report(error, operation: "save task details")
        }
    }

    public func resetTitle() async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            let updated = try await service.renameTask(
                taskID: task.id,
                projectID: project.id,
                customTitle: nil
            )
            apply(updated)
            titleDraft = updated.displayTitle
        } catch {
            report(error, operation: "reset the task title")
        }
    }

    public func requestMove(to destination: TaskInfoDestination) async {
        guard canMutate else { return }
        switch destination {
        case let .status(status):
            await requestStatusMove(status)
        case let .customColumn(id, _):
            await moveToCustomColumn(id)
        }
    }

    public func requestCancellation() async {
        guard canMutate else { return }
        if let warning = await terminalMoveConfirmation(for: .cancelled) {
            pendingConfirmation = warning
        } else {
            pendingConfirmation = TaskInfoCompletionPolicy.cancelConfirmation(task: task)
        }
    }

    public func requestDeletion() {
        guard canMutate else { return }
        pendingConfirmation = TaskInfoCompletionPolicy.deleteConfirmation(task: task)
    }

    public func takePendingConfirmation() -> TaskInfoConfirmation? {
        defer { pendingConfirmation = nil }
        return pendingConfirmation
    }

    public func perform(_ confirmation: TaskInfoConfirmation, confirmed: Bool) async {
        guard confirmed else { return }
        switch confirmation.kind {
        case let .terminalMove(status):
            await move(to: status)
        case .delete:
            await delete()
        case .agentCompletion:
            assertionFailure("Agent completion requests are owned by the persistent app shell.")
        }
    }

    public func setPriority(_ priority: Dev3TaskPriority) async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            let changed = try await service.setPriority(
                taskID: task.id,
                projectID: project.id,
                priority: priority
            )
            if let ownTask = changed.first(where: { $0.id == task.id }) {
                replace(task: ownTask)
            }
            onTasksChanged(changed)
        } catch {
            report(error, operation: "change task priority")
        }
    }

    public func setWatched(_ watched: Bool) async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            try await apply(
                service.setWatched(
                    taskID: task.id,
                    projectID: project.id,
                    watched: watched
                )
            )
        } catch {
            // Watch is a secondary action; the web surface also fails quietly.
        }
    }

    public func toggleLabel(_ labelID: String) async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        var labelIDs = Set(task.labelIds ?? [])
        if !labelIDs.insert(labelID).inserted {
            labelIDs.remove(labelID)
        }
        do {
            try await apply(
                service.setLabels(
                    taskID: task.id,
                    projectID: project.id,
                    labelIDs: labelIDs.sorted()
                )
            )
        } catch {
            report(error, operation: "change task labels")
        }
    }

    public func addNote(_ content: String) async -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, beginMutation() else { return false }
        defer { isMutating = false }
        do {
            try await apply(
                service.addNote(
                    taskID: task.id,
                    projectID: project.id,
                    content: trimmed
                )
            )
            return true
        } catch {
            report(error, operation: "add the note")
            return false
        }
    }

    public func updateNote(_ noteID: String, content: String) async -> Bool {
        guard beginMutation() else { return false }
        defer { isMutating = false }
        do {
            try await apply(
                service.updateNote(
                    taskID: task.id,
                    projectID: project.id,
                    noteID: noteID,
                    content: content
                )
            )
            return true
        } catch {
            report(error, operation: "update the note")
            return false
        }
    }

    public func deleteNote(_ noteID: String) async -> Bool {
        guard beginMutation() else { return false }
        defer { isMutating = false }
        do {
            try await apply(
                service.deleteNote(
                    taskID: task.id,
                    projectID: project.id,
                    noteID: noteID
                )
            )
            return true
        } catch {
            report(error, operation: "delete the note")
            return false
        }
    }

    public func refreshBranchStatus() async {
        guard task.worktreePath != nil,
              isConnected,
              !isRefreshingBranch,
              !isDeleted
        else { return }
        isRefreshingBranch = true
        defer { isRefreshingBranch = false }
        do {
            branchStatus = try await service.branchStatus(taskID: task.id, projectID: project.id)
        } catch {
            report(error, operation: "refresh branch status")
        }
    }

    public func refreshPRStatus() async {
        guard isConnected, !isRefreshingPR, !isDeleted else { return }
        isRefreshingPR = true
        defer { isRefreshingPR = false }
        do {
            try await service.refreshPRStatus(taskID: task.id, projectID: project.id)
        } catch {
            report(error, operation: "refresh pull request status")
        }
    }

    public func clearError() {
        errorMessage = nil
    }
}

private extension TaskInfoStore {
    func beginMutation() -> Bool {
        guard canMutate else { return false }
        isMutating = true
        errorMessage = nil
        return true
    }

    func apply(_ updatedTask: Dev3Task) {
        replace(task: updatedTask)
        onTaskChanged(updatedTask)
    }

    func report(_ error: any Error, operation: String) {
        errorMessage = "Couldn't \(operation): \(error.localizedDescription)"
    }

    func requestStatusMove(_ status: Dev3TaskStatus) async {
        if let confirmation = await terminalMoveConfirmation(for: status) {
            pendingConfirmation = confirmation
            return
        }
        if status == .cancelled {
            pendingConfirmation = TaskInfoCompletionPolicy.cancelConfirmation(task: task)
            return
        }
        await move(to: status)
    }

    func terminalMoveConfirmation(for newStatus: Dev3TaskStatus) async -> TaskInfoConfirmation? {
        guard newStatus == .completed || newStatus == .cancelled, task.worktreePath != nil else {
            return nil
        }
        let currentBranchStatus: Dev3BranchStatus?
        do {
            currentBranchStatus = try await service.branchStatus(taskID: task.id, projectID: project.id)
            branchStatus = currentBranchStatus
        } catch {
            // Matching the web: inability to inspect git state must not block a terminal move.
            currentBranchStatus = nil
        }
        return TaskInfoCompletionPolicy.confirmation(
            task: task,
            project: project,
            newStatus: newStatus,
            branchStatus: currentBranchStatus
        )
    }

    func move(to status: Dev3TaskStatus) async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            let updated: Dev3Task
            do {
                updated = try await service.moveTask(
                    taskID: task.id,
                    projectID: project.id,
                    status: status,
                    force: false
                )
            } catch {
                updated = try await service.moveTask(
                    taskID: task.id,
                    projectID: project.id,
                    status: status,
                    force: true
                )
            }
            apply(updated)
        } catch {
            report(error, operation: "move the task")
        }
    }

    func moveToCustomColumn(_ columnID: String) async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            try await apply(
                service.moveTaskToCustomColumn(
                    taskID: task.id,
                    projectID: project.id,
                    customColumnID: columnID
                )
            )
        } catch {
            report(error, operation: "move the task")
        }
    }

    func delete() async {
        guard beginMutation() else { return }
        defer { isMutating = false }
        do {
            try await service.deleteTask(taskID: task.id, projectID: project.id)
            isDeleted = true
            onDeleted(task.id)
        } catch {
            report(error, operation: "delete the task")
        }
    }
}
