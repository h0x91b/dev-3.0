import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

// This intentionally exhaustive state-machine suite keeps its fixtures beside the scenarios.
// swiftlint:disable file_length

@MainActor
@Suite("App store", .serialized)
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
    private var state = State()

    private struct State {
        var pushStreamReadCount = 0
        var connectionStreamReadCount = 0
        var projectFetchCount = 0
        var taskFetchCount = 0
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

    func getProjects() async throws -> [Dev3Project] {
        try nextProjects()
    }

    func getAllProjectTasks() async throws -> [Dev3ProjectTasks] {
        lock.withLock {
            state.taskFetchCount += 1
            return storedProjectTasks
        }
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

    private func nextProjects() throws -> [Dev3Project] {
        try lock.withLock {
            state.projectFetchCount += 1
            if shouldFailProjectFetch {
                shouldFailProjectFetch = false
                throw StoreTestError()
            }
            return storedProjects
        }
    }
}

@MainActor
private func makeController(pathObserver: StorePathObserver = StorePathObserver()) -> ConnectionController {
    ConnectionController(
        store: PairedServerStore(secureStore: StoreMemorySecureData()),
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
