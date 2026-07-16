@testable import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Task creation coordinator")
struct TaskCreationCoordinatorTests {
    @Test("Work and project entry points preserve their intended selection")
    func presentationContext() throws {
        let fixture = try CoordinatorFixture()

        fixture.coordinator.presentCreate()
        #expect(fixture.coordinator.creationStore?.selectedProjectID == nil)
        fixture.coordinator.cancelPresentation()

        fixture.coordinator.presentCreate(projectID: fixture.project.id)
        #expect(fixture.coordinator.creationStore?.selectedProjectID == fixture.project.id)
        fixture.coordinator.cancelPresentation()

        let todo = makeIATask(id: "todo", status: .todo)
        fixture.coordinator.presentRun(task: todo)
        #expect(fixture.coordinator.creationStore?.context == .launchExisting(todo))
    }

    @Test("Project snapshot changes refresh an open form")
    func projectReplacement() async throws {
        let fixture = try CoordinatorFixture()
        fixture.coordinator.presentCreate(projectID: fixture.project.id)
        let updated = makeIAProject(id: fixture.project.id, name: "Renamed project")

        await fixture.coordinator.synchronize(
            projects: [updated],
            tasksByProject: [:],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )

        #expect(fixture.coordinator.creationStore?.projects.map(\.name) == ["Renamed project"])
    }

    @Test("Dismissed preparation persists until a current snapshot is terminal-ready")
    func pendingPreparationPersists() async throws {
        let preparing = makeIATask(id: "variant", preparing: true)
        let fixture = try CoordinatorFixture(spawned: [preparing])
        let source = makeIATask(id: "todo", status: .todo)

        fixture.coordinator.presentRun(task: source)
        let store = try #require(fixture.coordinator.creationStore)
        await store.load()
        _ = await store.submit(.saveAndStart)
        fixture.coordinator.submissionCompleted(for: store)

        #expect(fixture.coordinator.isPresented == false)
        #expect(fixture.coordinator.creationStore === store)
        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [preparing]],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )
        #expect(fixture.terminalRoutes.isEmpty)
        #expect(fixture.coordinator.creationStore === store)

        let ready = makeIATask(
            id: "variant",
            preparing: false,
            worktreePath: "/tmp/variant"
        )
        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [ready]],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )

        #expect(fixture.terminalRoutes.map(\.taskID) == ["variant"])
        #expect(fixture.coordinator.creationStore == nil)
    }

    @Test("Immediate readiness surfaces metadata warnings exactly once")
    func immediateReadinessPresentsWarningsOnce() async throws {
        let ready = makeIATask(
            id: "variant",
            preparing: false,
            worktreePath: "/tmp/variant"
        )
        let fixture = try CoordinatorFixture(spawned: [ready], failRename: true)
        fixture.coordinator.presentCreate(projectID: fixture.project.id)
        let store = try #require(fixture.coordinator.creationStore)
        await store.load()
        store.title = "Custom title"
        store.descriptionText = "Build the native flow"

        _ = await store.submit(.saveAndStart)
        fixture.coordinator.submissionCompleted(for: store)

        #expect(fixture.warningBatches == [[
            "The task was created, but its title could not be updated."
        ]])
        #expect(fixture.terminalRoutes.map(\.taskID) == ["variant"])
        #expect(fixture.coordinator.creationStore == nil)
    }

    @Test("Same-server reconnect rebinds pending work and rejects stale snapshots")
    func reconnectRebindsPendingWork() async throws {
        let preparing = makeIATask(id: "variant", preparing: true)
        let fixture = try CoordinatorFixture(spawned: [preparing])
        let source = makeIATask(id: "todo", status: .todo)
        fixture.coordinator.presentRun(task: source)
        let store = try #require(fixture.coordinator.creationStore)
        await store.load()
        _ = await store.submit(.saveAndStart)
        fixture.coordinator.submissionCompleted(for: store)

        let oldProvenance = fixture.binding.provenance
        fixture.binding = TaskCreationServiceBinding(
            provenance: TaskCreationProvenance(
                serverID: oldProvenance.serverID,
                rpcGeneration: UUID()
            ),
            service: fixture.service
        )
        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [preparing]],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )
        let ready = makeIATask(
            id: "variant",
            preparing: false,
            worktreePath: "/tmp/variant"
        )
        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [ready]],
            activeServerID: oldProvenance.serverID,
            provenance: oldProvenance
        )
        #expect(fixture.terminalRoutes.isEmpty)

        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [ready]],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )
        #expect(fixture.terminalRoutes.map(\.provenance) == [fixture.binding.provenance])
    }

    @Test("Cancel and re-entry cannot orphan an in-flight launch")
    func cancellationDuringSubmitIsGuarded() async throws {
        let preparing = makeIATask(id: "variant", preparing: true)
        let service = try CoordinatorServiceDouble(spawned: [preparing], pausesSpawn: true)
        let fixture = try CoordinatorFixture(service: service)
        fixture.coordinator.presentRun(task: makeIATask(id: "todo", status: .todo))
        let store = try #require(fixture.coordinator.creationStore)
        await store.load()

        let submission = Task { await store.submit(.saveAndStart) }
        await service.waitUntilSpawnStarted()
        fixture.coordinator.cancelPresentation()
        fixture.coordinator.presentCreate(projectID: fixture.project.id)

        #expect(fixture.coordinator.isPresented)
        #expect(fixture.coordinator.creationStore === store)
        await service.resumeSpawn()
        _ = await submission.value
        fixture.coordinator.submissionCompleted(for: store)
        #expect(fixture.coordinator.creationStore === store)
        #expect(store.pendingTerminalTaskID == "variant")
    }

    @Test("Changing servers discards pending preparation without routing")
    func serverChangeDiscardsPendingWork() async throws {
        let preparing = makeIATask(id: "variant", preparing: true)
        let fixture = try CoordinatorFixture(spawned: [preparing])
        fixture.coordinator.presentRun(task: makeIATask(id: "todo", status: .todo))
        let store = try #require(fixture.coordinator.creationStore)
        await store.load()
        _ = await store.submit(.saveAndStart)
        fixture.coordinator.submissionCompleted(for: store)

        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: [preparing]],
            activeServerID: "other-server",
            provenance: nil
        )

        #expect(fixture.coordinator.creationStore == nil)
        #expect(fixture.terminalRoutes.isEmpty)

        fixture.binding = TaskCreationServiceBinding(
            provenance: TaskCreationProvenance(serverID: "other-server", rpcGeneration: UUID()),
            service: fixture.service
        )
        fixture.coordinator.presentCreate(projectID: fixture.project.id)
        let replacementStore = try #require(fixture.coordinator.creationStore)
        fixture.coordinator.submissionCompleted(for: store)
        #expect(fixture.coordinator.isPresented)
        #expect(fixture.coordinator.creationStore === replacementStore)
    }

    @Test("Missing pending task releases lifecycle and allows a fresh form")
    func missingPendingTaskReleasesStore() async throws {
        let preparing = makeIATask(id: "variant", preparing: true)
        let fixture = try CoordinatorFixture(spawned: [preparing])
        fixture.coordinator.presentRun(task: makeIATask(id: "todo", status: .todo))
        let pendingStore = try #require(fixture.coordinator.creationStore)
        await pendingStore.load()
        _ = await pendingStore.submit(.saveAndStart)
        fixture.coordinator.submissionCompleted(for: pendingStore)

        await fixture.coordinator.synchronize(
            projects: [fixture.project],
            tasksByProject: [fixture.project.id: []],
            activeServerID: fixture.binding.provenance.serverID,
            provenance: fixture.binding.provenance
        )
        #expect(fixture.coordinator.creationStore == nil)

        fixture.coordinator.presentCreate()
        #expect(fixture.coordinator.creationStore !== pendingStore)
        #expect(fixture.coordinator.creationStore?.context == .create)
    }

    @Test("Task creation warnings remain visible alongside an existing error")
    func warningsMergeWithExistingError() {
        let store = AppStore(runtime: ConnectionRuntime())
        store.toast = AppToast(message: "Existing failure.", level: .error)

        store.presentTaskCreationWarnings(["The title could not be updated."])

        #expect(store.toast?.level == .error)
        #expect(store.toast?.message == "Existing failure. The title could not be updated.")
    }
}

@MainActor
private final class CoordinatorFixture {
    let project = makeIAProject()
    let service: CoordinatorServiceDouble
    var binding: TaskCreationServiceBinding
    var warningBatches: [[String]] = []
    var terminalRoutes: [CoordinatorTerminalRoute] = []
    lazy var coordinator = TaskCreationCoordinator(
        projectsProvider: { [weak self] in
            self.map { [$0.project] } ?? []
        },
        serviceProvider: { [weak self] in self?.binding },
        onEvent: { _ in },
        onWarning: { [weak self] in self?.warningBatches.append($0) },
        onTerminalReady: { [weak self] projectID, taskID, provenance in
            self?.terminalRoutes.append(
                CoordinatorTerminalRoute(
                    projectID: projectID,
                    taskID: taskID,
                    provenance: provenance
                )
            )
        }
    )

    init(
        spawned: [Dev3Task] = [],
        failRename: Bool = false,
        service: CoordinatorServiceDouble? = nil
    ) throws {
        let resolvedService: CoordinatorServiceDouble = if let service {
            service
        } else {
            try CoordinatorServiceDouble(
                spawned: spawned,
                failRename: failRename
            )
        }
        self.service = resolvedService
        binding = TaskCreationServiceBinding(
            provenance: TaskCreationProvenance(serverID: "server", rpcGeneration: UUID()),
            service: resolvedService
        )
    }
}

private struct CoordinatorTerminalRoute: Equatable {
    let projectID: String
    let taskID: String
    let provenance: TaskCreationProvenance
}

private struct CoordinatorTestError: Error {}

private actor CoordinatorServiceDouble: TaskCreationServicing {
    private let agents: [Dev3CodingAgent]
    private let settings: Dev3GlobalSettings
    private let created: Dev3Task
    private let spawned: [Dev3Task]
    private let failRename: Bool
    private let pausesSpawn: Bool
    private var spawnStarted = false
    private var spawnContinuation: CheckedContinuation<Void, Never>?

    init(
        spawned: [Dev3Task],
        failRename: Bool = false,
        pausesSpawn: Bool = false
    ) throws {
        agents = try coordinatorDecode(
            """
            [{"id":"codex","name":"Codex","baseCommand":"codex","isDefault":true,
              "configurations":[{"id":"safe","name":"Safe","requiresPxpipeProxy":false}]}]
            """
        )
        settings = try coordinatorDecode(
            """
            {"defaultAgentId":"codex","defaultConfigId":"safe","taskDropPosition":"top",
             "updateChannel":"stable","watchByDefault":false,"pxpipeProxyEnabled":false}
            """
        )
        created = makeIATask(id: "source", status: .todo, watched: false)
        self.spawned = spawned
        self.failRename = failRename
        self.pausesSpawn = pausesSpawn
    }

    func getAgents() -> [Dev3CodingAgent] {
        agents
    }

    func getGlobalSettings() -> Dev3GlobalSettings {
        settings
    }

    func createTask(
        projectID _: String,
        description _: String,
        priority _: Dev3TaskPriority
    ) -> Dev3Task {
        created
    }

    func renameTask(
        taskID _: String,
        projectID _: String,
        customTitle _: String
    ) throws -> Dev3Task {
        if failRename {
            throw CoordinatorTestError()
        }
        return created
    }

    func setTaskLabels(
        taskID _: String,
        projectID _: String,
        labelIDs _: [String]
    ) -> Dev3Task {
        created
    }

    func setTaskWatched(
        taskID _: String,
        projectID _: String,
        watched _: Bool
    ) -> Dev3Task {
        created
    }

    func spawnVariants(
        taskID _: String,
        projectID _: String,
        variants _: [Dev3LaunchVariant]
    ) async -> [Dev3Task] {
        if pausesSpawn {
            spawnStarted = true
            await withCheckedContinuation { continuation in
                spawnContinuation = continuation
            }
        }
        return spawned
    }

    func getTasks(projectID _: String) -> [Dev3Task] {
        []
    }

    func waitUntilSpawnStarted() async {
        while !spawnStarted {
            await Task.yield()
        }
    }

    func resumeSpawn() {
        spawnContinuation?.resume()
        spawnContinuation = nil
    }
}

private func coordinatorDecode<Value: Decodable>(_ json: String) throws -> Value {
    try JSONDecoder().decode(Value.self, from: Data(json.utf8))
}
