@testable import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Task creation safety")
struct TaskCreationSafetyTests {
    @Test("Ambiguous launch refreshes once and cannot spawn twice")
    func ambiguousLaunchCannotRetry() async throws {
        let source = try taskFixture(id: "source", status: .todo)
        let service = try TaskCreationServiceDouble(
            created: source,
            reconciled: [source],
            failSpawn: true
        )
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) }
        )
        await store.load()

        _ = await store.submit(.saveAndStart)
        _ = await store.submit(.saveAndStart)

        #expect(await service.spawnCount() == 1)
        #expect(store.canSubmit == false)
        #expect(store.errorMessage?.contains("Inspect the refreshed board") == true)
    }

    @Test("Uncertain Save remains review-required and cannot create twice")
    func reconnectDuringMetadataCannotCreateTwice() async throws {
        let source = try taskFixture(id: "source", status: .todo)
        let service = try TaskCreationServiceDouble(created: source, pausesRename: true)
        var provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            selectedProjectID: "project-1",
            serviceProvider: { .init(provenance: provenance, service: service) }
        )
        await store.load()
        store.title = "Metadata delay"
        store.descriptionText = "Create exactly once"

        let submission = Task { await store.submit(.save) }
        await service.waitUntilRenameStarted()
        provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        await service.resumeRename()
        _ = await submission.value
        _ = await store.submit(.save)

        #expect(await service.createCount() == 1)
        #expect(store.hasUncertainMutation)
        #expect(store.canSubmit == false)
        #expect(store.errorMessage?.contains("task was created") == true)
        #expect(store.shouldDismissAfterSubmission(mode: .save, result: nil) == false)
    }

    @Test("Reconnect preserves valid watch and agent selections")
    func reconnectPreservesSelections() async throws {
        let source = try taskFixture(id: "source", status: .todo)
        let service = try TaskCreationServiceDouble(created: source)
        var provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            selectedProjectID: "project-1",
            serviceProvider: { .init(provenance: provenance, service: service) }
        )
        await store.load()
        let variantID = try #require(store.variants.first?.id)
        store.selectAgent("other", for: variantID)
        store.watched = true
        provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())

        await store.connectionChanged(to: provenance)

        #expect(store.watched)
        #expect(store.variants.first?.agentID == "other")
        #expect(store.variants.first?.configurationID == "manual")
    }

    @Test("Inactive tasks never route to a terminal", arguments: [
        Dev3TaskStatus.todo,
        .completed,
        .cancelled
    ])
    func inactiveTasksDoNotRoute(status: Dev3TaskStatus) async throws {
        let source = try taskFixture(id: "source-\(status.rawValue)", status: .todo)
        let preparing = try taskFixture(id: "variant", status: .inProgress, preparing: true)
        let service = try TaskCreationServiceDouble(created: source, spawned: [preparing])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var terminalTaskID: String?
        var events: [TaskCreationEvent] = []
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) },
            onEvent: { events.append($0) },
            onTerminalReady: { _, taskID, _ in terminalTaskID = taskID }
        )
        await store.load()
        _ = await store.submit(.saveAndStart)
        let inactive = makeIATask(
            id: "variant",
            status: status,
            preparing: false,
            worktreePath: "/tmp/variant"
        )

        store.receiveTaskUpdate(inactive, provenance: provenance)

        #expect(terminalTaskID == nil)
        #expect(store.pendingTerminalTaskID == nil)
        #expect(events.last == .launchUnavailable(
            inactive,
            provenance: provenance,
            message: "The task is no longer active, so its terminal was not opened."
        ))
    }

    @Test("Shutting-down tasks never route to a terminal")
    func shuttingDownTaskDoesNotRoute() async throws {
        let source = try taskFixture(id: "source-shutdown", status: .todo)
        let preparing = try taskFixture(id: "variant", status: .inProgress, preparing: true)
        let service = try TaskCreationServiceDouble(created: source, spawned: [preparing])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var terminalTaskID: String?
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) },
            onTerminalReady: { _, taskID, _ in terminalTaskID = taskID }
        )
        await store.load()
        _ = await store.submit(.saveAndStart)
        let shuttingDown = makeIATask(
            id: "variant",
            preparing: false,
            worktreePath: "/tmp/variant",
            shuttingDown: true
        )
        store.receiveTaskUpdate(shuttingDown, provenance: provenance)

        #expect(terminalTaskID == nil)
        #expect(store.pendingTerminalTaskID == nil)
        #expect(store.errorMessage?.contains("shutting down") == true)
    }

    @Test("Explicit preparation failure without a worktree releases pending launch")
    func preparationEndedWithoutWorktree() async throws {
        let source = try taskFixture(id: "source", status: .todo)
        let preparing = try taskFixture(id: "variant", status: .inProgress, preparing: true)
        let service = try TaskCreationServiceDouble(created: source, spawned: [preparing])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var events: [TaskCreationEvent] = []
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) },
            onEvent: { events.append($0) }
        )
        await store.load()
        _ = await store.submit(.saveAndStart)
        let failed = makeIATask(id: "variant", preparing: false)

        store.receiveTaskUpdate(failed, provenance: provenance)

        #expect(store.pendingTerminalTaskID == nil)
        #expect(store.errorMessage == "Task preparation ended before its terminal became available.")
        #expect(events.last == .launchUnavailable(
            failed,
            provenance: provenance,
            message: "Task preparation ended before its terminal became available."
        ))
    }
}
