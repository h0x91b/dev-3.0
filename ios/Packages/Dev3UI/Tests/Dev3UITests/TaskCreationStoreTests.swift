@testable import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Task creation store")
struct TaskCreationStoreTests {
    @Test("Create mode preserves an intentionally empty project selection")
    func workCreationHasNoProjectPreselection() {
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            serviceProvider: { nil }
        )

        #expect(store.selectedProjectID == nil)
        #expect(store.canSubmit == false)
    }

    @Test("Required description state and accessibility share the trimmed value")
    func requiredDescriptionSemantics() {
        let project = makeIAProject()
        let store = TaskCreationStore(
            projects: [project],
            selectedProjectID: project.id,
            serviceProvider: { nil }
        )

        store.descriptionText = "  \n  "
        #expect(store.trimmedDescription.isEmpty)
        #expect(store.isDescriptionMissing)
        #expect(store.canSubmit == false)
        #expect(TaskCreationDescriptionSemantics.visibleLabel == "Description (required)")
        #expect(TaskCreationDescriptionSemantics.emptyPrompt == "Describe the work to be done.")
        #expect(TaskCreationDescriptionSemantics.accessibilityLabel == "Description, required")
        #expect(TaskCreationDescriptionSemantics.accessibilityValue(
            trimmedDescription: store.trimmedDescription
        ) == "Empty")
        #expect(TaskCreationDescriptionSemantics.accessibilityHint.contains("Save & Start"))

        store.descriptionText = "  Build the native flow. \n"
        #expect(store.trimmedDescription == "Build the native flow.")
        #expect(store.isDescriptionMissing == false)
        #expect(store.canSubmit)
        #expect(TaskCreationDescriptionSemantics.accessibilityValue(
            trimmedDescription: store.trimmedDescription
        ) == "Build the native flow.")
    }

    @Test("Defaults skip gated configurations and stale favorites")
    func defaultsAndFavorites() throws {
        let agents = try agentFixtures()
        let settings = try settingsFixture(
            pxpipeEnabled: false,
            favorites: [
                ["agentId": "missing", "configId": "gone", "uses": 99, "lastUsedAt": 10],
                ["agentId": "codex", "configId": "proxy", "uses": 7, "lastUsedAt": 20],
                ["agentId": "codex", "configId": "safe", "uses": 6, "lastUsedAt": 30],
                ["agentId": "codex", "configId": "safe", "uses": 1, "lastUsedAt": 40]
            ]
        )

        let variant = TaskCreationAgentResolver.defaultVariant(agents: agents, settings: settings)
        let favorites = TaskCreationAgentResolver.favoriteOptions(agents: agents, settings: settings)

        #expect(variant.agentID == "codex")
        #expect(variant.configurationID == "safe")
        #expect(favorites.map(\.configurationID) == ["proxy", "safe"])
        #expect(favorites.map(\.isEnabled) == [false, true])
    }

    @Test("Creation publishes immediately and metadata failures do not block launch")
    // swiftlint:disable:next function_body_length
    func creationAndLaunchTransaction() async throws {
        let created = try taskFixture(id: "source", status: .todo, watched: false)
        let labeled = try taskFixture(id: "source", status: .todo, watched: false, labelIDs: ["native"])
        let watched = try taskFixture(id: "source", status: .todo, watched: true, labelIDs: ["native"])
        let preparing = try taskFixture(
            id: "variant-1",
            status: .inProgress,
            preparing: true,
            agentID: "codex",
            configurationID: "safe"
        )
        let service = try TaskCreationServiceDouble(
            created: created,
            renamed: created,
            labeled: labeled,
            watched: watched,
            spawned: [preparing],
            failRename: true
        )
        let project = makeIAProject(labels: [["id": "native", "name": "Native", "color": "#4496ff"]])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var events: [TaskCreationEvent] = []
        var terminalTaskID: String?
        let store = TaskCreationStore(
            projects: [project],
            selectedProjectID: project.id,
            serviceProvider: { .init(provenance: provenance, service: service) },
            onEvent: { events.append($0) },
            onTerminalReady: { _, taskID, _ in terminalTaskID = taskID }
        )
        await store.load()
        store.title = "Native title"
        store.descriptionText = "Build it"
        store.selectedLabelIDs = ["native"]
        store.watched = true

        let result = await store.submit(.saveAndStart)

        #expect(result?.sourceTaskID == "source")
        #expect(events.count == 4)
        #expect(events.first == .created(created, provenance: provenance))
        #expect(try events.last == .replaced(#require(result)))
        #expect(store.warningMessages == ["The task was created, but its title could not be updated."])
        #expect(terminalTaskID == nil)
        #expect(store.pendingTerminalTaskID == "variant-1")
        #expect(
            await service.calls() == [
                .getAgents,
                .getSettings,
                .create(projectID: "project-1", description: "Build it", priority: .p3),
                .rename(taskID: "source", title: "Native title"),
                .labels(taskID: "source", ids: ["native"]),
                .watch(taskID: "source", watched: true),
                .spawn(taskID: "source", variants: [.init(agentId: "codex", configId: "safe")])
            ]
        )

        let ready = try taskFixture(
            id: "variant-1",
            status: .inProgress,
            worktreePath: "/tmp/worktree",
            preparing: false,
            agentID: "codex",
            configurationID: "safe"
        )
        store.receiveTaskUpdate(ready, provenance: provenance)
        #expect(terminalTaskID == "variant-1")
        #expect(store.pendingTerminalTaskID == nil)
    }

    @Test("Existing Todo launch never creates a duplicate task")
    func existingTodoLaunch() async throws {
        let source = try taskFixture(id: "todo-1", status: .todo, watched: true)
        let ready = try taskFixture(
            id: "variant-1",
            status: .inProgress,
            worktreePath: "/tmp/worktree",
            preparing: false
        )
        let service = try TaskCreationServiceDouble(created: source, spawned: [ready])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var terminalTaskID: String?
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) },
            onTerminalReady: { _, taskID, _ in terminalTaskID = taskID }
        )
        await store.load()

        let result = await store.submit(.saveAndStart)

        #expect(result?.sourceTaskID == "todo-1")
        #expect(terminalTaskID == "variant-1")
        let calls = await service.calls()
        #expect(!calls.contains {
            if case .create = $0 {
                true
            } else {
                false
            }
        })
        #expect(calls.contains {
            if case .spawn(taskID: "todo-1", _) = $0 {
                true
            } else {
                false
            }
        })
    }

    @Test("Ambiguous creation refreshes the board and never retries")
    func ambiguousCreateReconciles() async throws {
        let source = try taskFixture(id: "source", status: .todo)
        let service = try TaskCreationServiceDouble(
            created: source,
            reconciled: [source],
            failCreate: true
        )
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var events: [TaskCreationEvent] = []
        let store = TaskCreationStore(
            projects: [makeIAProject()],
            selectedProjectID: "project-1",
            serviceProvider: { .init(provenance: provenance, service: service) },
            onEvent: { events.append($0) }
        )
        await store.load()
        store.descriptionText = "May have succeeded"

        _ = await store.submit(.save)
        _ = await store.submit(.save)

        #expect(await service.createCount() == 1)
        #expect(store.canSubmit == false)
        #expect(events == [.reconciled(projectID: "project-1", tasks: [source], provenance: provenance)])
        #expect(store.errorMessage?.contains("Inspect the refreshed board") == true)
    }

    @Test("Virtual projects launch exactly one variant and preparation errors stop navigation")
    func virtualProjectAndPreparationFailure() async throws {
        let source = try taskFixture(id: "todo", status: .todo)
        let preparing = try taskFixture(id: "variant", status: .inProgress, preparing: true)
        let service = try TaskCreationServiceDouble(created: source, spawned: [preparing])
        let provenance = TaskCreationProvenance(serverID: "server", rpcGeneration: UUID())
        var terminalTaskID: String?
        var events: [TaskCreationEvent] = []
        let store = TaskCreationStore(
            projects: [makeIAProject(kind: .virtual)],
            context: .launchExisting(source),
            serviceProvider: { .init(provenance: provenance, service: service) },
            onEvent: { events.append($0) },
            onTerminalReady: { _, taskID, _ in terminalTaskID = taskID }
        )
        await store.load()
        store.addVariant()
        #expect(store.variants.count == 1)

        _ = await store.submit(.saveAndStart)
        let failed = try taskFixture(
            id: "variant",
            status: .inProgress,
            preparing: false,
            preparationError: "clone failed"
        )
        store.receiveTaskUpdate(failed, provenance: provenance)

        #expect(terminalTaskID == nil)
        #expect(store.pendingTerminalTaskID == nil)
        #expect(store.errorMessage == "Task preparation failed: clone failed")
        #expect(events.last == .preparationFailed(failed, provenance: provenance))
    }
}

enum TaskCreationCall: Equatable, Sendable {
    case getAgents
    case getSettings
    case create(projectID: String, description: String, priority: Dev3TaskPriority)
    case rename(taskID: String, title: String)
    case labels(taskID: String, ids: [String])
    case watch(taskID: String, watched: Bool)
    case spawn(taskID: String, variants: [Dev3LaunchVariant])
    case getTasks
}

private struct TaskCreationTestError: Error {}

actor TaskCreationServiceDouble: TaskCreationServicing {
    private var recordedCalls: [TaskCreationCall] = []
    private let agents: [Dev3CodingAgent]
    private let settings: Dev3GlobalSettings
    private let created: Dev3Task
    private let renamed: Dev3Task
    private let labeled: Dev3Task
    private let watched: Dev3Task
    private let spawned: [Dev3Task]
    private let reconciled: [Dev3Task]
    private let failCreate: Bool
    private let failRename: Bool
    private let failSpawn: Bool
    private let pausesRename: Bool
    private var renameStarted = false
    private var renameContinuation: CheckedContinuation<Void, Never>?

    init(
        created: Dev3Task,
        renamed: Dev3Task? = nil,
        labeled: Dev3Task? = nil,
        watched: Dev3Task? = nil,
        spawned: [Dev3Task] = [],
        reconciled: [Dev3Task] = [],
        failCreate: Bool = false,
        failRename: Bool = false,
        failSpawn: Bool = false,
        pausesRename: Bool = false
    ) throws {
        agents = try agentFixtures()
        settings = try settingsFixture(pxpipeEnabled: false)
        self.created = created
        self.renamed = renamed ?? created
        self.labeled = labeled ?? created
        self.watched = watched ?? created
        self.spawned = spawned
        self.reconciled = reconciled
        self.failCreate = failCreate
        self.failRename = failRename
        self.failSpawn = failSpawn
        self.pausesRename = pausesRename
    }

    func calls() -> [TaskCreationCall] {
        recordedCalls
    }

    func createCount() -> Int {
        recordedCalls.count {
            if case .create = $0 {
                true
            } else {
                false
            }
        }
    }

    func spawnCount() -> Int {
        recordedCalls.count {
            if case .spawn = $0 {
                true
            } else {
                false
            }
        }
    }

    func waitUntilRenameStarted() async {
        while !renameStarted {
            await Task.yield()
        }
    }

    func resumeRename() {
        renameContinuation?.resume()
        renameContinuation = nil
    }

    func getAgents() throws -> [Dev3CodingAgent] {
        recordedCalls.append(.getAgents)
        return agents
    }

    func getGlobalSettings() throws -> Dev3GlobalSettings {
        recordedCalls.append(.getSettings)
        return settings
    }

    func createTask(
        projectID: String,
        description: String,
        priority: Dev3TaskPriority
    ) throws -> Dev3Task {
        recordedCalls.append(.create(projectID: projectID, description: description, priority: priority))
        if failCreate {
            throw TaskCreationTestError()
        }
        return created
    }

    func renameTask(
        taskID: String,
        projectID _: String,
        customTitle: String
    ) async throws -> Dev3Task {
        recordedCalls.append(.rename(taskID: taskID, title: customTitle))
        if pausesRename {
            renameStarted = true
            await withCheckedContinuation { continuation in
                renameContinuation = continuation
            }
        }
        if failRename {
            throw TaskCreationTestError()
        }
        return renamed
    }

    func setTaskLabels(taskID: String, projectID _: String, labelIDs: [String]) -> Dev3Task {
        recordedCalls.append(.labels(taskID: taskID, ids: labelIDs))
        return labeled
    }

    func setTaskWatched(taskID: String, projectID _: String, watched: Bool) -> Dev3Task {
        recordedCalls.append(.watch(taskID: taskID, watched: watched))
        return self.watched
    }

    func spawnVariants(
        taskID: String,
        projectID _: String,
        variants: [Dev3LaunchVariant]
    ) throws -> [Dev3Task] {
        recordedCalls.append(.spawn(taskID: taskID, variants: variants))
        if failSpawn {
            throw TaskCreationTestError()
        }
        return spawned
    }

    func getTasks(projectID _: String) -> [Dev3Task] {
        recordedCalls.append(.getTasks)
        return reconciled
    }
}

private func agentFixtures() throws -> [Dev3CodingAgent] {
    try decodeTaskCreationFixture(
        """
        [
          {"id":"codex","name":"Codex","baseCommand":"codex","isDefault":true,
           "defaultConfigId":"proxy","configurations":[
             {"id":"proxy","name":"Proxy","requiresPxpipeProxy":true},
             {"id":"safe","name":"Safe","requiresPxpipeProxy":false}
           ]},
          {"id":"other","name":"Other","baseCommand":"other","configurations":[
            {"id":"manual","name":"Manual","requiresPxpipeProxy":false}
          ]}
        ]
        """
    )
}

private func settingsFixture(
    pxpipeEnabled: Bool,
    favorites: [[String: Any]] = []
) throws -> Dev3GlobalSettings {
    let object: [String: Any] = [
        "defaultAgentId": "codex",
        "defaultConfigId": "proxy",
        "taskDropPosition": "top",
        "updateChannel": "stable",
        "watchByDefault": false,
        "pxpipeProxyEnabled": pxpipeEnabled,
        "favorites": favorites
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3GlobalSettings.self, from: data)
}

func taskFixture(
    id: String,
    status: Dev3TaskStatus,
    worktreePath: String? = nil,
    preparing: Bool? = nil,
    preparationError: String? = nil,
    watched: Bool? = nil,
    labelIDs: [String]? = nil,
    agentID: String? = nil,
    configurationID: String? = nil
) throws -> Dev3Task {
    var object: [String: Any] = [
        "id": id,
        "seq": 1,
        "projectId": "project-1",
        "title": "Task \(id)",
        "description": "Description",
        "status": status.rawValue,
        "baseBranch": "main",
        "createdAt": "2026-07-16T10:00:00Z",
        "updatedAt": "2026-07-16T10:00:00Z"
    ]
    object["worktreePath"] = worktreePath
    object["preparing"] = preparing
    object["preparationError"] = preparationError
    object["watched"] = watched
    object["labelIds"] = labelIDs
    object["agentId"] = agentID
    object["configId"] = configurationID
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3Task.self, from: data)
}

private func decodeTaskCreationFixture<Value: Decodable>(_ json: String) throws -> Value {
    try JSONDecoder().decode(Value.self, from: Data(json.utf8))
}
