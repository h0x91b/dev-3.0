@testable import dev3
import Foundation
import Testing

@Suite("Local diff read persistence", .serialized)
struct TaskDiffReadStoreTests {
    @Test("Read signatures stay isolated by server and task")
    func scopeIsolation() async throws {
        let suite = "TaskDiffReadStoreTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = try #require(LocalTaskDiffReadStore(suiteName: suite))

        await store.setRead(true, signature: "file-a:v1", serverID: "server-a", taskID: "task-a")
        await store.setRead(true, signature: "file-b:v1", serverID: "server-a", taskID: "task-b")
        await store.setRead(true, signature: "file-c:v1", serverID: "server-b", taskID: "task-a")

        #expect(await store.readSignatures(serverID: "server-a", taskID: "task-a") == ["file-a:v1"])
        #expect(await store.readSignatures(serverID: "server-a", taskID: "task-b") == ["file-b:v1"])
        #expect(await store.readSignatures(serverID: "server-b", taskID: "task-a") == ["file-c:v1"])

        await store.setRead(false, signature: "file-a:v1", serverID: "server-a", taskID: "task-a")
        #expect(await store.readSignatures(serverID: "server-a", taskID: "task-a").isEmpty)
    }
}
