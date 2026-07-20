import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@Suite("Native diff store")
@MainActor
struct TaskDiffStoreTests {
    @Test("Mode, count, and compare ref switching send exact backend requests")
    func requestSwitching() async throws {
        let response = try makeTaskDiff()
        let service = RecordingTaskDiffService(response: response)
        let reads = MemoryTaskDiffReadStore()
        let store = makeStore(service: service, reads: reads)

        await store.load()
        await store.select(.branch)
        await store.updateCompareRef("release/next")
        await store.select(.recent(5))

        let requests = await service.recordedRequests()
        #expect(requests[0] == DiffRequest(mode: .uncommitted, compareRef: nil, count: nil))
        #expect(requests[1] == DiffRequest(mode: .branch, compareRef: "origin/main", count: nil))
        #expect(requests[2] == DiffRequest(mode: .branch, compareRef: "release/next", count: nil))
        #expect(requests[3] == DiffRequest(mode: .recent, compareRef: nil, count: 5))
    }

    @Test("A cached diff renders instantly and refreshes in the background")
    func cachedDiffRendersWhileRevalidating() async throws {
        let cache = TaskDiffCache()
        try cache.set(
            makeTaskDiff(),
            for: TaskDiffCache.Key(
                serverID: "server-1",
                projectID: "project",
                taskID: "task",
                mode: .uncommitted,
                compareRef: nil,
                count: nil
            )
        )
        let service = SuspendedTaskDiffService()
        let store = TaskDiffStore(
            serverID: "server-1",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: service,
            readPersistence: MemoryTaskDiffReadStore(),
            cache: cache
        )

        let load = Task { await store.load() }
        await waitUntilStarted(service)

        // Cached payload is visible before the fetch resolves: content, no spinner.
        #expect(store.payload != nil)
        #expect(store.phase == .content)
        #expect(!store.isLoading)
        #expect(store.isRefreshing)

        try await service.succeed(makeTaskDiff())
        await load.value
        #expect(!store.isRefreshing)
        #expect(store.phase == .content)
    }

    @Test("A shared cache warms a second store and clears per server")
    func sharedCacheWarmsAcrossStoresAndClears() async throws {
        let cache = TaskDiffCache()
        let reads = MemoryTaskDiffReadStore()
        let seed = try RecordingTaskDiffService(response: makeTaskDiff())
        let first = TaskDiffStore(
            serverID: "server-1",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: seed,
            readPersistence: reads,
            cache: cache
        )
        await first.load()
        #expect(first.payload != nil)

        // A brand-new store (as if reopened from Task Info → Changes) shares the cache.
        let suspended = SuspendedTaskDiffService()
        let second = TaskDiffStore(
            serverID: "server-1",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: suspended,
            readPersistence: reads,
            cache: cache
        )
        let secondLoad = Task { await second.load() }
        await waitUntilStarted(suspended)
        #expect(second.payload != nil)
        #expect(second.phase == .content)
        try await suspended.succeed(makeTaskDiff())
        await secondLoad.value

        // Switching server evicts the entry; a fresh store cold-loads.
        cache.clear(serverID: "server-1")
        let afterClear = SuspendedTaskDiffService()
        let third = TaskDiffStore(
            serverID: "server-1",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: afterClear,
            readPersistence: reads,
            cache: cache
        )
        let thirdLoad = Task { await third.load() }
        await waitUntilStarted(afterClear)
        #expect(third.payload == nil)
        #expect(third.phase == .loading)
        try await afterClear.succeed(makeTaskDiff())
        await thirdLoad.value
    }

    @Test("Read state is scoped and survives a fresh store")
    func persistentReadState() async throws {
        let response = try makeTaskDiff()
        let service = RecordingTaskDiffService(response: response)
        let reads = MemoryTaskDiffReadStore()
        let first = makeStore(service: service, reads: reads)

        await first.load()
        let file = try #require(first.sortedFiles.first)
        await first.toggleRead(file)
        #expect(first.isRead(file))

        let reopened = makeStore(service: service, reads: reads)
        await reopened.load()
        #expect(reopened.isRead(file))

        let otherServer = TaskDiffStore(
            serverID: "server-2",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: service,
            readPersistence: reads
        )
        await otherServer.load()
        #expect(!otherServer.isRead(file))
    }

    @Test("Disconnect rejects a suspended success and preserves honest offline phase")
    func disconnectRejectsSuccess() async throws {
        let service = SuspendedTaskDiffService()
        let store = makeStore(service: service, reads: MemoryTaskDiffReadStore())
        let load = Task { await store.load() }
        await waitUntilStarted(service)

        store.setConnected(false)
        try await service.succeed(makeTaskDiff())
        await load.value

        #expect(store.payload == nil)
        #expect(store.phase == .offline)
        #expect(!store.isLoading)
        #expect(store.errorMessage == nil)
    }

    @Test("Disconnect rejects a suspended failure without publishing an error")
    func disconnectRejectsFailure() async {
        let service = SuspendedTaskDiffService()
        let store = makeStore(service: service, reads: MemoryTaskDiffReadStore())
        let load = Task { await store.load() }
        await waitUntilStarted(service)

        store.setConnected(false)
        await service.fail(TestFailure())
        await load.value

        #expect(store.payload == nil)
        #expect(store.phase == .offline)
        #expect(store.errorMessage == nil)
    }

    @Test("Cancellation clears loading and offline mode controls preserve the cached selection")
    func cancellationAndOfflineSelection() async {
        let store = makeStore(service: CancelledTaskDiffService(), reads: MemoryTaskDiffReadStore())

        await store.load()
        #expect(!store.isLoading)
        #expect(store.errorMessage == nil)

        store.setConnected(false)
        await store.select(.branch)
        await store.updateCompareRef("release/next")
        #expect(store.selection == .uncommitted)
        #expect(store.compareRef == "origin/main")
    }

    @Test("Disconnect while read state is loading never starts a stale diff request")
    func disconnectDuringReadLoad() async {
        let service = CountingTaskDiffService()
        let reads = SuspendedTaskDiffReadStore()
        let store = makeStore(service: service, reads: reads)
        let load = Task { await store.load() }
        while await !(reads.hasStarted()) {
            await Task.yield()
        }

        store.setConnected(false)
        await reads.resume()
        await load.value

        #expect(await service.callCount() == 0)
        #expect(store.phase == .offline)
    }

    private func makeStore(
        service: any TaskDiffServicing,
        reads: any TaskDiffReadPersisting
    ) -> TaskDiffStore {
        TaskDiffStore(
            serverID: "server-1",
            projectID: "project",
            taskID: "task",
            compareRef: "origin/main",
            isConnected: true,
            service: service,
            readPersistence: reads
        )
    }

    private func waitUntilStarted(_ service: SuspendedTaskDiffService) async {
        while await !(service.hasStarted()) {
            await Task.yield()
        }
    }
}

private struct DiffRequest: Equatable, Sendable {
    let mode: Dev3TaskDiffMode
    let compareRef: String?
    let count: Int?
}

private actor RecordingTaskDiffService: TaskDiffServicing {
    private let response: Dev3TaskDiff
    private var requests: [DiffRequest] = []

    init(response: Dev3TaskDiff) {
        self.response = response
    }

    func taskDiff(_ request: TaskDiffFetchRequest) -> Dev3TaskDiff {
        requests.append(
            DiffRequest(mode: request.mode, compareRef: request.compareRef, count: request.count)
        )
        return response
    }

    func recordedRequests() -> [DiffRequest] {
        requests
    }
}

private actor SuspendedTaskDiffService: TaskDiffServicing {
    private var continuation: CheckedContinuation<Dev3TaskDiff, any Error>?
    private var started = false

    func taskDiff(_: TaskDiffFetchRequest) async throws -> Dev3TaskDiff {
        started = true
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func hasStarted() -> Bool {
        started
    }

    func succeed(_ response: Dev3TaskDiff) {
        continuation?.resume(returning: response)
        continuation = nil
    }

    func fail(_ error: any Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private struct CancelledTaskDiffService: TaskDiffServicing {
    func taskDiff(_: TaskDiffFetchRequest) async throws -> Dev3TaskDiff {
        throw CancellationError()
    }
}

private actor CountingTaskDiffService: TaskDiffServicing {
    private var count = 0

    func taskDiff(_: TaskDiffFetchRequest) async throws -> Dev3TaskDiff {
        count += 1
        throw TestFailure()
    }

    func callCount() -> Int {
        count
    }
}

private actor MemoryTaskDiffReadStore: TaskDiffReadPersisting {
    private var values: [String: Set<String>] = [:]

    func readSignatures(serverID: String, taskID: String) -> Set<String> {
        values["\(serverID):\(taskID)"] ?? []
    }

    func setRead(
        _ isRead: Bool,
        signature: String,
        serverID: String,
        taskID: String
    ) {
        let scope = "\(serverID):\(taskID)"
        if isRead {
            values[scope, default: []].insert(signature)
        } else {
            values[scope]?.remove(signature)
        }
    }
}

private actor SuspendedTaskDiffReadStore: TaskDiffReadPersisting {
    private var continuation: CheckedContinuation<Set<String>, Never>?
    private var started = false

    func readSignatures(serverID _: String, taskID _: String) async -> Set<String> {
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func setRead(_: Bool, signature _: String, serverID _: String, taskID _: String) {}

    func hasStarted() -> Bool {
        started
    }

    func resume() {
        continuation?.resume(returning: [])
        continuation = nil
    }
}

private struct TestFailure: Error {}

private func makeTaskDiff() throws -> Dev3TaskDiff {
    let object: [String: Any] = [
        "mode": "uncommitted",
        "compareRef": NSNull(),
        "compareLabel": "HEAD",
        "fallbackReason": NSNull(),
        "recentCount": NSNull(),
        "summary": ["files": 1, "insertions": 1, "deletions": 1],
        "files": [[
            "id": "src/example.ts",
            "status": "modified",
            "displayPath": "src/example.ts",
            "oldPath": "src/example.ts",
            "newPath": "src/example.ts",
            "oldContent": "export const version = 0;\n",
            "newContent": "export const version = 1;\n",
            "hunks": ["@@ -1 +1 @@\n-export const version = 0;\n+export const version = 1;\n"],
            "insertions": 1,
            "deletions": 1
        ]],
        "skippedFiles": []
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3TaskDiff.self, from: data)
}
