import Dev3Kit
import Foundation

public extension AppStore {
    func taskCreationServiceBinding() -> TaskCreationServiceBinding? {
        guard let rpcClient = rpc as? RPCClient,
              let serverID = rpcServerID,
              rpcIsOpen,
              serverID == controller.activeServer?.instanceId,
              serverID == snapshotServerID
        else {
            return nil
        }
        return TaskCreationServiceBinding(
            provenance: TaskCreationProvenance(
                serverID: serverID,
                rpcGeneration: rpcGeneration
            ),
            service: RPCTaskCreationService(rpcClient: rpcClient)
        )
    }

    @discardableResult
    func acceptTaskCreationEvent(_ event: TaskCreationEvent) -> Bool {
        switch event {
        case let .created(task, provenance), let .updated(task, provenance):
            guard acceptsTaskCreationProvenance(provenance) else { return false }
            snapshot.upsert(task, projectId: task.projectId)
        case let .replaced(result):
            guard acceptsTaskCreationProvenance(result.provenance) else { return false }
            snapshot.removeTask(taskId: result.sourceTaskID, projectId: result.projectID)
            for task in result.variants {
                snapshot.upsert(task, projectId: result.projectID)
            }
        case let .reconciled(projectID, tasks, provenance):
            guard acceptsTaskCreationProvenance(provenance) else { return false }
            snapshot.replaceTasks(tasks, projectId: projectID)
        case let .preparationFailed(task, provenance):
            guard acceptsTaskCreationProvenance(provenance) else { return false }
            snapshot.upsert(task, projectId: task.projectId)
            let detail = task.preparationError ?? "Unknown preparation error"
            toast = AppToast(message: "Task preparation failed: \(detail)", level: .error)
        }
        publishSnapshot()
        return true
    }

    func acceptsTaskCreationProvenance(_ provenance: TaskCreationProvenance) -> Bool {
        rpc != nil && rpcIsOpen &&
            provenance.rpcGeneration == rpcGeneration &&
            provenance.serverID == rpcServerID &&
            provenance.serverID == controller.activeServer?.instanceId &&
            provenance.serverID == snapshotServerID
    }
}

public actor RPCTaskCreationService: TaskCreationServicing {
    private let rpcClient: RPCClient

    public init(rpcClient: RPCClient) {
        self.rpcClient = rpcClient
    }

    public func getAgents() async throws -> [Dev3CodingAgent] {
        try await rpcClient.getAgents()
    }

    public func getGlobalSettings() async throws -> Dev3GlobalSettings {
        try await rpcClient.getGlobalSettings()
    }

    public func createTask(
        projectID: String,
        description: String,
        priority: Dev3TaskPriority
    ) async throws -> Dev3Task {
        try await rpcClient.createTask(
            projectId: projectID,
            description: description,
            priority: priority
        )
    }

    public func renameTask(
        taskID: String,
        projectID: String,
        customTitle: String
    ) async throws -> Dev3Task {
        try await rpcClient.renameTask(
            taskId: taskID,
            projectId: projectID,
            customTitle: customTitle
        )
    }

    public func setTaskLabels(
        taskID: String,
        projectID: String,
        labelIDs: [String]
    ) async throws -> Dev3Task {
        try await rpcClient.setTaskLabels(
            taskId: taskID,
            projectId: projectID,
            labelIds: labelIDs
        )
    }

    public func setTaskWatched(
        taskID: String,
        projectID: String,
        watched: Bool
    ) async throws -> Dev3Task {
        try await rpcClient.toggleTaskWatch(
            taskId: taskID,
            projectId: projectID,
            watched: watched
        )
    }

    public func spawnVariants(
        taskID: String,
        projectID: String,
        variants: [Dev3LaunchVariant]
    ) async throws -> [Dev3Task] {
        try await rpcClient.spawnVariants(
            taskId: taskID,
            projectId: projectID,
            targetStatus: .inProgress,
            variants: variants
        )
    }

    public func getTasks(projectID: String) async throws -> [Dev3Task] {
        try await rpcClient.getTasks(projectId: projectID)
    }
}
