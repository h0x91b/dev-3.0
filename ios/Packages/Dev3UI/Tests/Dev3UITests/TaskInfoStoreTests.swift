@testable import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Task info store")
struct TaskInfoStoreTests {
    @Test("Clean cancellation from the status picker waits for confirmation")
    func cleanCancellationConfirmsBeforeMutation() async throws {
        let original = try task(status: .inProgress, worktreePath: "/tmp/worktree")
        let cancelled = try task(status: .cancelled)
        let service = try TaskInfoServiceDouble(response: cancelled, branch: branchStatus())
        let store = try makeStore(task: original, service: service)

        await store.requestMove(to: .status(.cancelled))

        #expect(await service.moveCalls().isEmpty)
        #expect(store.pendingConfirmation?.kind == .terminalMove(.cancelled))
        #expect(store.pendingConfirmation?.message == "Cancel task \"Task title\"?")

        let confirmation = try #require(store.takePendingConfirmation())
        await store.perform(confirmation, confirmed: true)
        #expect(await service.moveCalls() == [.init(status: .cancelled, force: false)])
        #expect(store.task.status == .cancelled)
    }

    @Test("Unsafe completion preserves web warning copy and force-retries the move")
    func unsafeCompletionAndForceRetry() async throws {
        let original = try task(status: .reviewByUser, worktreePath: "/tmp/worktree")
        let completed = try task(status: .completed)
        let branch = try branchStatus(
            ahead: 3,
            insertions: 12,
            deletions: 4,
            unpushed: 2,
            mergedByContent: false
        )
        let service = TaskInfoServiceDouble(
            response: completed,
            branch: branch,
            failFirstMove: true
        )
        let store = try makeStore(task: original, service: service)

        await store.requestMove(to: .status(.completed))

        let confirmation = try #require(store.pendingConfirmation)
        #expect(confirmation.title == "Unsaved Changes")
        #expect(confirmation.message.contains("• Uncommitted changes: +12 / -4 lines"))
        #expect(confirmation.message.contains("• 2 unpushed commit(s) — will be lost"))
        #expect(confirmation.message.contains("• 3 commit(s) pushed but not merged into main"))
        #expect(confirmation.message.hasSuffix("The worktree and branch will be deleted. Continue?"))
        #expect(await service.moveCalls().isEmpty)

        _ = store.takePendingConfirmation()
        await store.perform(confirmation, confirmed: true)
        #expect(
            await service.moveCalls() == [
                .init(status: .completed, force: false),
                .init(status: .completed, force: true)
            ]
        )
        #expect(store.task.status == .completed)
    }

    @Test("An unavailable branch check does not block a clean terminal move")
    func branchFailureDoesNotBlock() async throws {
        let original = try task(status: .reviewByUser, worktreePath: "/tmp/worktree")
        let completed = try task(status: .completed)
        let service = try TaskInfoServiceDouble(
            response: completed,
            branch: branchStatus(),
            failBranch: true
        )
        let store = try makeStore(task: original, service: service)

        await store.requestMove(to: .status(.completed))

        #expect(store.pendingConfirmation == nil)
        #expect(await service.moveCalls() == [.init(status: .completed, force: false)])
        #expect(store.task.status == .completed)
    }

    @Test("Disconnected state blocks every mutation entry point")
    func disconnectedMutationsAreDisabled() async throws {
        let original = try task(status: .inProgress, worktreePath: "/tmp/worktree")
        let service = try TaskInfoServiceDouble(response: original, branch: branchStatus())
        let store = try makeStore(task: original, service: service, isConnected: false)
        store.titleDraft = "Renamed"

        await store.saveDrafts()
        await store.requestMove(to: .status(.reviewByUser))
        await store.setPriority(.p0)
        await store.setWatched(true)
        await store.toggleLabel("label-1")
        _ = await store.addNote("Note")
        store.requestDeletion()

        #expect(store.canMutate == false)
        #expect(store.pendingConfirmation == nil)
        #expect(await service.allCalls().isEmpty)
    }

    @Test("Drafts, group priority, labels, watch, and notes apply server responses")
    func editableFieldsRoundTrip() async throws {
        let original = try task(status: .inProgress)
        let renamed = try task(status: .inProgress, customTitle: "Renamed")
        let overview = try task(status: .inProgress, customTitle: "Renamed", userOverview: "Owner context")
        let priority = try task(
            status: .inProgress,
            customTitle: "Renamed",
            userOverview: "Owner context",
            priority: .p0
        )
        let service = try TaskInfoServiceDouble(response: original, branch: branchStatus())
        await service.setRenameResponses([renamed, overview])
        await service.setPriorityResponses([priority])
        let store = try makeStore(task: original, service: service)
        store.titleDraft = "Renamed"
        store.userOverviewDraft = "Owner context"

        await store.saveDrafts()
        await store.setPriority(.p0)
        await store.setWatched(true)
        await store.toggleLabel("label-1")
        _ = await store.addNote("Durable finding")
        _ = await store.updateNote("note-1", content: "Edited")
        _ = await store.deleteNote("note-1")

        let calls = await service.allCalls()
        #expect(calls.contains(.rename("Renamed")))
        #expect(calls.contains(.overview("Owner context")))
        #expect(calls.contains(.priority(.p0)))
        #expect(calls.contains(.watched(true)))
        #expect(calls.contains(.labels(["label-1"])))
        #expect(calls.contains(.addNote("Durable finding")))
        #expect(calls.contains(.updateNote(id: "note-1", content: "Edited")))
        #expect(calls.contains(.deleteNote("note-1")))
    }

    @Test("Destinations mirror web transitions and exclude the current custom queue")
    func destinationProjection() throws {
        let original = try task(status: .todo, customColumnID: "custom-current")
        let service = try TaskInfoServiceDouble(response: original, branch: branchStatus())
        let store = try makeStore(task: original, service: service)

        #expect(
            store.destinations == [
                .status(.inProgress),
                .status(.completed),
                .status(.cancelled),
                .customColumn(id: "custom-other", name: "Later")
            ]
        )
    }

    @Test("Custom queue and delete actions call their dedicated RPCs")
    func customMoveAndDelete() async throws {
        let original = try task(status: .inProgress)
        let service = try TaskInfoServiceDouble(response: original, branch: branchStatus())
        var deletedTaskID: String?
        let store = try TaskInfoStore(
            task: original,
            project: project(),
            service: service,
            isConnected: true,
            onDeleted: { deletedTaskID = $0 }
        )

        await store.requestMove(to: .customColumn(id: "custom-other", name: "Later"))
        store.requestDeletion()
        #expect(await service.allCalls() == [.customColumn("custom-other")])

        let confirmation = try #require(store.takePendingConfirmation())
        await store.perform(confirmation, confirmed: true)

        #expect(await service.allCalls() == [.customColumn("custom-other"), .delete])
        #expect(store.isDeleted)
        #expect(deletedTaskID == original.id)
    }

    @Test("AppStore fanout updates task, PR, and removal state without another stream consumer")
    func pushFanoutReducer() throws {
        let original = try task(status: .inProgress)
        let updated = try task(status: .reviewByUser)
        let service = try TaskInfoServiceDouble(response: original, branch: branchStatus())
        var deletedTaskID: String?
        let store = try TaskInfoStore(
            task: original,
            project: project(),
            service: service,
            isConnected: true,
            onDeleted: { deletedTaskID = $0 }
        )
        let pr: TaskPRStatusPush = try decodeTaskInfoFixture(
            """
            {"projectId":"project-1","taskId":"task-1","prNumber":969,"checks":[]}
            """
        )

        store.receive(.taskUpdated(.init(projectId: "project-1", task: updated)))
        store.receive(.taskPRStatus(pr))
        store.receive(.taskRemoved(.init(projectId: "project-1", taskId: "task-1")))

        #expect(store.task.status == .reviewByUser)
        #expect(store.pushedPRStatus == pr)
        #expect(store.isDeleted)
        #expect(deletedTaskID == original.id)
    }

    @Test("Completion policy distinguishes never-pushed and merged-by-content branches")
    func completionPolicyBranches() throws {
        let original = try task(status: .reviewByUser, worktreePath: "/tmp/worktree")
        let project = try project()
        let neverPushed = try branchStatus(ahead: 2, unpushed: -1)
        let merged = try branchStatus(ahead: 2, unpushed: 0, mergedByContent: true)

        let warning = try #require(
            TaskInfoCompletionPolicy.confirmation(
                task: original,
                project: project,
                newStatus: .completed,
                branchStatus: neverPushed
            )
        )
        #expect(warning.message.contains("2 commit(s) never pushed — will be lost"))
        #expect(
            TaskInfoCompletionPolicy.confirmation(
                task: original,
                project: project,
                newStatus: .completed,
                branchStatus: merged
            ) == nil
        )
    }

    @Test("Agent completion policy preserves approval and keep-session copy")
    func agentCompletionPolicy() throws {
        let request: AgentCompletionRequestedPush = try decodeTaskInfoFixture(
            """
            {
              "requestId":"request-1","taskId":"task-1","projectId":"project-1",
              "taskTitle":"Native app","taskOverview":"Ready for review"
            }
            """
        )

        let confirmation = TaskInfoCompletionPolicy.agentCompletionConfirmation(request: request)

        #expect(confirmation.kind == .agentCompletion(requestID: "request-1"))
        #expect(confirmation.title == "Agent requests completion")
        #expect(confirmation.confirmTitle == "Complete task")
        #expect(confirmation.cancelTitle == "Keep session")
        #expect(confirmation.message.contains("Approving will destroy the worktree and terminal session."))
    }
}

private actor TaskInfoServiceDouble: TaskInfoServicing {
    struct MoveCall: Equatable, Sendable {
        let status: Dev3TaskStatus
        let force: Bool
    }

    enum Call: Equatable, Sendable {
        case rename(String?)
        case overview(String)
        case priority(Dev3TaskPriority)
        case watched(Bool)
        case labels([String])
        case addNote(String)
        case updateNote(id: String, content: String)
        case deleteNote(String)
        case delete
        case customColumn(String)
        case refreshPR
    }

    private let response: Dev3Task
    private let branch: Dev3BranchStatus
    private let failFirstMove: Bool
    private let failBranch: Bool
    private var didFailMove = false
    private var moves: [MoveCall] = []
    private var calls: [Call] = []
    private var renameResponses: [Dev3Task] = []
    private var priorityResponses: [Dev3Task] = []

    init(
        response: Dev3Task,
        branch: Dev3BranchStatus,
        failFirstMove: Bool = false,
        failBranch: Bool = false
    ) {
        self.response = response
        self.branch = branch
        self.failFirstMove = failFirstMove
        self.failBranch = failBranch
    }

    func setRenameResponses(_ responses: [Dev3Task]) {
        renameResponses = responses
    }

    func setPriorityResponses(_ responses: [Dev3Task]) {
        priorityResponses = responses
    }

    func moveCalls() -> [MoveCall] {
        moves
    }

    func allCalls() -> [Call] {
        calls
    }

    func renameTask(taskID _: String, projectID _: String, customTitle: String?) throws -> Dev3Task {
        calls.append(.rename(customTitle))
        return renameResponses.isEmpty ? response : renameResponses.removeFirst()
    }

    func moveTask(
        taskID _: String,
        projectID _: String,
        status: Dev3TaskStatus,
        force: Bool
    ) throws -> Dev3Task {
        moves.append(.init(status: status, force: force))
        if failFirstMove, !didFailMove {
            didFailMove = true
            throw TaskInfoTestError.failure
        }
        return response
    }

    func moveTaskToCustomColumn(
        taskID _: String,
        projectID _: String,
        customColumnID: String
    ) throws -> Dev3Task {
        calls.append(.customColumn(customColumnID))
        return response
    }

    func setPriority(
        taskID _: String,
        projectID _: String,
        priority: Dev3TaskPriority
    ) throws -> [Dev3Task] {
        calls.append(.priority(priority))
        return priorityResponses.isEmpty ? [response] : priorityResponses
    }

    func setWatched(taskID _: String, projectID _: String, watched: Bool) throws -> Dev3Task {
        calls.append(.watched(watched))
        return response
    }

    func setLabels(taskID _: String, projectID _: String, labelIDs: [String]) throws -> Dev3Task {
        calls.append(.labels(labelIDs))
        return response
    }

    func setUserOverview(taskID _: String, projectID _: String, overview: String) throws -> Dev3Task {
        calls.append(.overview(overview))
        return renameResponses.isEmpty ? response : renameResponses.removeFirst()
    }

    func addNote(taskID _: String, projectID _: String, content: String) throws -> Dev3Task {
        calls.append(.addNote(content))
        return response
    }

    func updateNote(
        taskID _: String,
        projectID _: String,
        noteID: String,
        content: String
    ) throws -> Dev3Task {
        calls.append(.updateNote(id: noteID, content: content))
        return response
    }

    func deleteNote(taskID _: String, projectID _: String, noteID: String) throws -> Dev3Task {
        calls.append(.deleteNote(noteID))
        return response
    }

    func deleteTask(taskID _: String, projectID _: String) {
        calls.append(.delete)
    }

    func branchStatus(taskID _: String, projectID _: String) throws -> Dev3BranchStatus {
        if failBranch {
            throw TaskInfoTestError.failure
        }
        return branch
    }

    func refreshPRStatus(taskID _: String, projectID _: String) {
        calls.append(.refreshPR)
    }
}

private enum TaskInfoTestError: Error {
    case failure
}

@MainActor
private func makeStore(
    task: Dev3Task,
    service: TaskInfoServiceDouble,
    isConnected: Bool = true
) throws -> TaskInfoStore {
    try TaskInfoStore(
        task: task,
        project: project(),
        service: service,
        isConnected: isConnected
    )
}

private func project() throws -> Dev3Project {
    try decodeTaskInfoFixture(
        """
        {
          "id":"project-1","name":"Project","path":"/tmp/project",
          "setupScript":"","devScript":"","cleanupScript":"",
          "defaultBaseBranch":"main","createdAt":"2026-01-01T00:00:00Z",
          "labels":[{"id":"label-1","name":"Native","color":"#4496ff"}],
          "customColumns":[
            {"id":"custom-current","name":"Current","color":"#4496ff","llmInstruction":""},
            {"id":"custom-other","name":"Later","color":"#4496ff","llmInstruction":""}
          ]
        }
        """
    )
}

private func task(
    status: Dev3TaskStatus,
    worktreePath: String? = nil,
    customTitle: String? = nil,
    userOverview: String? = nil,
    priority: Dev3TaskPriority? = nil,
    customColumnID: String? = nil
) throws -> Dev3Task {
    var object: [String: Any] = [
        "id": "task-1",
        "seq": 1,
        "projectId": "project-1",
        "title": "Task title",
        "description": "Description",
        "overview": "Agent overview",
        "status": status.rawValue,
        "baseBranch": "main",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    ]
    object["worktreePath"] = worktreePath
    object["customTitle"] = customTitle
    object["userOverview"] = userOverview
    object["priority"] = priority?.rawValue
    object["customColumnId"] = customColumnID
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3Task.self, from: data)
}

private func branchStatus(
    ahead: Int = 0,
    insertions: Int = 0,
    deletions: Int = 0,
    unpushed: Int = 0,
    mergedByContent: Bool = false
) throws -> Dev3BranchStatus {
    try decodeTaskInfoFixture(
        """
        {
          "ahead":\(ahead),"behind":0,"canRebase":true,
          "insertions":\(insertions),"deletions":\(deletions),
          "unpushed":\(unpushed),"mergedByContent":\(mergedByContent),
          "diffFiles":0,"diffInsertions":0,"diffDeletions":0,"diffFileStats":[]
        }
        """
    )
}

private func decodeTaskInfoFixture<Value: Decodable>(_ json: String) throws -> Value {
    try JSONDecoder().decode(Value.self, from: Data(json.utf8))
}
