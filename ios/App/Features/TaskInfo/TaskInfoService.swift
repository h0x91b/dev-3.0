import Dev3Kit
import Dev3UI

actor RPCTaskInfoService: TaskInfoServicing {
    private let rpcClient: RPCClient
    private let connectionGate: CompanionConnectionLeaseGate

    init(
        rpcClient: RPCClient,
        connectionIsCurrent: @escaping @MainActor @Sendable () -> Bool = { true }
    ) {
        self.rpcClient = rpcClient
        connectionGate = CompanionConnectionLeaseGate(
            connectionIsCurrent: connectionIsCurrent
        )
    }

    func renameTask(taskID: String, projectID: String, customTitle: String?) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.renameTask(
                taskId: taskID,
                projectId: projectID,
                customTitle: customTitle
            )
        }
    }

    func moveTask(
        taskID: String,
        projectID: String,
        status: Dev3TaskStatus,
        force: Bool
    ) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.moveTask(
                taskId: taskID,
                projectId: projectID,
                newStatus: status,
                force: force ? true : nil
            )
        }
    }

    func moveTaskToCustomColumn(
        taskID: String,
        projectID: String,
        customColumnID: String
    ) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.moveTaskToCustomColumn(
                taskId: taskID,
                projectId: projectID,
                customColumnId: customColumnID
            )
        }
    }

    func setPriority(
        taskID: String,
        projectID: String,
        priority: Dev3TaskPriority
    ) async throws -> [Dev3Task] {
        try await connectionGate.perform {
            try await self.rpcClient.setTaskPriority(
                taskId: taskID,
                projectId: projectID,
                priority: priority
            )
        }
    }

    func setWatched(taskID: String, projectID: String, watched: Bool) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.toggleTaskWatch(
                taskId: taskID,
                projectId: projectID,
                watched: watched
            )
        }
    }

    func setLabels(taskID: String, projectID: String, labelIDs: [String]) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.setTaskLabels(
                taskId: taskID,
                projectId: projectID,
                labelIds: labelIDs
            )
        }
    }

    func setUserOverview(taskID: String, projectID: String, overview: String) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.setUserOverview(
                taskId: taskID,
                projectId: projectID,
                userOverview: overview
            )
        }
    }

    func addNote(taskID: String, projectID: String, content: String) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.addTaskNote(
                taskId: taskID,
                projectId: projectID,
                content: content,
                source: .user
            )
        }
    }

    func updateNote(
        taskID: String,
        projectID: String,
        noteID: String,
        content: String
    ) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.updateTaskNote(
                taskId: taskID,
                projectId: projectID,
                noteId: noteID,
                content: content
            )
        }
    }

    func deleteNote(taskID: String, projectID: String, noteID: String) async throws -> Dev3Task {
        try await connectionGate.perform {
            try await self.rpcClient.deleteTaskNote(
                taskId: taskID,
                projectId: projectID,
                noteId: noteID
            )
        }
    }

    func deleteTask(taskID: String, projectID: String) async throws {
        try await connectionGate.perform {
            try await self.rpcClient.deleteTask(taskId: taskID, projectId: projectID)
        }
    }

    func branchStatus(taskID: String, projectID: String) async throws -> Dev3BranchStatus {
        try await connectionGate.perform {
            try await self.rpcClient.getBranchStatus(taskId: taskID, projectId: projectID)
        }
    }

    func refreshPRStatus(taskID: String, projectID: String) async throws {
        try await connectionGate.perform {
            try await self.rpcClient.refreshTaskPrStatus(taskId: taskID, projectId: projectID)
        }
    }
}
