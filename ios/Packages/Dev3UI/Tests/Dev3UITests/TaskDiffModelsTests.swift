import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@Suite("Native diff review")
struct TaskDiffModelsTests {
    @Test("Modes preserve recent counts and backend request values")
    func modes() {
        #expect(TaskDiffModeSelection.uncommitted.mode == .uncommitted)
        #expect(TaskDiffModeSelection.branch.mode == .branch)
        #expect(TaskDiffModeSelection.unpushed.mode == .unpushed)
        #expect(TaskDiffModeSelection.recent(3).mode == .recent)
        #expect(TaskDiffModeSelection.recent(3).count == 3)
        #expect(TaskDiffModeSelection.recent(0).count == 1)
        #expect(TaskDiffModeSelection.recent(1).displayName == "Last commit")
        #expect(TaskDiffModeSelection.recentPresets == [1, 2, 3, 5, 10])
    }

    @Test("Real unified fixture ignores git metadata and trailing separators")
    func parsesRealUnifiedFixture() throws {
        let hunk = """
        diff --git a/src/example.ts b/src/example.ts
        index 2db047d..acd91de 100644
        --- a/src/example.ts
        +++ b/src/example.ts
        @@ -10,3 +10,4 @@ export function example() {
         const before = true;
        -return before;
        +const after = false;
        +
         }

        """
        let file = try makeDiffFile(hunks: [hunk])

        let lines = TaskDiffLineParser.lines(for: file)

        #expect(lines.count == 6)
        #expect(lines.first?.kind == .hunkHeader)
        #expect(lines.first?.text.hasPrefix("@@") == true)
        #expect(lines.contains { $0.text.hasPrefix("diff --git") } == false)
        #expect(lines.contains { $0.text.hasPrefix("---") } == false)
        #expect(lines[1].oldLineNumber == 10)
        #expect(lines[1].newLineNumber == 10)
        #expect(lines[2].kind == .deletion)
        #expect(lines[2].oldLineNumber == 11)
        #expect(lines[3].kind == .addition)
        #expect(lines[3].newLineNumber == 11)
        #expect(lines[4].kind == .addition)
        #expect(lines[4].text.isEmpty)
        #expect(lines.last?.text == "}")
    }

    @Test("Content-only added files do not render a phantom final line")
    func addedFileFallback() throws {
        let file = try makeDiffFile(
            status: "added",
            oldContent: "",
            newContent: "let one = 1\nlet two = 2\n",
            hunks: nil
        )

        let lines = TaskDiffLineParser.lines(for: file)

        #expect(lines.map(\.kind) == [.addition, .addition])
        #expect(lines.map(\.newLineNumber) == [1, 2])
        #expect(lines.map(\.text) == ["let one = 1", "let two = 2"])
    }

    @Test("Read identity is stable for unchanged content and invalidates stale content")
    func readSignatureTracksContent() throws {
        let first = try makeDiffFile(newContent: "export const version = 1;\n")
        let same = try makeDiffFile(newContent: "export const version = 1;\n")
        let changed = try makeDiffFile(newContent: "export const version = 2;\n")

        let firstSignature = TaskDiffReadSignature.make(taskID: "task", file: first)
        #expect(firstSignature == TaskDiffReadSignature.make(taskID: "task", file: same))
        #expect(firstSignature != TaskDiffReadSignature.make(taskID: "task", file: changed))
        #expect(
            TaskDiffReadSignature.make(taskID: "task-a", file: first)
                != TaskDiffReadSignature.make(taskID: "task-b", file: first)
        )
    }

    @Test("Native lexer highlights common Swift and TypeScript tokens without a web runtime")
    func syntaxHighlighting() {
        let swift = TaskDiffSyntaxHighlighter.fragments(
            in: "let count = 42 // result",
            path: "Feature.swift"
        )
        #expect(swift.contains(TaskDiffSyntaxFragment(text: "let", role: .keyword)))
        #expect(swift.contains(TaskDiffSyntaxFragment(text: "42", role: .number)))
        #expect(swift.last == TaskDiffSyntaxFragment(text: "// result", role: .comment))

        let typeScript = TaskDiffSyntaxHighlighter.fragments(
            in: "const title = `dev3`;",
            path: "feature.ts"
        )
        #expect(typeScript.contains(TaskDiffSyntaxFragment(text: "const", role: .keyword)))
        #expect(typeScript.contains(TaskDiffSyntaxFragment(text: "`dev3`", role: .string)))

        let json = TaskDiffSyntaxHighlighter.fragments(in: #""status": true"#, path: "task.json")
        #expect(json.contains(TaskDiffSyntaxFragment(text: #""status""#, role: .property)))
    }

    @Test("A 120-file fixture parses within the review-screen performance budget", .timeLimit(.minutes(1)))
    func largeDiffFixture() throws {
        let repeatedLines = (1 ... 80).map { " line \($0)" }.joined(separator: "\n")
        let hunk = "@@ -1,80 +1,81 @@\n\(repeatedLines)\n+new line\n"
        let files = try (0 ..< 120).map { index in
            try makeDiffFile(id: "file-\(index)", path: "Sources/File\(index).swift", hunks: [hunk])
        }

        let clock = ContinuousClock()
        var parsedLineCount = 0
        let elapsed = clock.measure {
            parsedLineCount = files.reduce(into: 0) { count, file in
                count += TaskDiffLineParser.lines(for: file).count
            }
        }

        #expect(files.count == 120)
        #expect(parsedLineCount == 120 * 82)
        #expect(elapsed < .seconds(5))
    }
}

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

private func makeDiffFile(
    id: String = "src/example.ts",
    path: String = "src/example.ts",
    status: String = "modified",
    oldContent: String = "export const version = 0;\n",
    newContent: String = "export const version = 1;\n",
    hunks: [String]? = ["@@ -1 +1 @@\n-export const version = 0;\n+export const version = 1;\n"]
) throws -> Dev3TaskDiffFile {
    var object: [String: Any] = [
        "id": id,
        "status": status,
        "displayPath": path,
        "oldPath": path,
        "newPath": path,
        "oldContent": oldContent,
        "newContent": newContent,
        "insertions": 1,
        "deletions": 1
    ]
    object["hunks"] = hunks
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3TaskDiffFile.self, from: data)
}

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
