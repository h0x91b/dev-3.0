import Dev3Kit
import Foundation
import Observation

public protocol AppRPCServing: Sendable {
    var pushes: AsyncStream<RPCPushEvent> { get }
    var connectionEvents: AsyncStream<RPCConnectionEvent> { get }

    func getProjects() async throws -> [Dev3Project]
    func getAllProjectTasks() async throws -> [Dev3ProjectTasks]
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

struct AppStoreSnapshot: Equatable, Sendable {
    var projects: [Dev3Project] = []
    var tasksByProject: [String: [Dev3Task]] = [:]
    var prStatusByTask: [String: TaskPRStatusPush] = [:]
    var clipboardByTask: [String: OSC52ClipboardPush] = [:]
    var attentionByTask: [String: String] = [:]

    mutating func replace(projects: [Dev3Project], projectTasks: [Dev3ProjectTasks]) {
        self.projects = projects
            .filter { $0.deleted != true }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        tasksByProject = Dictionary(uniqueKeysWithValues: projectTasks.map { projectTasks in
            let sortedTasks = projectTasks.tasks.sorted { lhs, rhs in
                lhs.seq == rhs.seq ? lhs.id < rhs.id : lhs.seq < rhs.seq
            }
            return (projectTasks.projectId, sortedTasks)
        })
    }

    mutating func reduce(_ push: RPCPushEvent) -> AppToast? {
        switch push {
        case let .taskUpdated(update):
            upsert(update.task, projectId: update.projectId)
        case let .taskRemoved(removal):
            tasksByProject[removal.projectId]?.removeAll { $0.id == removal.taskId }
            prStatusByTask[removal.taskId] = nil
            clipboardByTask[removal.taskId] = nil
            attentionByTask[removal.taskId] = nil
        case let .projectUpdated(update):
            projects.removeAll { $0.id == update.project.id }
            if update.project.deleted != true {
                projects.append(update.project)
                projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            } else {
                let taskIDs = Set(tasksByProject.removeValue(forKey: update.project.id)?.map(\.id) ?? [])
                prStatusByTask = prStatusByTask.filter { !taskIDs.contains($0.key) }
                clipboardByTask = clipboardByTask.filter { !taskIDs.contains($0.key) }
                attentionByTask = attentionByTask.filter { !taskIDs.contains($0.key) }
            }
        case let .taskPRStatus(status):
            prStatusByTask[status.taskId] = status
        case let .osc52Clipboard(clipboard):
            clipboardByTask[clipboard.taskId] = clipboard
        case let .cliAttention(attention):
            attentionByTask[attention.taskId] = attention.reason
        case let .cliToast(toast):
            return AppToast(message: toast.message, level: toast.level)
        case let .webNotification(notification):
            let message = notification.body.isEmpty ? notification.title : notification.body
            return AppToast(message: message, level: notification.level)
        default:
            break
        }
        return nil
    }

    private mutating func upsert(_ task: Dev3Task, projectId: String) {
        var tasks = tasksByProject[projectId] ?? []
        tasks.removeAll { $0.id == task.id }
        tasks.append(task)
        tasks.sort { lhs, rhs in
            lhs.seq == rhs.seq ? lhs.id < rhs.id : lhs.seq < rhs.seq
        }
        tasksByProject[projectId] = tasks
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
    public private(set) var toast: AppToast?
    public private(set) var lastSyncError: String?
    public private(set) var lastPush: RPCPushEvent?

    public var selectedTab = AppTab.work
    public var workPath: [AppRoute] = []
    public var projectsPath: [AppRoute] = []
    public var settingsPath: [AppRoute] = []

    private let runtime: ConnectionRuntime?
    private let initialRPC: (any AppRPCServing)?
    private let pingIntervalNanoseconds: UInt64
    private var rpc: (any AppRPCServing)?
    private var pushTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var snapshot = AppStoreSnapshot()
    private var pushObservers: [UUID: @MainActor (RPCPushEvent) -> Void] = [:]
    private var rpcGeneration = UUID()
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
}

extension AppStore {
    func attach(_ rpc: any AppRPCServing) {
        guard isStarted else { return }
        let detachedRPC = self.rpc
        if let detachedRPC {
            Task { try? await detachedRPC.setTerminalFocus(false) }
        }
        self.rpc = rpc
        let generation = UUID()
        rpcGeneration = generation
        pushTask?.cancel()
        connectionTask?.cancel()
        pingTask?.cancel()
        pingTask = nil
        pushTask = Task { [weak self] in
            for await push in rpc.pushes {
                guard !Task.isCancelled else { return }
                self?.apply(push, generation: generation)
            }
        }
        connectionTask = Task { [weak self] in
            for await event in rpc.connectionEvents {
                guard !Task.isCancelled else { return }
                await self?.handleConnectionEvent(event, rpc: rpc, generation: generation)
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
        generation: UUID
    ) async {
        guard isStarted, generation == rpcGeneration else { return }
        switch event {
        case .opened:
            banner = nil
            if isSceneActive {
                startPingLoop()
            }
            await refetch(using: rpc, generation: generation)
        case .closed, .failed:
            pingTask?.cancel()
            pingTask = nil
            if controller.sessionState != .expired {
                banner = .reconnecting
            }
        }
    }

    func refetch(using rpc: any AppRPCServing, generation: UUID) async {
        do {
            async let projects = rpc.getProjects()
            async let tasks = rpc.getAllProjectTasks()
            let refreshedProjects = try await projects
            let refreshedTasks = try await tasks
            guard isStarted, generation == rpcGeneration else { return }
            snapshot.replace(projects: refreshedProjects, projectTasks: refreshedTasks)
            publishSnapshot()
            isInitialLoading = false
            lastSyncError = nil
        } catch {
            guard isStarted, generation == rpcGeneration else { return }
            isInitialLoading = false
            lastSyncError = "Could not refresh dev3 data. Cached data is still available."
        }
    }

    func apply(_ push: RPCPushEvent, generation: UUID) {
        guard isStarted, generation == rpcGeneration else { return }
        lastPush = push
        if let routedToast = snapshot.reduce(push) {
            toast = routedToast
        }
        publishSnapshot()
        for observer in pushObservers.values {
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
            banner = .connecting
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
