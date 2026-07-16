import Dev3Kit
import Dev3TerminalKit
import Dev3UI
import SwiftUI

// The application composition root intentionally owns all cross-feature lifecycle wiring.
// swiftlint:disable file_length

// SwiftFormat's wrapped conditional style conflicts with SwiftLint's opening-brace rule.
// swiftlint:disable opening_brace

@MainActor
struct CompanionAppRoot: View {
    let store: AppStore
    let runtime: ConnectionRuntime?
    let notificationTapBridge: NotificationTapBridge
    @Environment(\.scenePhase) private var scenePhase
    @State private var presentedTaskInfo: PresentedTaskInfo?
    @State private var mediaCoordinator: TaskMediaCoordinator
    @State private var notificationCoordinator: NativeNotificationCoordinator
    @State private var completionCoordinator: AgentCompletionCoordinator
    @State private var globalPushObserverToken: UUID?
    @State private var completionRPCGeneration: UUID?

    init(
        store: AppStore,
        runtime: ConnectionRuntime?,
        notificationTapBridge: NotificationTapBridge
    ) {
        self.store = store
        self.runtime = runtime
        self.notificationTapBridge = notificationTapBridge
        _mediaCoordinator = State(
            initialValue: TaskMediaCoordinator(
                pushSource: store,
                serviceProviderFactory: {
                    if let rpcClient = runtime?.rpcClient {
                        RPCTaskMediaServiceProvider(rpcClient: rpcClient)
                    } else {
                        UnavailableTaskMediaServiceProvider()
                    }
                }
            )
        )
        _notificationCoordinator = State(
            initialValue: NativeNotificationCoordinator(service: UserNotificationService())
        )
        _completionCoordinator = State(
            initialValue: AgentCompletionCoordinator(
                serviceProvider: Self.completionServiceProvider(runtime: runtime),
                removeRoute: { projectID, taskID in
                    store.removeTaskRoutes(projectId: projectID, taskId: taskID)
                }
            )
        )
    }

    var body: some View {
        CompanionRootView(
            store: store,
            taskDestinationBuilder: { projectID, taskID in
                AnyView(
                    TaskTerminalDestination(
                        store: store,
                        runtime: runtime,
                        projectID: projectID,
                        taskID: taskID,
                        onTaskInfo: { presentTaskInfo(projectID: projectID, taskID: taskID) }
                    )
                )
            },
            onOpenTaskInfo: presentTaskInfo,
            settingsAccessoryBuilder: {
                AnyView(NotificationSettingsSection(coordinator: notificationCoordinator))
            }
        )
        .sheet(item: $presentedTaskInfo) { presented in
            TaskInfoDestination(
                appStore: store,
                runtime: runtime,
                projectID: presented.projectID,
                taskID: presented.taskID,
                onTerminalClosed: {
                    store.removeTaskRoutes(projectId: presented.projectID, taskId: presented.taskID)
                    presentedTaskInfo = nil
                }
            )
        }
        .onChange(of: store.controller.sessionState) { _, state in
            if state == .authenticating || state == .connecting {
                presentedTaskInfo = nil
            }
        }
        .background {
            TaskMediaHost(store: mediaCoordinator.mediaStore)
        }
        .onAppear {
            mediaCoordinator.start()
            startGlobalCoordination()
        }
        .onDisappear {
            mediaCoordinator.stop()
            stopGlobalCoordination()
        }
        .onChange(of: companionShellSnapshot, initial: true) { _, snapshot in
            mediaCoordinator.synchronize(
                tasksByProject: snapshot.tasksByProject,
                rpcGeneration: snapshot.rpcGeneration,
                serverID: snapshot.serverID,
                snapshotServerID: snapshot.snapshotServerID
            )
            synchronizeGlobalCoordination(snapshot)
        }
        .onChange(of: notificationCoordinator.deepLinkRequest) { _, deepLink in
            if let deepLink {
                routeNotificationDeepLink(deepLink)
            }
        }
        .confirmationDialog(
            completionCoordinator.currentConfirmation?.title ?? "Agent requests completion",
            isPresented: completionPresentationBinding,
            titleVisibility: .visible
        ) {
            completionActions
        } message: {
            completionMessage
        }
    }

    private var companionShellSnapshot: CompanionShellSnapshot {
        CompanionShellSnapshot(
            tasksByProject: store.tasksByProject,
            rpcGeneration: store.rpcGeneration,
            serverID: store.controller.activeServer?.instanceId,
            snapshotServerID: store.snapshotServerID,
            refetchRevision: store.refetchRevision,
            attentionTaskIDs: Set(store.attentionByTask.keys),
            isConnected: store.isConnected,
            isSceneActive: scenePhase == .active,
            visibleTaskID: visibleTaskID
        )
    }

    private var visibleTaskID: String? {
        if let presentedTaskInfo {
            return presentedTaskInfo.taskID
        }
        if let mediaTaskID = mediaCoordinator.mediaStore.presentation?.taskID {
            return mediaTaskID
        }
        switch store.selectedTab {
        case .work:
            return taskID(in: store.workPath)
        case .projects:
            return taskID(in: store.projectsPath)
        case .settings:
            return nil
        }
    }

    private var completionPresentationBinding: Binding<Bool> {
        Binding(
            get: { completionCoordinator.currentConfirmation != nil },
            set: { isPresented in
                guard !isPresented, let requestID = completionCoordinator.currentRequestID else {
                    return
                }
                completionCoordinator.dismiss(requestID: requestID)
            }
        )
    }

    @ViewBuilder
    private var completionActions: some View {
        if let confirmation = completionCoordinator.currentConfirmation,
           let requestID = completionCoordinator.currentRequestID
        {
            Button(
                confirmation.confirmTitle,
                role: confirmation.isDestructive ? .destructive : nil
            ) {
                completionCoordinator.approve(requestID: requestID)
            }
            .accessibilityIdentifier("agentCompletion.confirm")
            Button(confirmation.cancelTitle, role: .cancel) {
                completionCoordinator.decline(requestID: requestID)
            }
            .accessibilityIdentifier("agentCompletion.cancel")
        }
    }

    private var completionMessage: some View {
        Text(completionCoordinator.currentConfirmation?.message ?? "")
    }

    private func startGlobalCoordination() {
        guard globalPushObserverToken == nil else { return }
        notificationCoordinator.rebindService(UserNotificationService())
        completionRPCGeneration = nil
        bindCompletionServiceIfNeeded(rpcGeneration: store.rpcGeneration)
        notificationTapBridge.bind { userInfo in
            notificationCoordinator.handleNotificationTap(userInfo: userInfo)
        }
        globalPushObserverToken = store.addPushObserver { push in
            receiveGlobalPush(push)
        }
        synchronizeGlobalCoordination(companionShellSnapshot)
        Task {
            await notificationCoordinator.refreshAuthorizationStatus()
        }
    }

    private func stopGlobalCoordination() {
        if let globalPushObserverToken {
            store.removePushObserver(globalPushObserverToken)
        }
        globalPushObserverToken = nil
        notificationTapBridge.unbind()
        completionRPCGeneration = nil
        let completionCoordinator = completionCoordinator
        let notificationCoordinator = notificationCoordinator
        Task {
            await completionCoordinator.stop()
            await notificationCoordinator.stop()
        }
    }

    private func receiveGlobalPush(_ push: RPCPushEvent) {
        bindCompletionServiceIfNeeded(rpcGeneration: store.rpcGeneration)
        synchronizeNotificationState(companionShellSnapshot)
        completionCoordinator.receive(push)
        notificationCoordinator.receive(push)
    }

    private func synchronizeGlobalCoordination(_ snapshot: CompanionShellSnapshot) {
        bindCompletionServiceIfNeeded(rpcGeneration: snapshot.rpcGeneration)
        synchronizeNotificationState(snapshot)
    }

    private func synchronizeNotificationState(_ snapshot: CompanionShellSnapshot) {
        if let serverID = snapshot.serverID {
            notificationCoordinator.synchronize(
                serverID: serverID,
                snapshotServerID: snapshot.snapshotServerID,
                tasks: snapshot.tasksByProject.values.flatMap(\.self),
                attentionTaskIDs: snapshot.attentionTaskIDs
            )
        } else {
            notificationCoordinator.clearActiveServer()
        }
        notificationCoordinator.setConnectionReady(snapshot.isConnected)
        notificationCoordinator.setForeground(
            isActive: snapshot.isSceneActive,
            visibleTaskID: snapshot.visibleTaskID
        )
    }

    private func bindCompletionServiceIfNeeded(rpcGeneration: UUID) {
        guard completionRPCGeneration != rpcGeneration else { return }
        completionRPCGeneration = rpcGeneration
        completionCoordinator.rebindServiceProvider(
            Self.completionServiceProvider(runtime: runtime)
        )
    }

    private func routeNotificationDeepLink(_ deepLink: NativeNotificationDeepLink) {
        guard store.isConnected,
              store.controller.activeServer?.instanceId == deepLink.serverID,
              store.task(projectId: deepLink.projectID, taskId: deepLink.taskID) != nil
        else { return }
        presentedTaskInfo = nil
        mediaCoordinator.mediaStore.closePresentation()
        store.removeTaskRoutes(projectId: deepLink.projectID, taskId: deepLink.taskID)
        store.openTask(projectId: deepLink.projectID, taskId: deepLink.taskID, from: .work)
        _ = notificationCoordinator.consumeDeepLinkRequest()
    }

    private func taskID(in path: [AppRoute]) -> String? {
        guard let route = path.last, case let .task(_, taskID) = route else { return nil }
        return taskID
    }

    private static func completionServiceProvider(
        runtime: ConnectionRuntime?
    ) -> any AgentCompletionServiceProviding {
        if let rpcClient = runtime?.rpcClient {
            return RPCAgentCompletionServiceProvider(rpcClient: rpcClient)
        }
        return UnavailableCompletionProvider()
    }

    private func presentTaskInfo(projectID: String, taskID: String) {
        presentedTaskInfo = PresentedTaskInfo(projectID: projectID, taskID: taskID)
    }
}

private struct CompanionShellSnapshot: Equatable {
    let tasksByProject: [String: [Dev3Task]]
    let rpcGeneration: UUID
    let serverID: String?
    let snapshotServerID: String?
    let refetchRevision: Int
    let attentionTaskIDs: Set<String>
    let isConnected: Bool
    let isSceneActive: Bool
    let visibleTaskID: String?
}

private struct PresentedTaskInfo: Identifiable {
    let projectID: String
    let taskID: String

    var id: String {
        "\(projectID):\(taskID)"
    }
}

@MainActor
private struct TaskTerminalDestination: View {
    let store: AppStore
    let runtime: ConnectionRuntime?
    let projectID: String
    let taskID: String
    let onTaskInfo: () -> Void

    var body: some View {
        if !store.isConnected {
            TerminalUnavailableView(
                message: "Reconnect to this dev3 instance before opening its terminal."
            )
        } else if let task = store.task(projectId: projectID, taskId: taskID),
                  let rpcClient = runtime?.rpcClient,
                  let ptyClient = runtime?.makePTYClient(),
                  let serverID = store.controller.activeServer?.instanceId
        {
            AvailableTaskTerminalDestination(
                title: task.displayTitle,
                taskID: taskID,
                serverID: serverID,
                rpcClient: rpcClient,
                ptyClient: ptyClient,
                appStore: store,
                onTaskInfo: onTaskInfo
            )
        } else {
            TerminalUnavailableView(
                message: "The terminal connection is not ready. Return to Work and try again."
            )
        }
    }
}

@MainActor
private struct AvailableTaskTerminalDestination: View {
    let title: String
    let taskID: String
    let serverID: String
    let rpcClient: RPCClient
    let ptyClient: PTYClient
    let appStore: AppStore
    let onTaskInfo: () -> Void
    @State private var service: RPCTerminalTaskService?

    init(
        title: String,
        taskID: String,
        serverID: String,
        rpcClient: RPCClient,
        ptyClient: PTYClient,
        appStore: AppStore,
        onTaskInfo: @escaping () -> Void
    ) {
        self.title = title
        self.taskID = taskID
        self.serverID = serverID
        self.rpcClient = rpcClient
        self.ptyClient = ptyClient
        self.appStore = appStore
        self.onTaskInfo = onTaskInfo
    }

    var body: some View {
        Group {
            if let service {
                TaskTerminalScreen(title: title, service: service, onTaskInfo: onTaskInfo)
            } else {
                ProgressView("Opening terminal…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if service == nil {
                service = RPCTerminalTaskService(
                    taskID: taskID,
                    serverID: serverID,
                    rpcClient: rpcClient,
                    ptyClient: ptyClient,
                    clipboardText: appStore.clipboardStream(for: taskID)
                )
            }
        }
    }
}

private struct TerminalUnavailableView: View {
    let message: String

    var body: some View {
        ContentUnavailableView(
            "Terminal unavailable",
            systemImage: "terminal",
            description: Text(message)
        )
        .accessibilityIdentifier("terminal.unavailable")
    }
}

@MainActor
private struct TaskInfoDestination: View {
    let appStore: AppStore
    let projectID: String
    let taskID: String
    let onTerminalClosed: () -> Void
    private let connectionPolicy: TaskInfoConnectionPolicy
    @State private var infoStore: TaskInfoStore?
    @State private var pushObserverToken: UUID?

    init(
        appStore: AppStore,
        runtime: ConnectionRuntime?,
        projectID: String,
        taskID: String,
        onTerminalClosed: @escaping () -> Void
    ) {
        self.appStore = appStore
        self.projectID = projectID
        self.taskID = taskID
        self.onTerminalClosed = onTerminalClosed
        connectionPolicy = TaskInfoConnectionPolicy(hasLiveService: runtime?.rpcClient != nil)
        guard let task = appStore.task(projectId: projectID, taskId: taskID),
              let project = appStore.project(id: projectID)
        else {
            _infoStore = State(initialValue: nil)
            return
        }
        let service: any TaskInfoServicing = if let rpcClient = runtime?.rpcClient {
            RPCTaskInfoService(rpcClient: rpcClient)
        } else {
            OfflineTaskInfoService()
        }
        _infoStore = State(
            initialValue: TaskInfoStore(
                task: task,
                project: project,
                service: service,
                isConnected: connectionPolicy.canMutate(isConnected: appStore.isConnected),
                pushedPRStatus: appStore.prStatusByTask[taskID],
                onTaskChanged: { updated in
                    appStore.acceptTaskUpdate(updated)
                    if updated.status == .completed || updated.status == .cancelled {
                        onTerminalClosed()
                    }
                },
                onTasksChanged: { updated in
                    appStore.acceptTaskUpdates(updated)
                    if let current = updated.first(where: { $0.id == taskID }),
                       current.status == .completed || current.status == .cancelled
                    {
                        onTerminalClosed()
                    }
                },
                onDeleted: { deletedTaskID in
                    appStore.acceptTaskRemoval(taskId: deletedTaskID, projectId: projectID)
                    onTerminalClosed()
                }
            )
        )
    }

    var body: some View {
        if let infoStore {
            TaskInfoSheet(store: infoStore)
                .onAppear { startObservingPushes(infoStore) }
                .onDisappear(perform: stopObservingPushes)
                .onChange(of: appStore.isConnected, initial: true) { _, connected in
                    infoStore.setConnected(connectionPolicy.canMutate(isConnected: connected))
                }
                .onChange(of: appStore.task(projectId: projectID, taskId: taskID)) { _, task in
                    if let task {
                        infoStore.replace(task: task, project: appStore.project(id: projectID))
                    }
                }
        } else {
            ContentUnavailableView(
                "Task unavailable",
                systemImage: "questionmark.square.dashed",
                description: Text("This task is no longer present in the local cache.")
            )
        }
    }

    private func startObservingPushes(_ infoStore: TaskInfoStore) {
        guard pushObserverToken == nil else { return }
        pushObserverToken = appStore.addPushObserver { push in
            infoStore.receive(push)
        }
    }

    private func stopObservingPushes() {
        if let pushObserverToken {
            appStore.removePushObserver(pushObserverToken)
        }
        pushObserverToken = nil
    }
}

// swiftlint:enable opening_brace
// swiftlint:enable file_length
