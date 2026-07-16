import Dev3Kit
import Foundation

public extension AppStore {
    var isConnected: Bool {
        guard rpc != nil,
              rpcIsOpen,
              rpcServerID == controller.activeServer?.instanceId else { return false }
        return controller.sessionState == .connected || controller.sessionState == .idle
    }

    var allTasks: [Dev3Task] {
        projects.flatMap { tasksByProject[$0.id] ?? [] }
    }

    func project(id projectID: String) -> Dev3Project? {
        projects.first { $0.id == projectID }
    }

    func task(projectId: String, taskId: String) -> Dev3Task? {
        tasksByProject[projectId]?.first { $0.id == taskId }
    }

    func refreshAll() async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        await refetch(
            using: rpc,
            generation: context.generation,
            sourceServerID: context.serverID
        )
    }

    func refreshProject(_ projectID: String) async {
        loadedBoardProjectIDs.insert(projectID)
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        do {
            let tasks = try await rpc.getTasks(projectId: projectID)
            guard owns(context) else { return }
            snapshot.replaceTasks(tasks, projectId: projectID)
            publishSnapshot()
            lastSyncError = nil
        } catch {
            guard owns(context) else { return }
            lastSyncError = "Could not refresh this project. Cached board data is still available."
        }
    }

    func pullProjectMain(_ projectID: String) async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        projectPullStates[projectID] = .pulling
        do {
            let result = try await rpc.pullProjectMain(projectId: projectID)
            guard owns(context) else { return }
            if result.ok {
                projectPullStates[projectID] = .succeeded(Self.pullSuccessMessage(result))
                await refreshProject(projectID)
            } else {
                projectPullStates[projectID] = .failed(Self.pullFailureMessage(result))
            }
        } catch {
            guard owns(context) else { return }
            projectPullStates[projectID] = .failed(error.localizedDescription)
        }
    }

    func moveTask(_ task: Dev3Task, to status: Dev3TaskStatus) async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        do {
            let updated = try await rpc.moveTask(
                taskId: task.id,
                projectId: task.projectId,
                newStatus: status,
                force: nil,
                clientPlayedSound: nil
            )
            guard owns(context) else { return }
            acceptTaskUpdate(updated)
        } catch {
            guard owns(context) else { return }
            presentMutationError("Could not move task", error: error)
        }
    }

    func setTaskPriority(_ task: Dev3Task, priority: Dev3TaskPriority) async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        do {
            let updated = try await rpc.setTaskPriority(
                taskId: task.id,
                projectId: task.projectId,
                priority: priority
            )
            guard owns(context) else { return }
            acceptTaskUpdates(updated)
        } catch {
            guard owns(context) else { return }
            presentMutationError("Could not change task priority", error: error)
        }
    }

    func toggleTaskWatch(_ task: Dev3Task) async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        do {
            let updated = try await rpc.toggleTaskWatch(
                taskId: task.id,
                projectId: task.projectId,
                watched: task.watched != true
            )
            guard owns(context) else { return }
            acceptTaskUpdate(updated)
        } catch {
            guard owns(context) else { return }
            presentMutationError("Could not update task watch", error: error)
        }
    }

    func moveTask(_ task: Dev3Task, toCustomColumn columnID: String) async {
        guard isConnected, let rpc, let context = currentRPCContext() else { return }
        do {
            let updated = try await rpc.moveTaskToCustomColumn(
                taskId: task.id,
                projectId: task.projectId,
                customColumnId: columnID
            )
            guard owns(context) else { return }
            acceptTaskUpdate(updated)
        } catch {
            guard owns(context) else { return }
            presentMutationError("Could not move task", error: error)
        }
    }

    func acceptTaskUpdate(_ task: Dev3Task) {
        snapshot.upsert(task, projectId: task.projectId)
        publishSnapshot()
    }

    func acceptTaskUpdates(_ tasks: [Dev3Task]) {
        for task in tasks {
            snapshot.upsert(task, projectId: task.projectId)
        }
        publishSnapshot()
    }

    func acceptTaskRemoval(taskId: String, projectId: String) {
        snapshot.removeTask(taskId: taskId, projectId: projectId)
        publishSnapshot()
    }

    func openProject(_ projectID: String) {
        selectedTab = .projects
        projectsPath.append(.project(projectID))
    }

    func openTask(projectId: String, taskId: String, from tab: AppTab) {
        guard isConnected else { return }
        selectedTab = tab
        let route = AppRoute.task(projectId: projectId, taskId: taskId)
        switch tab {
        case .work:
            workPath.append(route)
        case .projects:
            projectsPath.append(route)
        case .settings:
            break
        }
    }

    func removeTaskRoutes(projectId: String, taskId: String) {
        let route = AppRoute.task(projectId: projectId, taskId: taskId)
        workPath.removeAll { $0 == route }
        projectsPath.removeAll { $0 == route }
    }

    func removeAllTaskRoutes() {
        workPath.removeAll { route in
            if case .task = route {
                return true
            }
            return false
        }
        projectsPath.removeAll { route in
            if case .task = route {
                return true
            }
            return false
        }
    }

    func clipboardStream(for taskID: String) -> AsyncStream<String> {
        AsyncStream { continuation in
            let token = addPushObserver { push in
                guard case let .osc52Clipboard(clipboard) = push, clipboard.taskId == taskID else {
                    return
                }
                continuation.yield(clipboard.text)
            }
            continuation.onTermination = { @Sendable [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.removePushObserver(token)
                }
            }
        }
    }
}

struct AppRPCContext: Equatable, Sendable {
    let generation: UUID
    let serverID: String?
}

extension AppStore {
    func currentRPCContext() -> AppRPCContext? {
        guard rpc != nil else { return nil }
        return AppRPCContext(generation: rpcGeneration, serverID: rpcServerID)
    }

    func owns(_ context: AppRPCContext) -> Bool {
        context.generation == rpcGeneration
            && context.serverID == rpcServerID
            && context.serverID == controller.activeServer?.instanceId
    }
}

private extension AppStore {
    static func pullSuccessMessage(_ result: Dev3ProjectPullResult) -> String {
        let output = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !output.isEmpty {
            return output
        }
        if let branch = result.branch, !branch.isEmpty {
            return "Updated \(branch)"
        }
        return "Project is up to date"
    }

    static func pullFailureMessage(_ result: Dev3ProjectPullResult) -> String {
        let error = result.error.trimmingCharacters(in: .whitespacesAndNewlines)
        return error.isEmpty ? "Pull failed" : error
    }

    func presentMutationError(_ prefix: String, error: Error) {
        toast = AppToast(message: "\(prefix): \(error.localizedDescription)", level: .error)
    }
}
