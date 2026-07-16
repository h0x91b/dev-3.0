import Dev3Kit
import Foundation
import Observation

// Task Info intentionally centralizes all editor, lifecycle, and terminal-safety state.
// swiftlint:disable file_length

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
// swiftlint:disable:next type_body_length
public final class TaskInfoStore {
    public private(set) var task: Dev3Task
    public private(set) var project: Dev3Project
    public private(set) var pushedPRStatus: TaskPRStatusPush?
    public private(set) var branchStatus: Dev3BranchStatus?
    public private(set) var isConnected: Bool
    public private(set) var isMutating = false
    public private(set) var isPreparingTerminalMove = false
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
    private let terminalMovePreflightTimeout: Duration
    private var terminalMovePreflightGeneration: UInt64 = 0

    public init(
        task: Dev3Task,
        project: Dev3Project,
        service: any TaskInfoServicing,
        isConnected: Bool,
        pushedPRStatus: TaskPRStatusPush? = nil,
        terminalMovePreflightTimeout: Duration = .seconds(15),
        onTaskChanged: @escaping @MainActor (Dev3Task) -> Void = { _ in },
        onTasksChanged: @escaping @MainActor ([Dev3Task]) -> Void = { _ in },
        onDeleted: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.task = task
        self.project = project
        self.service = service
        self.isConnected = isConnected
        self.pushedPRStatus = pushedPRStatus
        self.terminalMovePreflightTimeout = terminalMovePreflightTimeout
        self.onTaskChanged = onTaskChanged
        self.onTasksChanged = onTasksChanged
        self.onDeleted = onDeleted
        titleDraft = task.displayTitle
        userOverviewDraft = task.userOverview ?? ""
    }

    public var canMutate: Bool {
        isConnected && !isMutating && !isPreparingTerminalMove && !isDeleted
    }

    public var hasDraftChanges: Bool {
        titleDraft.trimmingCharacters(in: .whitespacesAndNewlines) != task.displayTitle ||
            userOverviewDraft.trimmingCharacters(in: .whitespacesAndNewlines) != (task.userOverview ?? "")
    }

    public var destinations: [TaskInfoDestination] {
        let statuses: [Dev3TaskStatus] = if task.status == .todo {
            // Starting Todo work must go through spawnVariants so the agent/config is explicit.
            [.completed, .cancelled]
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
        if !connected {
            invalidateTerminalMovePreflight()
        }
    }

    public func replace(task updatedTask: Dev3Task, project updatedProject: Dev3Project? = nil) {
        guard updatedTask.id == task.id else { return }
        if updatedTask.status != task.status || updatedTask.worktreePath != task.worktreePath {
            invalidateTerminalMovePreflight()
        }
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
            invalidateTerminalMovePreflight()
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
        await requestStatusMove(.cancelled)
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

private enum TerminalMoveBranchStatusResult: Sendable {
    case status(Dev3BranchStatus)
    case unavailable
    case timedOut
    case cancelled
}

private final class TerminalMoveBranchStatusRace: @unchecked Sendable {
    private let lock = NSLock()
    private var result: TerminalMoveBranchStatusResult?
    private var continuation: CheckedContinuation<TerminalMoveBranchStatusResult, Never>?
    private var serviceTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    func install(serviceTask: Task<Void, Never>, timeoutTask: Task<Void, Never>) {
        lock.lock()
        let alreadyResolved = result != nil
        if !alreadyResolved {
            self.serviceTask = serviceTask
            self.timeoutTask = timeoutTask
        }
        lock.unlock()
        if alreadyResolved {
            serviceTask.cancel()
            timeoutTask.cancel()
        }
    }

    func wait() async -> TerminalMoveBranchStatusResult {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func resolve(_ result: TerminalMoveBranchStatusResult) {
        let continuation: CheckedContinuation<TerminalMoveBranchStatusResult, Never>?
        let serviceTask: Task<Void, Never>?
        let timeoutTask: Task<Void, Never>?
        lock.lock()
        guard self.result == nil else {
            lock.unlock()
            return
        }
        self.result = result
        continuation = self.continuation
        serviceTask = self.serviceTask
        timeoutTask = self.timeoutTask
        self.continuation = nil
        self.serviceTask = nil
        self.timeoutTask = nil
        lock.unlock()

        serviceTask?.cancel()
        timeoutTask?.cancel()
        continuation?.resume(returning: result)
    }
}

private extension TaskInfoStore {
    enum TerminalMovePreflightOutcome {
        case clear
        case warning(TaskInfoConfirmation)
        case unavailable
        case stale
    }

    struct TerminalMovePreflightContext {
        let generation: UInt64
        let taskID: String
        let projectID: String
        let status: Dev3TaskStatus
        let worktreePath: String?
        let baseBranch: String
        let projectBaseBranch: String
    }

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
        guard status == .completed || status == .cancelled, task.worktreePath != nil else {
            if status == .cancelled {
                pendingConfirmation = TaskInfoCompletionPolicy.cancelConfirmation(task: task)
            } else {
                await move(to: status)
            }
            return
        }

        if let confirmation = terminalMoveWarning(for: status, branchStatus: branchStatus) {
            pendingConfirmation = confirmation
            return
        }

        guard let context = beginTerminalMovePreflight() else { return }
        let outcome = await terminalMovePreflight(for: status, context: context)
        guard finishTerminalMovePreflight(context) else { return }

        switch outcome {
        case .clear where status == .cancelled:
            pendingConfirmation = TaskInfoCompletionPolicy.cancelConfirmation(task: task)
        case .clear:
            await move(to: status)
        case let .warning(confirmation):
            pendingConfirmation = confirmation
        case .unavailable:
            pendingConfirmation = terminalMoveUnavailableConfirmation(for: status)
        case .stale:
            break
        }
    }

    func beginTerminalMovePreflight() -> TerminalMovePreflightContext? {
        guard canMutate else { return nil }
        terminalMovePreflightGeneration &+= 1
        isPreparingTerminalMove = true
        errorMessage = nil
        return TerminalMovePreflightContext(
            generation: terminalMovePreflightGeneration,
            taskID: task.id,
            projectID: project.id,
            status: task.status,
            worktreePath: task.worktreePath,
            baseBranch: task.baseBranch,
            projectBaseBranch: project.defaultBaseBranch
        )
    }

    func finishTerminalMovePreflight(_ context: TerminalMovePreflightContext) -> Bool {
        guard terminalMovePreflightGeneration == context.generation else { return false }
        isPreparingTerminalMove = false
        return isConnected &&
            !isDeleted &&
            task.id == context.taskID &&
            project.id == context.projectID &&
            task.status == context.status &&
            task.worktreePath == context.worktreePath &&
            task.baseBranch == context.baseBranch &&
            project.defaultBaseBranch == context.projectBaseBranch
    }

    func invalidateTerminalMovePreflight() {
        guard isPreparingTerminalMove else { return }
        terminalMovePreflightGeneration &+= 1
        isPreparingTerminalMove = false
    }

    func terminalMovePreflight(
        for newStatus: Dev3TaskStatus,
        context: TerminalMovePreflightContext
    ) async -> TerminalMovePreflightOutcome {
        let result = await branchStatusForTerminalMove(
            taskID: context.taskID,
            projectID: context.projectID
        )
        guard !Task.isCancelled else { return .stale }
        switch result {
        case let .status(currentBranchStatus):
            guard terminalMovePreflightGeneration == context.generation else { return .stale }
            branchStatus = currentBranchStatus
            if let warning = terminalMoveWarning(for: newStatus, branchStatus: currentBranchStatus) {
                return .warning(warning)
            }
            return .clear
        case .cancelled:
            return .stale
        case .timedOut, .unavailable:
            guard terminalMovePreflightGeneration == context.generation else { return .stale }
            if let warning = terminalMoveWarning(for: newStatus, branchStatus: branchStatus) {
                return .warning(warning)
            }
            return .unavailable
        }
    }

    func branchStatusForTerminalMove(
        taskID: String,
        projectID: String
    ) async -> TerminalMoveBranchStatusResult {
        let race = TerminalMoveBranchStatusRace()
        let service = service
        let timeout = terminalMovePreflightTimeout
        let serviceTask = Task.detached {
            do {
                let status = try await service.branchStatus(taskID: taskID, projectID: projectID)
                race.resolve(.status(status))
            } catch is CancellationError {
                race.resolve(.cancelled)
            } catch {
                race.resolve(.unavailable)
            }
        }
        let timeoutTask = Task.detached {
            do {
                try await Task.sleep(for: timeout)
                race.resolve(.timedOut)
            } catch {
                // The service or caller won the race and cancelled this deadline.
            }
        }
        race.install(serviceTask: serviceTask, timeoutTask: timeoutTask)
        return await withTaskCancellationHandler {
            await race.wait()
        } onCancel: {
            race.resolve(.cancelled)
        }
    }

    func terminalMoveWarning(
        for newStatus: Dev3TaskStatus,
        branchStatus: Dev3BranchStatus?
    ) -> TaskInfoConfirmation? {
        TaskInfoCompletionPolicy.confirmation(
            task: task,
            project: project,
            newStatus: newStatus,
            branchStatus: branchStatus
        )
    }

    func terminalMoveUnavailableConfirmation(for newStatus: Dev3TaskStatus) -> TaskInfoConfirmation {
        TaskInfoConfirmation(
            kind: .terminalMove(newStatus),
            title: "Branch Status Unavailable",
            message: "Branch safety could not be verified. The worktree and branch will be deleted, " +
                "and uncommitted, unpushed, or unmerged work may be lost. Continue?",
            confirmTitle: newStatus == .completed ? "Complete task" : "Cancel task"
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
