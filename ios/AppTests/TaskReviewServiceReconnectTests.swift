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

@Suite("Companion connection ownership")
struct CompanionConnectionOwnershipTests {
    @Test("Same-server RPC replacement changes destination identity")
    func sameServerReplacementIdentity() {
        let firstGeneration = UUID()
        let secondGeneration = UUID()
        let identity = CompanionConnectionIdentity(
            serverID: "server-a",
            rpcGeneration: firstGeneration
        )

        #expect(identity.matches(serverID: "server-a", rpcGeneration: firstGeneration))
        #expect(!identity.matches(serverID: "server-a", rpcGeneration: secondGeneration))
        #expect(!identity.matches(serverID: "server-b", rpcGeneration: firstGeneration))
        #expect(
            identity != CompanionConnectionIdentity(
                serverID: "server-a",
                rpcGeneration: secondGeneration
            )
        )
    }

    @Test("Stale terminal and task info work is rejected by its connection lease")
    @MainActor
    func staleConnectionLease() async throws {
        let state = ReconnectLeaseState()
        let gate = CompanionConnectionLeaseGate { state.isCurrent }

        try await gate.requireCurrent()
        state.isCurrent = false

        await #expect(throws: CompanionConnectionLeaseError.replaced) {
            try await gate.requireCurrent()
        }
    }

    @Test("Stale terminal focus release is suppressed without skipping PTY teardown")
    @MainActor
    func staleTerminalFocusRelease() async throws {
        let clientA = ReconnectLeaseState()
        let clientB = ReconnectLeaseState()
        let recorder = ReconnectTerminalLifecycleRecorder()
        let lifecycleA = CompanionTerminalConnectionLifecycle(
            connectionGate: CompanionConnectionLeaseGate { clientA.isCurrent },
            setTerminalFocus: { active in await recorder.focus(client: "A", active: active) },
            disconnectPTY: { await recorder.disconnectPTY(client: "A") }
        )
        let lifecycleB = CompanionTerminalConnectionLifecycle(
            connectionGate: CompanionConnectionLeaseGate { clientB.isCurrent },
            setTerminalFocus: { active in await recorder.focus(client: "B", active: active) },
            disconnectPTY: { await recorder.disconnectPTY(client: "B") }
        )

        try await lifecycleA.setActive(true)
        try await lifecycleA.connected()
        clientA.isCurrent = false
        await lifecycleA.disconnecting()
        try await lifecycleB.setActive(true)
        try await lifecycleB.connected()

        #expect(
            await recorder.focusEvents() == [
                ReconnectFocusEvent(client: "A", active: true),
                ReconnectFocusEvent(client: "B", active: true)
            ]
        )
        #expect(await recorder.disconnectedPTYClients() == ["A"])
    }

    @Test("Pairing transitions dismiss Task Info while socket reconnects retain it")
    func taskInfoRoutePolicy() {
        let connected = CompanionSessionRouteState(
            sessionState: .connected,
            activeServerID: "server-a"
        )
        let reconnecting = CompanionSessionRouteState(
            sessionState: .reconnecting,
            activeServerID: "server-a"
        )
        let authenticating = CompanionSessionRouteState(
            sessionState: .authenticating,
            activeServerID: "server-a"
        )
        let expired = CompanionSessionRouteState(
            sessionState: .expired,
            activeServerID: "server-a"
        )
        let unpaired = CompanionSessionRouteState(
            sessionState: .idle,
            activeServerID: nil
        )
        let switchedServer = CompanionSessionRouteState(
            sessionState: .connected,
            activeServerID: "server-b"
        )

        #expect(!CompanionSessionRouteState.shouldDismissTaskInfo(from: connected, to: reconnecting))
        #expect(CompanionSessionRouteState.shouldDismissTaskInfo(from: connected, to: authenticating))
        #expect(CompanionSessionRouteState.shouldDismissTaskInfo(from: connected, to: expired))
        #expect(CompanionSessionRouteState.shouldDismissTaskInfo(from: connected, to: unpaired))
        #expect(CompanionSessionRouteState.shouldDismissTaskInfo(from: connected, to: switchedServer))
    }
}

@MainActor
private final class ReconnectLeaseState {
    var isCurrent = true
}

private struct ReconnectFocusEvent: Equatable, Sendable {
    let client: String
    let active: Bool
}

private actor ReconnectTerminalLifecycleRecorder {
    private var recordedFocusEvents: [ReconnectFocusEvent] = []
    private var recordedPTYDisconnects: [String] = []

    func focus(client: String, active: Bool) {
        recordedFocusEvents.append(ReconnectFocusEvent(client: client, active: active))
    }

    func disconnectPTY(client: String) {
        recordedPTYDisconnects.append(client)
    }

    func focusEvents() -> [ReconnectFocusEvent] {
        recordedFocusEvents
    }

    func disconnectedPTYClients() -> [String] {
        recordedPTYDisconnects
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
