import Dev3Kit
import Dev3UI
import Foundation

protocol TaskPRStatusRPCRequesting: Sendable {
    func requestTaskPRStatusRefresh(taskID: String, projectID: String) async throws
}

extension RPCClient: TaskPRStatusRPCRequesting {
    func requestTaskPRStatusRefresh(taskID: String, projectID: String) async throws {
        try await refreshTaskPrStatus(taskId: taskID, projectId: projectID)
    }
}

typealias TaskPRStatusRPCClientProvider = @MainActor @Sendable () -> (any TaskPRStatusRPCRequesting)?

actor RPCTaskPRStatusService: TaskPRStatusServicing {
    private let rpcClientProvider: TaskPRStatusRPCClientProvider

    init(rpcClientProvider: @escaping TaskPRStatusRPCClientProvider) {
        self.rpcClientProvider = rpcClientProvider
    }

    func refreshPRStatus(taskID: String, projectID: String) async throws {
        guard let rpcClient = await rpcClientProvider() else {
            throw OfflineTaskPRStatusError()
        }
        try await rpcClient.requestTaskPRStatusRefresh(taskID: taskID, projectID: projectID)
    }
}

private struct OfflineTaskPRStatusError: LocalizedError {
    var errorDescription: String? {
        "Reconnect to refresh pull request status."
    }
}
