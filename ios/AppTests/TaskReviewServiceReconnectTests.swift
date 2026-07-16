@testable import dev3
import Dev3Kit
import Dev3UI
import Foundation
import Testing

@Suite("Task review reconnect routing")
@MainActor
struct TaskReviewServiceReconnectTests {
    @Test("Diff and pull request refreshes resolve the replacement RPC client")
    func replacementClient() async throws {
        let clientA = try ReconnectRecordingRPCClient(response: makeReconnectDiff())
        let clientB = try ReconnectRecordingRPCClient(response: makeReconnectDiff())
        let registry = ReconnectRPCClientRegistry(client: clientA)
        let diffService = RPCTaskDiffService { registry.client }
        let prService = RPCTaskPRStatusService { registry.client }
        let request = TaskDiffFetchRequest(
            taskID: "task",
            projectID: "project",
            mode: .uncommitted,
            compareRef: nil,
            compareLabel: nil,
            count: nil
        )

        _ = try await diffService.taskDiff(request)
        try await prService.refreshPRStatus(taskID: "task", projectID: "project")
        registry.client = clientB
        _ = try await diffService.taskDiff(request)
        try await prService.refreshPRStatus(taskID: "task", projectID: "project")

        #expect(await clientA.diffRequests() == [request])
        #expect(await clientA.prRequests() == [ReconnectPRRequest(taskID: "task", projectID: "project")])
        #expect(await clientB.diffRequests() == [request])
        #expect(await clientB.prRequests() == [ReconnectPRRequest(taskID: "task", projectID: "project")])
    }
}

@MainActor
private final class ReconnectRPCClientRegistry {
    var client: ReconnectRecordingRPCClient?

    init(client: ReconnectRecordingRPCClient?) {
        self.client = client
    }
}

private struct ReconnectPRRequest: Equatable, Sendable {
    let taskID: String
    let projectID: String
}

private actor ReconnectRecordingRPCClient: TaskDiffRPCRequesting, TaskPRStatusRPCRequesting {
    private let response: Dev3TaskDiff
    private var recordedDiffRequests: [TaskDiffFetchRequest] = []
    private var recordedPRRequests: [ReconnectPRRequest] = []

    init(response: Dev3TaskDiff) {
        self.response = response
    }

    func requestTaskDiff(_ request: TaskDiffFetchRequest) -> Dev3TaskDiff {
        recordedDiffRequests.append(request)
        return response
    }

    func requestTaskPRStatusRefresh(taskID: String, projectID: String) {
        recordedPRRequests.append(ReconnectPRRequest(taskID: taskID, projectID: projectID))
    }

    func diffRequests() -> [TaskDiffFetchRequest] {
        recordedDiffRequests
    }

    func prRequests() -> [ReconnectPRRequest] {
        recordedPRRequests
    }
}

private func makeReconnectDiff() throws -> Dev3TaskDiff {
    let object: [String: Any] = [
        "mode": "uncommitted",
        "compareRef": NSNull(),
        "compareLabel": "Working tree",
        "files": [],
        "skippedFiles": [],
        "summary": [
            "files": 0,
            "insertions": 0,
            "deletions": 0
        ]
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3TaskDiff.self, from: data)
}
