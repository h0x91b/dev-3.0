import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

// This intentionally exhaustive state-machine suite keeps its fixtures beside the scenarios.
// swiftlint:disable file_length

@MainActor
@Suite("App store", .serialized)
// swiftlint:disable type_body_length
struct AppStoreTests {
    @Test("Snapshot refetch and every typed state push reduce deterministically")
    func snapshotReducer() throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let beta = try project(id: "project-b", name: "beta")
        let deleted = try project(id: "project-z", name: "Deleted", deleted: true)
        let first = try task(id: "task-1", projectId: alpha.id, seq: 2, title: "First")
        let second = try task(id: "task-2", projectId: alpha.id, seq: 1, title: "Second")
        var snapshot = AppStoreSnapshot()

        try snapshot.replace(
            projects: [beta, deleted, alpha],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [first, second])]
        )

        #expect(snapshot.projects.map(\.id) == [alpha.id, beta.id])
        #expect(snapshot.tasksByProject[alpha.id]?.map(\.id) == [second.id, first.id])

        let updated = try task(id: first.id, projectId: alpha.id, seq: 3, title: "Updated")
        _ = try snapshot.reduce(.taskUpdated(decode("""
        {"projectId":"project-a","task":\(encoded(updated))}
        """)))
        #expect(snapshot.tasksByProject[alpha.id]?.map(\.id) == [second.id, first.id])
        #expect(snapshot.tasksByProject[alpha.id]?.last?.title == "Updated")
    }

    @Test("Ancillary pushes reduce and project removal clears task state")
    func ancillaryPushReducer() throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let beta = try project(id: "project-b", name: "beta")
        let first = try task(id: "task-1", projectId: alpha.id, seq: 1, title: "First")
        var snapshot = AppStoreSnapshot()
        try snapshot.replace(
            projects: [alpha, beta],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [first])]
        )

        let prStatus: TaskPRStatusPush = try decode("""
        {"projectId":"project-a","taskId":"task-1","prNumber":969,"checks":[]}
        """)
        let clipboard: OSC52ClipboardPush = try decode("""
        {"taskId":"task-1","text":"copied","len":6}
        """)
        let attention: CLIAttentionPush = try decode("""
        {"taskId":"task-1","reason":"Review requested"}
        """)
        _ = snapshot.reduce(.taskPRStatus(prStatus))
        _ = snapshot.reduce(.osc52Clipboard(clipboard))
        _ = snapshot.reduce(.cliAttention(attention))
        #expect(snapshot.prStatusByTask[first.id] == prStatus)
        #expect(snapshot.clipboardByTask[first.id] == clipboard)
        #expect(snapshot.attentionByTask[first.id] == "Review requested")

        _ = try snapshot.reduce(.taskRemoved(decode("""
        {"projectId":"project-a","taskId":"task-1"}
        """)))
        #expect(snapshot.tasksByProject[alpha.id]?.isEmpty == true)
        #expect(snapshot.prStatusByTask[first.id] == nil)
        #expect(snapshot.clipboardByTask[first.id] == nil)
        #expect(snapshot.attentionByTask[first.id] == nil)

        let toast = try snapshot.reduce(.cliToast(decode("""
        {"message":"Done","level":"success"}
        """)))
        #expect(toast?.message == "Done")
        #expect(toast?.level == .success)
        let notification = try snapshot.reduce(.webNotification(decode("""
        {"taskId":"task-2","projectId":"project-a","title":"Agent","body":"Needs you","level":"info"}
        """)))
        #expect(notification?.message == "Needs you")

        _ = try snapshot.reduce(.projectUpdated(decode("""
        {"project":\(encoded(project(id: alpha.id, name: "Alpha", deleted: true)))}
        """)))
        #expect(snapshot.projects.map(\.id) == [beta.id])
        #expect(snapshot.tasksByProject[alpha.id] == nil)
    }

    @Test("One RPC stream consumer fans pushes out and every opened event refetches")
    func refetchAndFanout() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let first = try task(id: "task-1", projectId: alpha.id, seq: 1, title: "First")
        let rpc = try StoreRPC(
            projects: [alpha],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [first])]
        )
        let store = AppStore(
            controller: makeController(),
            rpc: rpc,
            pingIntervalNanoseconds: 10_000_000
        )
        var firstObserverEvents: [RPCPushEvent] = []
        var secondObserverEvents: [RPCPushEvent] = []
        store.addPushObserver { firstObserverEvents.append($0) }
        store.addPushObserver { secondObserverEvents.append($0) }

        await store.start()
        #expect(rpc.pushStreamReadCount == 1)
        #expect(rpc.connectionStreamReadCount == 1)

        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()
        #expect(rpc.projectFetchCount == 1)
        #expect(rpc.taskFetchCount == 1)
        #expect(store.projects == [alpha])
        #expect(store.tasksByProject[alpha.id] == [first])
        #expect(store.isInitialLoading == false)

        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()
        #expect(rpc.projectFetchCount == 2)
        #expect(rpc.taskFetchCount == 2)

        rpc.emitConnection(.opened(requiresRefetch: false))
        await settle()
        #expect(rpc.projectFetchCount == 3)
        #expect(rpc.taskFetchCount == 3)

        let clipboard = try decode(OSC52ClipboardPush.self, """
        {"taskId":"task-1","text":"hello","len":5}
        """)
        rpc.emitPush(.osc52Clipboard(clipboard))
        await settle()
        #expect(store.clipboardByTask[first.id] == clipboard)
        #expect(firstObserverEvents == [.osc52Clipboard(clipboard)])
        #expect(secondObserverEvents == [.osc52Clipboard(clipboard)])
        #expect(rpc.pushStreamReadCount == 1)
    }

    @Test("Refresh failure and disconnect retain cached data")
    func cachedDataSurvivesFailure() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let first = try task(id: "task-1", projectId: alpha.id, seq: 1, title: "First")
        let rpc = try StoreRPC(
            projects: [alpha],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [first])]
        )
        let store = AppStore(controller: makeController(), rpc: rpc)
        await store.start()
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()

        rpc.failNextProjectFetch()
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()
        rpc.emitConnection(.failed("offline"))
        await settle()

        #expect(store.projects == [alpha])
        #expect(store.tasksByProject[alpha.id] == [first])
        #expect(store.lastSyncError != nil)
        #expect(store.banner == .reconnecting)
    }

    @Test("Loaded boards refetch on every reconnect and retain full cached history on failure")
    func loadedBoardReconnects() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let active = try task(
            id: "active",
            projectId: alpha.id,
            seq: 1,
            title: "Active",
            status: .inProgress
        )
        let completed = try task(
            id: "completed",
            projectId: alpha.id,
            seq: 2,
            title: "Completed",
            status: .completed
        )
        let rpc = try StoreRPC(
            projects: [alpha],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [active])]
        )
        rpc.setBoardTasks([active, completed], projectID: alpha.id)
        rpc.setGlobalDropPosition("bottom")
        let store = AppStore(controller: makeController(), rpc: rpc)
        await store.start()
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()

        await store.refreshProject(alpha.id)
        #expect(store.tasksByProject[alpha.id]?.map(\.id) == [active.id, completed.id])
        #expect(store.taskDropPosition == .bottom)

        rpc.failNextBoardFetch(projectID: alpha.id)
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()

        #expect(rpc.boardFetchCountByProject[alpha.id] == 2)
        #expect(store.tasksByProject[alpha.id]?.map(\.id) == [active.id, completed.id])
    }

    @Test("Stale refetch cannot erase remembered board IDs after RPC replacement")
    func staleRefetchKeepsRememberedBoards() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let oldRPC = StoreRPC(projects: [], projectTasks: [])
        let newRPC = StoreRPC(projects: [alpha], projectTasks: [])
        let store = AppStore(controller: makeController(), rpc: oldRPC)
        await store.start()
        store.loadedBoardProjectIDs = [alpha.id]
        oldRPC.suspendNextProjectFetch()
        let generation = store.rpcGeneration
        let staleRefetch = Task {
            await store.refetch(using: oldRPC, generation: generation)
        }
        await settle()

        store.attach(newRPC)
        oldRPC.resumeProjectFetch()
        await staleRefetch.value

        #expect(store.loadedBoardProjectIDs == [alpha.id])
    }

    @Test("Old RPC activity cannot mutate state under a newly selected server identity")
    // swiftlint:disable:next function_body_length
    func staleRefetchCannotCrossServerIdentity() async throws {
        let secureStore = StoreMemorySecureData()
        let pairedStore = PairedServerStore(secureStore: secureStore)
        let serverA = try pairedServer(id: "server-a", name: "Server A", port: 4001)
        let serverB = try pairedServer(id: "server-b", name: "Server B", port: 4002)
        try await pairedStore.upsert(serverB, makeActive: false)
        try await pairedStore.upsert(serverA)
        let oldProject = try project(id: "old-project", name: "Old")
        let oldRPC = StoreRPC(projects: [oldProject], projectTasks: [])
        oldRPC.setGlobalDropPosition("bottom")
        let controller = makeController(pairedServerStore: pairedStore)
        let store = AppStore(controller: controller, rpc: nil)
        await store.start()
        #expect(controller.activeServer?.instanceId == serverA.instanceId)
        store.attach(oldRPC)
        oldRPC.emitConnection(.opened(requiresRefetch: true))
        await settle()
        #expect(store.projects == [oldProject])
        #expect(store.snapshotServerID == serverA.instanceId)
        oldRPC.failNextProjectFetch()
        oldRPC.emitConnection(.opened(requiresRefetch: true))
        await settle()
        let oldToast = try decode(CLIToastPush.self, #"{"message":"Server A","level":"success"}"#)
        oldRPC.emitPush(.cliToast(oldToast))
        store.setTerminalFocused(true)
        await settle()
        #expect(store.toast?.message == "Server A")
        #expect(store.lastSyncError != nil)
        #expect(store.lastPush == .cliToast(oldToast))
        #expect(store.taskDropPosition == .bottom)
        store.handleSessionState(.connecting)
        #expect(store.projects == [oldProject])
        #expect(store.toast?.message == "Server A")
        #expect(store.lastSyncError != nil)
        #expect(store.lastPush == .cliToast(oldToast))
        #expect(store.taskDropPosition == .bottom)

        oldRPC.suspendNextProjectFetch()
        let generation = store.rpcGeneration
        let staleRefetch = Task {
            await store.refetch(
                using: oldRPC,
                generation: generation,
                sourceServerID: serverA.instanceId
            )
        }
        await settle()

        await controller.connect(to: serverB)
        await settle()
        #expect(controller.activeServer?.instanceId == serverB.instanceId)
        #expect(store.projects.isEmpty)
        #expect(store.snapshotServerID == nil)
        #expect(store.isInitialLoading)
        #expect(store.toast == nil)
        #expect(store.lastSyncError == nil)
        #expect(store.lastPush == nil)
        #expect(store.taskDropPosition == .top)
        let newRPC = StoreRPC(projects: [], projectTasks: [])
        store.attach(newRPC)
        await settle()
        #expect(newRPC.terminalFocusCalls.last == false)
        let staleTask = try task(
            id: "stale-task",
            projectId: oldProject.id,
            seq: 1,
            title: "Stale"
        )
        let staleUpdate = try decode(TaskUpdatedPush.self, """
        {"projectId":"\(oldProject.id)","task":\(encoded(staleTask))}
        """)
        let bannerBeforeOldEvents = store.banner
        let wasOpenBeforeOldEvents = store.rpcIsOpen
        oldRPC.emitPush(.taskUpdated(staleUpdate))
        oldRPC.emitConnection(.opened(requiresRefetch: true))
        oldRPC.emitConnection(.failed("old failure"))
        await settle()

        #expect(store.lastPush == nil)
        #expect(store.tasksByProject[oldProject.id] == nil)
        #expect(store.banner == bannerBeforeOldEvents)
        #expect(store.rpcIsOpen == wasOpenBeforeOldEvents)
        oldRPC.resumeProjectFetch()
        await staleRefetch.value

        #expect(store.projects.isEmpty)
        #expect(store.snapshotServerID == nil)
        #expect(store.refetchRevision == 1)
    }

    @Test("A pre-refetch push is stamped and cleared when the active server changes")
    func preRefetchPushCannotLeakAcrossServers() async throws {
        let pairedStore = PairedServerStore(secureStore: StoreMemorySecureData())
        let serverA = try pairedServer(id: "server-a", name: "Server A", port: 4001)
        let serverB = try pairedServer(id: "server-b", name: "Server B", port: 4002)
        try await pairedStore.upsert(serverB, makeActive: false)
        try await pairedStore.upsert(serverA)
        let task = try task(id: "early-task", projectId: "project-a", seq: 1, title: "Early")
        let update = try decode(TaskUpdatedPush.self, """
        {"projectId":"project-a","task":\(encoded(task))}
        """)
        let rpc = StoreRPC(projects: [], projectTasks: [])
        let controller = makeController(pairedServerStore: pairedStore)
        let store = AppStore(controller: controller, rpc: nil)
        await store.start()
        store.attach(rpc)

        rpc.emitPush(.taskUpdated(update))
        await settle()
        #expect(store.snapshotServerID == serverA.instanceId)
        #expect(store.task(projectId: task.projectId, taskId: task.id) == task)

        await controller.connect(to: serverB)
        await settle()
        #expect(store.snapshotServerID == nil)
        #expect(store.tasksByProject.isEmpty)
    }

    @Test("In-flight board refresh and mutation cannot publish after a server switch")
    func staleWorkCannotCrossServerIdentity() async throws {
        let pairedStore = PairedServerStore(secureStore: StoreMemorySecureData())
        let serverA = try pairedServer(id: "server-a", name: "Server A", port: 4001)
        let serverB = try pairedServer(id: "server-b", name: "Server B", port: 4002)
        try await pairedStore.upsert(serverB, makeActive: false)
        try await pairedStore.upsert(serverA)
        let project = try project(id: "project-a", name: "Alpha")
        let original = try task(id: "task-a", projectId: project.id, seq: 1, title: "Original")
        let stale = try task(id: original.id, projectId: project.id, seq: 1, title: "Stale result")
        let rpc = try StoreRPC(
            projects: [project],
            projectTasks: [projectTasks(projectId: project.id, tasks: [original])]
        )
        let controller = makeController(pairedServerStore: pairedStore)
        let store = AppStore(controller: controller, rpc: nil)
        await store.start()
        controller.stop()
        store.attach(rpc)
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()
        #expect(store.isConnected)

        rpc.setBoardTasks([stale], projectID: project.id)
        rpc.setMutationResult(stale)
        rpc.suspendNextBoardFetch(projectID: project.id)
        rpc.suspendNextMove()
        async let refresh: Void = store.refreshProject(project.id)
        async let mutation: Void = store.moveTask(original, to: .inProgress)
        await settle()

        await controller.connect(to: serverB)
        await settle()
        #expect(store.isConnected == false)
        rpc.resumeBoardFetch(projectID: project.id)
        rpc.resumeMove()
        await refresh
        await mutation

        #expect(store.task(projectId: project.id, taskId: original.id) == nil)
        #expect(store.lastSyncError == nil)
        #expect(store.toast == nil)
    }

    @Test("Live actions apply server responses and route every RPC")
    func liveActions() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let original = try task(id: "task-1", projectId: alpha.id, seq: 1, title: "Original")
        let updated = try task(id: original.id, projectId: alpha.id, seq: 1, title: "Server response")
        let rpc = try StoreRPC(
            projects: [alpha],
            projectTasks: [projectTasks(projectId: alpha.id, tasks: [original])]
        )
        rpc.setMutationResult(updated)
        rpc.setBoardTasks([updated], projectID: alpha.id)
        let store = AppStore(controller: makeController(), rpc: rpc)
        await store.start()
        rpc.emitConnection(.opened(requiresRefetch: true))
        await settle()

        await store.moveTask(original, to: .reviewByUser)
        await store.setTaskPriority(original, priority: .p0)
        await store.toggleTaskWatch(original)
        await store.moveTask(original, toCustomColumn: "custom")
        await store.pullProjectMain(alpha.id)

        #expect(rpc.moveCalls.last?.taskID == original.id)
        #expect(rpc.moveCalls.last?.status == .reviewByUser)
        #expect(rpc.priorityCalls.last?.priority == .p0)
        #expect(rpc.watchCalls.last?.watched == true)
        #expect(rpc.customColumnCalls.last?.columnID == "custom")
        #expect(rpc.pullCalls == [alpha.id])
        #expect(store.task(projectId: alpha.id, taskId: original.id)?.title == "Server response")
        #expect(store.projectPullStates[alpha.id] == .succeeded("Updated"))
    }

    @Test("Clipboard fanout is live-only and removes observers after every terminal closes")
    func clipboardStreamLifecycle() async throws {
        let rpc = StoreRPC(projects: [], projectTasks: [])
        let store = AppStore(controller: makeController(), rpc: rpc)
        await store.start()
        let historical = try decode(OSC52ClipboardPush.self, """
        {"taskId":"task-1","text":"historical","len":10}
        """)
        rpc.emitPush(.osc52Clipboard(historical))
        await settle()

        var firstValues: [String] = []
        let firstConsumer = Task {
            for await value in store.clipboardStream(for: "task-1") {
                firstValues.append(value)
                break
            }
        }
        await settle()
        #expect(store.pushObserverCount == 1)
        #expect(firstValues.isEmpty)
        let firstLive = try decode(OSC52ClipboardPush.self, """
        {"taskId":"task-1","text":"first","len":5}
        """)
        rpc.emitPush(.osc52Clipboard(firstLive))
        await firstConsumer.value
        await settle()
        #expect(firstValues == ["first"])
        #expect(store.pushObserverCount == 0)

        var reopenedValues: [String] = []
        let reopenedConsumer = Task {
            for await value in store.clipboardStream(for: "task-1") {
                reopenedValues.append(value)
                break
            }
        }
        await settle()
        #expect(reopenedValues.isEmpty)
        let secondLive = try decode(OSC52ClipboardPush.self, """
        {"taskId":"task-1","text":"second","len":6}
        """)
        rpc.emitPush(.osc52Clipboard(secondLive))
        await reopenedConsumer.value
        await settle()
        #expect(reopenedValues == ["second"])
        #expect(store.pushObserverCount == 0)
        #expect(rpc.pushStreamReadCount == 1)
    }

    @Test("Offline task opening is gated and terminal route removal retains project boards")
    func offlineRoutesAndRemoval() {
        let store = AppStore(controller: makeController())
        store.openTask(projectId: "project-a", taskId: "task-1", from: .work)
        #expect(store.workPath.isEmpty)

        store.workPath = [.task(projectId: "project-a", taskId: "task-1")]
        store.projectsPath = [
            .project("project-a"),
            .task(projectId: "project-a", taskId: "task-1")
        ]
        store.removeTaskRoutes(projectId: "project-a", taskId: "task-1")

        #expect(store.workPath.isEmpty)
        #expect(store.projectsPath == [.project("project-a")])
    }

    @Test("Replacing and stopping RPC ownership rejects stale stream events")
    func replacementStopAndRestart() async throws {
        let alpha = try project(id: "project-a", name: "Alpha")
        let oldRPC = StoreRPC(projects: [alpha], projectTasks: [])
        let newRPC = StoreRPC(projects: [alpha], projectTasks: [])
        let store = AppStore(controller: makeController(), rpc: oldRPC)
        var routedEvents: [RPCPushEvent] = []
        store.addPushObserver { routedEvents.append($0) }
        await store.start()

        store.attach(newRPC)
        let stale = try decode(CLIAttentionPush.self, """
        {"taskId":"stale","reason":"Old client"}
        """)
        oldRPC.emitPush(.cliAttention(stale))
        let current = try decode(CLIAttentionPush.self, """
        {"taskId":"current","reason":"New client"}
        """)
        newRPC.emitPush(.cliAttention(current))
        await settle()
        #expect(store.attentionByTask["stale"] == nil)
        #expect(store.attentionByTask["current"] == "New client")
        #expect(routedEvents == [.cliAttention(current)])

        store.stop()
        let stopped = try decode(CLIAttentionPush.self, """
        {"taskId":"stopped","reason":"Must be ignored"}
        """)
        newRPC.emitPush(.cliAttention(stopped))
        await settle()
        #expect(store.attentionByTask["stopped"] == nil)
        #expect(newRPC.terminalFocusCalls.last == false)
        #expect(newRPC.foregroundCalls.last == false)

        await store.start()
        #expect(oldRPC.pushStreamReadCount == 2)
        let restartedRPC = StoreRPC(projects: [alpha], projectTasks: [])
        store.attach(restartedRPC)
        let restarted = try decode(CLIAttentionPush.self, """
        {"taskId":"restarted","reason":"Exactly once"}
        """)
        restartedRPC.emitPush(.cliAttention(restarted))
        await settle()
        #expect(restartedRPC.pushStreamReadCount == 1)
        #expect(routedEvents.filter { $0 == .cliAttention(restarted) }.count == 1)
    }

    @Test("Scene, network, terminal, context, and ping signals follow active ownership")
    func lifecycleSignals() async {
        let rpc = StoreRPC(projects: [], projectTasks: [])
        let path = StorePathObserver()
        let store = AppStore(
            controller: makeController(pathObserver: path),
            rpc: rpc,
            pingIntervalNanoseconds: 1_000_000
        )
        await store.start()
        store.setActiveContext(projectId: "project-a", taskId: "task-1")
        store.setTerminalFocused(true)
        rpc.emitConnection(.opened(requiresRefetch: false))
        await settle()
        #expect(rpc.contextCalls.last?.projectId == "project-a")
        #expect(rpc.contextCalls.last?.taskId == "task-1")
        #expect(rpc.terminalFocusCalls.last == true)
        #expect(rpc.pingCount > 0)

        store.sceneChanged(isActive: false)
        await settle()
        #expect(rpc.foregroundCalls.last == false)
        #expect(rpc.terminalFocusCalls.last == false)
        let pingsWhileInactive = rpc.pingCount
        await settle()
        #expect(rpc.pingCount == pingsWhileInactive)

        path.emitReachable()
        await settle()
        #expect(rpc.foregroundCalls.last == false)
    }

    @Test("Expired authentication clears navigation and routes back to pairing")
    func expirationRouting() async throws {
        let controller = makeController()
        let store = AppStore(controller: controller)
        store.workPath = [.task(projectId: "project-a", taskId: "task-1")]
        store.projectsPath = [.project("project-a")]
        await store.start()
        let credential = try PairingCredential(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            token: "rejected"
        )

        controller.pair(credential)
        await settle()

        #expect(controller.sessionState == .expired)
        #expect(store.banner == .expired)
        #expect(store.shouldShowPairing)
        #expect(store.workPath.isEmpty)
        #expect(store.projectsPath.isEmpty)
    }
}

// swiftlint:enable type_body_length

private struct StoreTestError: Error {}

private final class StoreRPC: AppRPCServing, @unchecked Sendable {
    private let lock = NSLock()
    private let pushStream: AsyncStream<RPCPushEvent>
    private let connectionStream: AsyncStream<RPCConnectionEvent>
    private let pushContinuation: AsyncStream<RPCPushEvent>.Continuation
    private let connectionContinuation: AsyncStream<RPCConnectionEvent>.Continuation
    private var storedProjects: [Dev3Project]
    private var storedProjectTasks: [Dev3ProjectTasks]
    private var shouldFailProjectFetch = false
    private var boardTasksByProject: [String: [Dev3Task]]
    private var mutationResultByTask: [String: Dev3Task] = [:]
    private var priorityResults: [Dev3Task]?
    private var globalDropPosition = "top"
    private var projectFetchContinuation: CheckedContinuation<Void, Never>?
    private var boardFetchContinuations: [String: CheckedContinuation<Void, Never>] = [:]
    private var moveContinuation: CheckedContinuation<Void, Never>?
    private var state = State()

    private struct State {
        var pushStreamReadCount = 0
        var connectionStreamReadCount = 0
        var projectFetchCount = 0
        var taskFetchCount = 0
        var boardFetchCountByProject: [String: Int] = [:]
        var moveCalls: [(taskID: String, status: Dev3TaskStatus)] = []
        var priorityCalls: [(taskID: String, priority: Dev3TaskPriority)] = []
        var watchCalls: [(taskID: String, watched: Bool)] = []
        var customColumnCalls: [(taskID: String, columnID: String?)] = []
        var pullCalls: [String] = []
        var boardFetchFailures: Set<String> = []
        var suspendedBoardFetches: Set<String> = []
        var suspendsNextMove = false
        var suspendsNextProjectFetch = false
        var foregroundCalls: [Bool] = []
        var terminalFocusCalls: [Bool] = []
        var contextCalls: [(projectId: String?, taskId: String?)] = []
        var pingCount = 0
    }

    init(projects: [Dev3Project], projectTasks: [Dev3ProjectTasks]) {
        let pushPair = AsyncStream<RPCPushEvent>.makeStream()
        pushStream = pushPair.stream
        pushContinuation = pushPair.continuation
        let connectionPair = AsyncStream<RPCConnectionEvent>.makeStream()
        connectionStream = connectionPair.stream
        connectionContinuation = connectionPair.continuation
        storedProjects = projects
        storedProjectTasks = projectTasks
        boardTasksByProject = Dictionary(uniqueKeysWithValues: projectTasks.map {
            ($0.projectId, $0.tasks)
        })
    }

    var pushes: AsyncStream<RPCPushEvent> {
        lock.withLock {
            state.pushStreamReadCount += 1
            return pushStream
        }
    }

    var connectionEvents: AsyncStream<RPCConnectionEvent> {
        lock.withLock {
            state.connectionStreamReadCount += 1
            return connectionStream
        }
    }

    var pushStreamReadCount: Int {
        lock.withLock { state.pushStreamReadCount }
    }

    var connectionStreamReadCount: Int {
        lock.withLock { state.connectionStreamReadCount }
    }

    var projectFetchCount: Int {
        lock.withLock { state.projectFetchCount }
    }

    var taskFetchCount: Int {
        lock.withLock { state.taskFetchCount }
    }

    var foregroundCalls: [Bool] {
        lock.withLock { state.foregroundCalls }
    }

    var terminalFocusCalls: [Bool] {
        lock.withLock { state.terminalFocusCalls }
    }

    var contextCalls: [(projectId: String?, taskId: String?)] {
        lock.withLock { state.contextCalls }
    }

    var pingCount: Int {
        lock.withLock { state.pingCount }
    }

    var boardFetchCountByProject: [String: Int] {
        lock.withLock { state.boardFetchCountByProject }
    }

    var moveCalls: [(taskID: String, status: Dev3TaskStatus)] {
        lock.withLock { state.moveCalls }
    }

    var priorityCalls: [(taskID: String, priority: Dev3TaskPriority)] {
        lock.withLock { state.priorityCalls }
    }

    var watchCalls: [(taskID: String, watched: Bool)] {
        lock.withLock { state.watchCalls }
    }

    var customColumnCalls: [(taskID: String, columnID: String?)] {
        lock.withLock { state.customColumnCalls }
    }

    var pullCalls: [String] {
        lock.withLock { state.pullCalls }
    }

    func getProjects() async throws -> [Dev3Project] {
        let shouldSuspend = lock.withLock {
            state.projectFetchCount += 1
            if state.suspendsNextProjectFetch {
                state.suspendsNextProjectFetch = false
                return true
            }
            return false
        }
        if shouldSuspend {
            await withCheckedContinuation { continuation in
                lock.withLock { projectFetchContinuation = continuation }
            }
        }
        return try lock.withLock {
            if shouldFailProjectFetch {
                shouldFailProjectFetch = false
                throw StoreTestError()
            }
            return storedProjects
        }
    }

    func getAllProjectTasks() async throws -> [Dev3ProjectTasks] {
        lock.withLock {
            state.taskFetchCount += 1
            return storedProjectTasks
        }
    }

    func getTasks(projectId: String) async throws -> [Dev3Task] {
        let shouldSuspend = lock.withLock {
            state.suspendedBoardFetches.remove(projectId) != nil
        }
        if shouldSuspend {
            await withCheckedContinuation { continuation in
                lock.withLock { boardFetchContinuations[projectId] = continuation }
            }
        }
        return try lock.withLock {
            state.boardFetchCountByProject[projectId, default: 0] += 1
            if state.boardFetchFailures.remove(projectId) != nil {
                throw StoreTestError()
            }
            return boardTasksByProject[projectId] ?? []
        }
    }

    func pullProjectMain(projectId: String) async throws -> Dev3ProjectPullResult {
        try lock.withLock {
            state.pullCalls.append(projectId)
            return try decode(#"{"ok":true,"branch":"main","output":"Updated","error":""}"#)
        }
    }

    func moveTask(
        taskId: String,
        projectId: String,
        newStatus: Dev3TaskStatus,
        force _: Bool?,
        clientPlayedSound _: Bool?
    ) async throws -> Dev3Task {
        let shouldSuspend = lock.withLock {
            let value = state.suspendsNextMove
            state.suspendsNextMove = false
            return value
        }
        if shouldSuspend {
            await withCheckedContinuation { continuation in
                lock.withLock { moveContinuation = continuation }
            }
        }
        return try lock.withLock {
            state.moveCalls.append((taskId, newStatus))
            return try mutationResultByTask[taskId] ?? storedTask(taskId: taskId, projectId: projectId)
        }
    }

    func setTaskPriority(
        taskId: String,
        projectId: String,
        priority: Dev3TaskPriority
    ) async throws -> [Dev3Task] {
        try lock.withLock {
            state.priorityCalls.append((taskId, priority))
            return try priorityResults ?? [
                mutationResultByTask[taskId] ?? storedTask(taskId: taskId, projectId: projectId)
            ]
        }
    }

    func toggleTaskWatch(
        taskId: String,
        projectId: String,
        watched: Bool
    ) async throws -> Dev3Task {
        try lock.withLock {
            state.watchCalls.append((taskId, watched))
            return try mutationResultByTask[taskId] ?? storedTask(taskId: taskId, projectId: projectId)
        }
    }

    func moveTaskToCustomColumn(
        taskId: String,
        projectId: String,
        customColumnId: String?
    ) async throws -> Dev3Task {
        try lock.withLock {
            state.customColumnCalls.append((taskId, customColumnId))
            return try mutationResultByTask[taskId] ?? storedTask(taskId: taskId, projectId: projectId)
        }
    }

    func getGlobalSettings() async throws -> Dev3GlobalSettings {
        try decode("""
        {"defaultAgentId":"claude","defaultConfigId":"default",
         "taskDropPosition":"\(globalDropPosition)","updateChannel":"stable"}
        """)
    }

    func setWindowForeground(_ focused: Bool) async throws {
        lock.withLock { state.foregroundCalls.append(focused) }
    }

    func setActiveContext(projectId: String?, taskId: String?) async throws {
        lock.withLock { state.contextCalls.append((projectId, taskId)) }
    }

    func setTerminalFocus(_ active: Bool) async throws {
        lock.withLock { state.terminalFocusCalls.append(active) }
    }

    func ping() async throws -> Dev3Ping {
        lock.withLock { state.pingCount += 1 }
        return try decode(#"{"ok":true,"t":1}"#)
    }

    func emitPush(_ event: RPCPushEvent) {
        pushContinuation.yield(event)
    }

    func emitConnection(_ event: RPCConnectionEvent) {
        connectionContinuation.yield(event)
    }

    func failNextProjectFetch() {
        lock.withLock { shouldFailProjectFetch = true }
    }

    func setBoardTasks(_ tasks: [Dev3Task], projectID: String) {
        lock.withLock { boardTasksByProject[projectID] = tasks }
    }

    func failNextBoardFetch(projectID: String) {
        lock.withLock { _ = state.boardFetchFailures.insert(projectID) }
    }

    func suspendNextBoardFetch(projectID: String) {
        lock.withLock { _ = state.suspendedBoardFetches.insert(projectID) }
    }

    func resumeBoardFetch(projectID: String) {
        let continuation = lock.withLock { boardFetchContinuations.removeValue(forKey: projectID) }
        continuation?.resume()
    }

    func suspendNextMove() {
        lock.withLock { state.suspendsNextMove = true }
    }

    func resumeMove() {
        let continuation = lock.withLock {
            let continuation = moveContinuation
            moveContinuation = nil
            return continuation
        }
        continuation?.resume()
    }

    func setMutationResult(_ task: Dev3Task, priorityGroup: [Dev3Task]? = nil) {
        lock.withLock {
            mutationResultByTask[task.id] = task
            priorityResults = priorityGroup
        }
    }

    func setGlobalDropPosition(_ position: String) {
        lock.withLock { globalDropPosition = position }
    }

    func suspendNextProjectFetch() {
        lock.withLock { state.suspendsNextProjectFetch = true }
    }

    func resumeProjectFetch() {
        let continuation = lock.withLock {
            let continuation = projectFetchContinuation
            projectFetchContinuation = nil
            return continuation
        }
        continuation?.resume()
    }

    private func storedTask(taskId: String, projectId: String) throws -> Dev3Task {
        guard let task = storedProjectTasks
            .first(where: { $0.projectId == projectId })?
            .tasks.first(where: { $0.id == taskId })
        else {
            throw StoreTestError()
        }
        return task
    }
}

@MainActor
private func makeController(
    pathObserver: StorePathObserver = StorePathObserver(),
    pairedServerStore: PairedServerStore = PairedServerStore(secureStore: StoreMemorySecureData())
) -> ConnectionController {
    ConnectionController(
        store: pairedServerStore,
        transport: StoreSessionTransport(),
        discovery: StoreDiscovery(),
        pathObserver: pathObserver,
        connectionFactory: { _ in StoreSessionConnection() },
        schedulerFactory: StoreScheduler.init
    )
}

private actor StoreSessionTransport: SessionHTTPTransporting {
    func fetchInstance(origin _: URL) async throws -> RemoteInstanceInfo {
        try decode(#"{"instanceId":"test","name":"Test","appVersion":"1","protocolVersion":1}"#)
    }

    func exchange(origin _: URL, token _: String) async throws -> SessionAuthResponse {
        SessionAuthResponse(statusCode: 401, sessionToken: nil)
    }

    func refresh(requestFactory _: SessionRequestFactory) async throws -> SessionAuthResponse {
        SessionAuthResponse(statusCode: 401, sessionToken: nil)
    }
}

private actor StoreSessionConnection: SessionConnectionControlling {
    func setSessionEventHandler(_: (@Sendable (SessionConnectionEvent) -> Void)?) async {}
    func connect() async throws {}
    func disconnect() async {}
}

@MainActor
private final class StoreDiscovery: BonjourDiscovering {
    var onInstancesChanged: (([DiscoveredInstance]) -> Void)?
    var onError: ((String) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
private final class StorePathObserver: NetworkPathObserving {
    var onReachable: (() -> Void)?
    func start() {}
    func stop() {}
    func emitReachable() {
        onReachable?()
    }
}

@MainActor
private final class StoreScheduler: SessionScheduling {
    func schedule(
        after _: TimeInterval,
        operation _: @escaping @MainActor @Sendable () -> Void
    ) -> UUID {
        UUID()
    }

    func cancel(_: UUID) {}
}

private final class StoreMemorySecureData: SecureDataStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func read(account _: String) throws -> Data? {
        lock.withLock { data }
    }

    func write(_ data: Data, account _: String) throws {
        lock.withLock { self.data = data }
    }

    func delete(account _: String) throws {
        lock.withLock { data = nil }
    }
}

private func project(id: String, name: String, deleted: Bool = false) throws -> Dev3Project {
    try decode("""
    {"id":"\(id)","name":"\(name)","path":"/repo/\(id)",
     "setupScript":"","devScript":"","cleanupScript":"",
     "defaultBaseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
     "deleted":\(deleted)}
    """)
}

private func pairedServer(id: String, name: String, port: Int) throws -> PairedServer {
    try PairedServer(
        origin: #require(URL(string: "http://127.0.0.1:\(port)")),
        sessionToken: "\(id)-token",
        name: name,
        instanceId: id
    )
}

private func task(
    id: String,
    projectId: String,
    seq: Int,
    title: String,
    status: Dev3TaskStatus = .todo
) throws -> Dev3Task {
    try decode("""
    {"id":"\(id)","seq":\(seq),"projectId":"\(projectId)",
     "title":"\(title)","description":"Test","status":"\(status.rawValue)",
     "baseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
     "updatedAt":"2026-07-16T10:00:00Z"}
    """)
}

private func projectTasks(projectId: String, tasks: [Dev3Task]) throws -> Dev3ProjectTasks {
    try decode("""
    {"projectId":"\(projectId)","tasks":\(encoded(tasks))}
    """)
}

private func encoded(_ value: some Encodable) throws -> String {
    let data = try JSONEncoder().encode(value)
    guard let string = String(data: data, encoding: .utf8) else {
        throw StoreTestError()
    }
    return string
}

private func decode<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func decode<T: Decodable>(_: T.Type, _ json: String) throws -> T {
    try decode(json)
}

@MainActor
private func settle() async {
    for _ in 0 ..< 200 {
        await Task.yield()
    }
}
