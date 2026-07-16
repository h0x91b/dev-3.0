import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@Suite("Native pull request status")
struct TaskPRStatusModelsTests {
    @Test("Mergeability mirrors the web summary for GitHub states")
    func mergeability() throws {
        #expect(try detail(mergeable: "MERGEABLE", status: "CLEAN").mergeability == .mergeable)
        #expect(
            try detail(mergeable: "CONFLICTING", status: "DIRTY").mergeability
                == .notMergeable(.conflict)
        )
        #expect(try detail(mergeable: "MERGEABLE", status: "BLOCKED").mergeability == .notMergeable(.blocked))
        #expect(try detail(mergeable: nil, status: "BEHIND").mergeability == .notMergeable(.behind))
        #expect(try detail(mergeable: nil, status: "DRAFT").mergeability == .notMergeable(.draft))
        #expect(try detail(mergeable: nil, status: "UNSTABLE").mergeability == .notMergeable(.unstable))
        #expect(try detail(mergeable: nil, status: "HAS_HOOKS").mergeability == .notMergeable(.hooks))
        #expect(try detail(mergeable: "UNKNOWN", status: "UNKNOWN").mergeability == .unknown)
    }

    @Test("Check verdicts match desktop and sort failures before pending and success")
    func checkRollup() throws {
        let status = try makePRDetail(
            checks: [
                check(name: "passed", status: "COMPLETED", conclusion: "SUCCESS"),
                check(name: "unknown", status: nil, conclusion: nil),
                check(name: "running", status: "IN_PROGRESS", conclusion: nil),
                check(name: "failed", status: "COMPLETED", conclusion: "TIMED_OUT"),
                check(name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL")
            ]
        )

        #expect(TaskPRCheckState(check: status.checks[0]) == .success)
        #expect(TaskPRCheckState(check: status.checks[1]) == .unknown)
        #expect(TaskPRCheckState(check: status.checks[2]) == .pending)
        #expect(TaskPRCheckState(check: status.checks[3]) == .failure)
        #expect(TaskPRCheckState(check: status.checks[4]) == .success)
        #expect(status.sortedChecks.map(\.name) == ["failed", "running", "passed", "neutral", "unknown"])
    }

    @Test("Merge blockers explain conflicts, reviews, threads, failed checks, and pending checks")
    func blockerDetails() throws {
        let status = try makePRDetail(
            mergeable: "CONFLICTING",
            mergeStatus: "DIRTY",
            reviewDecision: "changes_requested",
            unresolvedCount: 2,
            checks: [
                check(name: "build", status: "COMPLETED", conclusion: "FAILURE"),
                check(name: "build", status: "COMPLETED", conclusion: "FAILURE"),
                check(name: "lint", status: "QUEUED", conclusion: nil)
            ]
        )

        #expect(status.mergeBlockers == [
            .mergeState(.conflict),
            .unresolvedThreads(2),
            .changesRequested,
            .failedChecks(["build"]),
            .pendingChecks(["lint"])
        ])
    }

    @Test("Generic blocked merge state remains visible when no detailed blocker is available")
    func genericBlocker() throws {
        let status = try makePRDetail(mergeable: "MERGEABLE", mergeStatus: "BLOCKED")
        #expect(status.mergeBlockers == [.mergeState(.blocked)])
    }

    @Test("External links allow HTTP origins and reject unsafe or credentialed URLs")
    func safeURLs() {
        #expect(Dev3SafeExternalURL.parse("https://github.com/h0x91b/dev-3.0/pull/969") != nil)
        #expect(Dev3SafeExternalURL.parse("http://localhost:3000/check") != nil)
        #expect(Dev3SafeExternalURL.parse("javascript:alert(1)") == nil)
        #expect(Dev3SafeExternalURL.parse("file:///tmp/token") == nil)
        #expect(Dev3SafeExternalURL.parse("https://user:secret@example.com/check") == nil)
        #expect(Dev3SafeExternalURL.parse("https:///missing-host") == nil)
    }

    private func detail(mergeable: String?, status: String?) throws -> TaskPRStatusDetail {
        try makePRDetail(mergeable: mergeable, mergeStatus: status)
    }
}

@Suite("Native pull request status store")
@MainActor
struct TaskPRStatusStoreTests {
    @Test("Matching live push replaces cached status and unrelated pushes are ignored")
    func pushReducer() throws {
        let task = try makePRTask()
        let service = RecordingPRStatusService()
        let store = TaskPRStatusStore(task: task, isConnected: true, service: service)
        let matching = try makePRPush(number: 42, title: "Native review", ciStatus: "success")
        let unrelated = try makePRPush(taskID: "other", number: 99, title: "Other", ciStatus: "failure")

        store.receive(.taskPRStatus(unrelated))
        #expect(store.detail?.number == 12)
        store.receive(.taskPRStatus(matching))

        #expect(store.detail?.number == 42)
        #expect(store.detail?.title == "Native review")
        #expect(store.detail?.ciStatus == "success")
    }

    @Test("Refresh is deduplicated and routes the exact task and project")
    func refresh() async throws {
        let service = RecordingPRStatusService()
        let store = try TaskPRStatusStore(
            task: makePRTask(),
            isConnected: true,
            service: service
        )

        await store.refresh()

        #expect(await service.calls() == [PRRefreshCall(taskID: "task", projectID: "project")])
        #expect(store.errorMessage == nil)
        #expect(!store.isRefreshing)
    }

    @Test("Disconnect rejects a suspended refresh failure")
    func disconnectRejectsFailure() async throws {
        let service = SuspendedPRStatusService()
        let store = try TaskPRStatusStore(
            task: makePRTask(),
            isConnected: true,
            service: service
        )
        let refresh = Task { await store.refresh() }
        while await !(service.hasStarted()) {
            await Task.yield()
        }

        store.setConnected(false)
        await service.fail(PRTestFailure())
        await refresh.value

        #expect(!store.isRefreshing)
        #expect(store.errorMessage == nil)
        #expect(store.detail?.number == 12)
    }

    @Test("Cancellation clears the refresh spinner without publishing an error")
    func cancellation() async throws {
        let store = try TaskPRStatusStore(
            task: makePRTask(),
            isConnected: true,
            service: CancelledPRStatusService()
        )

        await store.refresh()

        #expect(!store.isRefreshing)
        #expect(store.errorMessage == nil)
    }
}

private struct PRRefreshCall: Equatable, Sendable {
    let taskID: String
    let projectID: String
}

private actor RecordingPRStatusService: TaskPRStatusServicing {
    private var recorded: [PRRefreshCall] = []

    func refreshPRStatus(taskID: String, projectID: String) {
        recorded.append(PRRefreshCall(taskID: taskID, projectID: projectID))
    }

    func calls() -> [PRRefreshCall] {
        recorded
    }
}

private actor SuspendedPRStatusService: TaskPRStatusServicing {
    private var continuation: CheckedContinuation<Void, any Error>?
    private var started = false

    func refreshPRStatus(taskID _: String, projectID _: String) async throws {
        started = true
        try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func hasStarted() -> Bool {
        started
    }

    func fail(_ error: any Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private struct CancelledPRStatusService: TaskPRStatusServicing {
    func refreshPRStatus(taskID _: String, projectID _: String) async throws {
        throw CancellationError()
    }
}

private struct PRTestFailure: Error {}

private func makePRTask() throws -> Dev3Task {
    let object: [String: Any] = [
        "id": "task",
        "seq": 12,
        "projectId": "project",
        "title": "Native PR status",
        "description": "Description",
        "status": "review-by-colleague",
        "baseBranch": "main",
        "prNumber": 12,
        "prUrl": "https://github.com/example/repo/pull/12",
        "createdAt": "2026-07-16T00:00:00Z",
        "updatedAt": "2026-07-16T00:00:00Z"
    ]
    return try decodePRFixture(object)
}

private func makePRPush(
    projectID: String = "project",
    taskID: String = "task",
    number: Int = 12,
    title: String? = "Native PR status",
    ciStatus: String? = "pending",
    mergeable: String? = "MERGEABLE",
    mergeStatus: String? = "CLEAN",
    reviewDecision: String? = "review_required",
    unresolvedCount: Int? = 0,
    checks: [[String: Any?]] = []
) throws -> TaskPRStatusPush {
    var object: [String: Any] = [
        "projectId": projectID,
        "taskId": taskID,
        "prNumber": number,
        "prUrl": "https://github.com/example/repo/pull/\(number)",
        "checks": checks.map(compactPRObject)
    ]
    object["prTitle"] = title
    object["ciStatus"] = ciStatus
    object["reviewDecision"] = reviewDecision
    object["unresolvedCount"] = unresolvedCount
    object["mergeState"] = compactPRObject([
        "mergeable": mergeable,
        "status": mergeStatus,
        "state": "OPEN"
    ])
    return try decodePRFixture(object)
}

private func makePRDetail(
    mergeable: String? = "MERGEABLE",
    mergeStatus: String? = "CLEAN",
    reviewDecision: String? = nil,
    unresolvedCount: Int? = 0,
    checks: [[String: Any?]] = []
) throws -> TaskPRStatusDetail {
    let push = try makePRPush(
        mergeable: mergeable,
        mergeStatus: mergeStatus,
        reviewDecision: reviewDecision,
        unresolvedCount: unresolvedCount,
        checks: checks
    )
    return try #require(TaskPRStatusDetail(push: push))
}

private func check(
    name: String,
    status: String?,
    conclusion: String?,
    detailsURL: String? = nil
) -> [String: Any?] {
    [
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "detailsUrl": detailsURL
    ]
}

private func compactPRObject(_ object: [String: Any?]) -> [String: Any] {
    object.reduce(into: [:]) { result, entry in
        result[entry.key] = entry.value ?? NSNull()
    }
}

private func decodePRFixture<Value: Decodable>(_ object: [String: Any]) throws -> Value {
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Value.self, from: data)
}
