import Dev3Kit
import Foundation
import Observation

public protocol TaskPRStatusServicing: Sendable {
    func refreshPRStatus(taskID: String, projectID: String) async throws
}

@MainActor
@Observable
public final class TaskPRStatusStore {
    public let taskID: String
    public let projectID: String
    public private(set) var detail: TaskPRStatusDetail?
    public private(set) var isConnected: Bool
    public private(set) var isRefreshing = false
    public private(set) var errorMessage: String?

    private let service: any TaskPRStatusServicing
    private var refreshGeneration = 0

    public init(
        task: Dev3Task,
        pushedStatus: TaskPRStatusPush? = nil,
        isConnected: Bool,
        service: any TaskPRStatusServicing
    ) {
        taskID = task.id
        projectID = task.projectId
        detail = pushedStatus.flatMap(TaskPRStatusDetail.init(push:)) ?? TaskPRStatusDetail(task: task)
        self.isConnected = isConnected
        self.service = service
    }

    public func setConnected(_ connected: Bool) {
        isConnected = connected
        if connected {
            errorMessage = nil
        } else {
            refreshGeneration += 1
            isRefreshing = false
        }
    }

    /// AppStore remains the only RPC stream consumer and fans relevant events into this reducer.
    public func receive(_ push: RPCPushEvent) {
        guard case let .taskPRStatus(status) = push,
              status.taskId == taskID,
              status.projectId == projectID
        else {
            return
        }
        detail = TaskPRStatusDetail(push: status)
        errorMessage = nil
    }

    public func refresh() async {
        guard isConnected, !isRefreshing else { return }
        refreshGeneration += 1
        let generation = refreshGeneration
        isRefreshing = true
        errorMessage = nil
        defer {
            if refreshGeneration == generation {
                isRefreshing = false
            }
        }
        do {
            try await service.refreshPRStatus(taskID: taskID, projectID: projectID)
        } catch is CancellationError {
            return
        } catch {
            guard refreshGeneration == generation else { return }
            errorMessage = "Could not refresh pull request status: \(error.localizedDescription)"
        }
    }
}
