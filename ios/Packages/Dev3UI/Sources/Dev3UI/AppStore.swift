import Dev3Kit
import Foundation
import Observation

public protocol AppRPCServing: Sendable {
    var pushes: AsyncStream<RPCPushEvent> { get }
    var connectionEvents: AsyncStream<RPCConnectionEvent> { get }

    func getProjects() async throws -> [Dev3Project]
    func getAllProjectTasks() async throws -> [Dev3ProjectTasks]
    func getTasks(projectId: String) async throws -> [Dev3Task]
    func pullProjectMain(projectId: String) async throws -> Dev3ProjectPullResult
    func moveTask(
        taskId: String,
        projectId: String,
        newStatus: Dev3TaskStatus,
        force: Bool?,
        clientPlayedSound: Bool?
    ) async throws -> Dev3Task
    func setTaskPriority(
        taskId: String,
        projectId: String,
        priority: Dev3TaskPriority
    ) async throws -> [Dev3Task]
    func toggleTaskWatch(taskId: String, projectId: String, watched: Bool) async throws -> Dev3Task
    func moveTaskToCustomColumn(
        taskId: String,
        projectId: String,
        customColumnId: String?
    ) async throws -> Dev3Task
    func getGlobalSettings() async throws -> Dev3GlobalSettings
    func setWindowForeground(_ focused: Bool) async throws
    func setActiveContext(projectId: String?, taskId: String?) async throws
    func setTerminalFocus(_ active: Bool) async throws
    func ping() async throws -> Dev3Ping
}

extension RPCClient: AppRPCServing {}

public enum AppTab: Hashable, Sendable {
    case work
    case projects
    case settings
}

public enum AppRoute: Hashable, Sendable {
    case task(projectId: String, taskId: String)
    case project(String)
}

public enum ConnectionBanner: Equatable, Sendable {
    case connecting
    case reconnecting
    case expired

    public var message: String {
        switch self {
        case .connecting:
            "Connecting to dev3…"
        case .reconnecting:
            "Connection lost. Reconnecting…"
        case .expired:
            "Session expired. Pair again to continue."
        }
    }
}

public struct AppToast: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let message: String
    public let level: Dev3NotificationLevel

    public init(id: UUID = UUID(), message: String, level: Dev3NotificationLevel) {
        self.id = id
        self.message = message
        self.level = level
    }
}

@MainActor
@Observable
public final class AppStore {
    public let controller: ConnectionController

    public private(set) var projects: [Dev3Project] = []
    public private(set) var tasksByProject: [String: [Dev3Task]] = [:]
    public private(set) var prStatusByTask: [String: TaskPRStatusPush] = [:]
    public private(set) var clipboardByTask: [String: OSC52ClipboardPush] = [:]
    public private(set) var attentionByTask: [String: String] = [:]
    public private(set) var isInitialLoading = true
    public private(set) var banner: ConnectionBanner?
    public internal(set) var toast: AppToast?
    public internal(set) var lastSyncError: String?
    public private(set) var lastPush: RPCPushEvent?
    public private(set) var taskDropPosition = TaskDropPosition.top
    public private(set) var refetchRevision = 0
    public private(set) var snapshotServerID: String?
    public internal(set) var projectPullStates: [String: ProjectPullState] = [:]

    public var selectedTab = AppTab.work
    public var workPath: [AppRoute] = []
    public var projectsPath: [AppRoute] = []
    public var settingsPath: [AppRoute] = []

    private let runtime: ConnectionRuntime?
    private let initialRPC: (any AppRPCServing)?
    private let pingIntervalNanoseconds: UInt64
    var rpc: (any AppRPCServing)?
    var rpcServerID: String?
    private var pushTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    var snapshot = AppStoreSnapshot()
    private var pushObservers: [UUID: @MainActor (RPCPushEvent) -> Void] = [:]
    public private(set) var rpcGeneration = UUID()
    var loadedBoardProjectIDs: Set<String> = []
    var rpcIsOpen = false
    private var isStarted = false
    private var isSceneActive = true
    private var terminalFocusRequested = false

    public convenience init(runtime: ConnectionRuntime) {
        self.init(controller: runtime.controller, runtime: runtime, rpc: nil)
    }

    public convenience init(controller: ConnectionController) {
        self.init(controller: controller, runtime: nil, rpc: nil)
    }

    init(
        controller: ConnectionController,
        runtime: ConnectionRuntime? = nil,
        rpc: (any AppRPCServing)? = nil,
        pingIntervalNanoseconds: UInt64 = 15_000_000_000
    ) {
        self.controller = controller
        self.runtime = runtime
        initialRPC = rpc
        self.rpc = nil
        self.pingIntervalNanoseconds = pingIntervalNanoseconds
    }

    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        controller.onSessionStateChange = { [weak self] state in
            self?.handleSessionState(state)
        }
        controller.onNetworkReachable = { [weak self] in
            self?.networkBecameReachable()
        }
        runtime?.onRPCClientChange = { [weak self] client in
            self?.attach(client)
        }
        if runtime == nil, let initialRPC {
            attach(initialRPC)
        }
        await controller.start()
        handleSessionState(controller.sessionState)
    }

    public func stop() {
        guard isStarted else { return }
        isStarted = false
        controller.onSessionStateChange = nil
        controller.onNetworkReachable = nil
        runtime?.onRPCClientChange = nil
        detachRPC()
        controller.stop()
    }

    private func detachRPC() {
        let detachedRPC = rpc
        rpcGeneration = UUID()
        pushTask?.cancel()
        connectionTask?.cancel()
        pingTask?.cancel()
        pushTask = nil
        connectionTask = nil
        pingTask = nil
        rpc = nil
        rpcServerID = nil
        rpcIsOpen = false
        if let detachedRPC {
            Task {
                try? await detachedRPC.setTerminalFocus(false)
                try? await detachedRPC.setWindowForeground(false)
            }
        }
    }

    public func sceneChanged(isActive: Bool) {
        isSceneActive = isActive
        if isActive {
            controller.foregrounded()
            if controller.sessionState == .connected {
                startPingLoop()
            }
        } else {
            pingTask?.cancel()
            pingTask = nil
        }
        guard let rpc else { return }
        Task {
            try? await rpc.setWindowForeground(isActive)
            try? await rpc.setTerminalFocus(isActive && terminalFocusRequested)
        }
    }

    public func setActiveContext(projectId: String?, taskId: String?) {
        guard let rpc else { return }
        Task {
            try? await rpc.setActiveContext(projectId: projectId, taskId: taskId)
        }
    }

    public func setTerminalFocused(_ focused: Bool) {
        terminalFocusRequested = focused
        guard let rpc else { return }
        Task {
            try? await rpc.setTerminalFocus(focused && isSceneActive)
        }
    }

    public func dismissToast() {
        toast = nil
    }

    /// Adds a feature-event sink without creating a second consumer of `RPCClient.pushes`.
    /// The caller owns the returned token and removes it when its feature store is released.
    @discardableResult
    public func addPushObserver(
        _ observer: @escaping @MainActor (RPCPushEvent) -> Void
    ) -> UUID {
        let token = UUID()
        pushObservers[token] = observer
        return token
    }

    public func removePushObserver(_ token: UUID) {
        pushObservers[token] = nil
    }

    public var shouldShowPairing: Bool {
        controller.activeServer == nil || controller.sessionState == .expired
    }

    var pushObserverCount: Int {
        pushObservers.count
    }
}

extension AppStore {
    func attach(_ rpc: any AppRPCServing) {
        guard isStarted else { return }
        let detachedRPC = self.rpc
        if let detachedRPC {
            Task { try? await detachedRPC.setTerminalFocus(false) }
        }
        self.rpc = rpc
        rpcIsOpen = false
        let generation = UUID()
        let sourceServerID = controller.activeServer?.instanceId
        rpcServerID = sourceServerID
        rpcGeneration = generation
        pushTask?.cancel()
        connectionTask?.cancel()
        pingTask?.cancel()
        pingTask = nil
        pushTask = Task { [weak self] in
            for await push in rpc.pushes {
                guard !Task.isCancelled else { return }
                self?.apply(
                    push,
                    generation: generation,
                    sourceServerID: sourceServerID
                )
            }
        }
        connectionTask = Task { [weak self] in
            for await event in rpc.connectionEvents {
                guard !Task.isCancelled else { return }
                await self?.handleConnectionEvent(
                    event,
                    rpc: rpc,
                    generation: generation,
                    sourceServerID: sourceServerID
                )
            }
        }
        Task {
            try? await rpc.setWindowForeground(isSceneActive)
            try? await rpc.setTerminalFocus(isSceneActive && terminalFocusRequested)
        }
        if controller.sessionState == .connected, isSceneActive {
            startPingLoop()
        }
    }

    func handleConnectionEvent(
        _ event: RPCConnectionEvent,
        rpc: any AppRPCServing,
        generation: UUID,
        sourceServerID: String?
    ) async {
        guard isStarted,
              generation == rpcGeneration,
              controller.activeServer?.instanceId == sourceServerID else { return }
        switch event {
        case .opened:
            rpcIsOpen = true
            banner = nil
            if isSceneActive {
                startPingLoop()
            }
            await refetch(
                using: rpc,
                generation: generation,
                sourceServerID: sourceServerID
            )
        case .closed, .failed:
            rpcIsOpen = false
            pingTask?.cancel()
            pingTask = nil
            if controller.sessionState != .expired {
                banner = .reconnecting
            }
        }
    }

    func refetch(using rpc: any AppRPCServing, generation: UUID) async {
        await refetch(
            using: rpc,
            generation: generation,
            sourceServerID: controller.activeServer?.instanceId
        )
    }

    func refetch(
        using rpc: any AppRPCServing,
        generation: UUID,
        sourceServerID: String?
    ) async {
        do {
            async let projects = rpc.getProjects()
            async let tasks = rpc.getAllProjectTasks()
            async let settings = try? rpc.getGlobalSettings()
            let refreshedProjects = try await projects
            let refreshedTasks = try await tasks
            let refreshedSettings = await settings
            let existingProjectIDs = Set(refreshedProjects.lazy.filter { $0.deleted != true }.map(\.id))
            let retainedBoardProjectIDs = loadedBoardProjectIDs.intersection(existingProjectIDs)
            var refreshedBoards: [String: [Dev3Task]] = [:]
            for projectID in retainedBoardProjectIDs {
                if let boardTasks = try? await rpc.getTasks(projectId: projectID) {
                    refreshedBoards[projectID] = boardTasks
                }
            }
            guard isStarted,
                  generation == rpcGeneration,
                  controller.activeServer?.instanceId == sourceServerID else { return }
            loadedBoardProjectIDs = retainedBoardProjectIDs
            snapshot.replace(
                projects: refreshedProjects,
                projectTasks: refreshedTasks,
                preservingProjectIDs: retainedBoardProjectIDs
            )
            for (projectID, boardTasks) in refreshedBoards {
                snapshot.replaceTasks(boardTasks, projectId: projectID)
            }
            if let position = refreshedSettings.flatMap({ TaskDropPosition(rawValue: $0.taskDropPosition) }) {
                taskDropPosition = position
            }
            refetchRevision &+= 1
            snapshotServerID = sourceServerID
            publishSnapshot()
            isInitialLoading = false
            lastSyncError = nil
        } catch {
            guard isStarted,
                  generation == rpcGeneration,
                  controller.activeServer?.instanceId == sourceServerID else { return }
            isInitialLoading = false
            lastSyncError = "Could not refresh dev3 data. Cached data is still available."
        }
    }

    func apply(
        _ push: RPCPushEvent,
        generation: UUID,
        sourceServerID: String?
    ) {
        guard isStarted,
              generation == rpcGeneration,
              controller.activeServer?.instanceId == sourceServerID else { return }
        lastPush = push
        if let routedToast = snapshot.reduce(push) {
            toast = routedToast
        }
        snapshotServerID = sourceServerID
        publishSnapshot()
        for observer in Array(pushObservers.values) {
            observer(push)
        }
    }

    func publishSnapshot() {
        projects = snapshot.projects
        tasksByProject = snapshot.tasksByProject
        prStatusByTask = snapshot.prStatusByTask
        clipboardByTask = snapshot.clipboardByTask
        attentionByTask = snapshot.attentionByTask
    }

    func handleSessionState(_ state: RemoteSessionState) {
        switch state {
        case .idle:
            banner = nil
        case .authenticating, .connecting:
            pingTask?.cancel()
            pingTask = nil
            banner = .connecting
            let snapshotSwitchedServers = snapshotServerID.map {
                $0 != controller.activeServer?.instanceId
            } ?? false
            let attachedRPCSwitchedServers = rpc != nil
                && rpcServerID != controller.activeServer?.instanceId
            if snapshotSwitchedServers || attachedRPCSwitchedServers {
                snapshot = AppStoreSnapshot()
                snapshotServerID = nil
                toast = nil
                lastSyncError = nil
                lastPush = nil
                taskDropPosition = .top
                loadedBoardProjectIDs.removeAll()
                projectPullStates.removeAll()
                workPath.removeAll()
                projectsPath.removeAll()
                terminalFocusRequested = false
                isInitialLoading = true
                publishSnapshot()
            } else {
                removeAllTaskRoutes()
            }
        case .connected:
            banner = nil
            if isSceneActive {
                startPingLoop()
            }
        case .reconnecting:
            banner = .reconnecting
            pingTask?.cancel()
            pingTask = nil
        case .expired:
            banner = .expired
            pingTask?.cancel()
            pingTask = nil
            if let rpc {
                Task { try? await rpc.setTerminalFocus(false) }
            }
            workPath.removeAll()
            projectsPath.removeAll()
            settingsPath.removeAll()
        }
    }

    func networkBecameReachable() {
        guard let rpc else { return }
        Task {
            try? await rpc.setWindowForeground(isSceneActive)
        }
    }

    func startPingLoop() {
        guard isStarted, isSceneActive, let rpc, pingTask == nil else { return }
        let generation = rpcGeneration
        let interval = pingIntervalNanoseconds
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                _ = try? await rpc.ping()
                guard !Task.isCancelled else { return }
                do {
                    try await Task.sleep(nanoseconds: interval)
                } catch {
                    return
                }
                guard self?.rpcGeneration == generation else { return }
            }
        }
    }
}
