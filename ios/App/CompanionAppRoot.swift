import Dev3Kit
import Dev3TerminalKit
import Dev3UI
import SwiftUI

// SwiftFormat's wrapped conditional style conflicts with SwiftLint's opening-brace rule.
// swiftlint:disable opening_brace

@MainActor
struct CompanionAppRoot: View {
    let store: AppStore
    let runtime: ConnectionRuntime?
    @State private var presentedTaskInfo: PresentedTaskInfo?

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
            onOpenTaskInfo: presentTaskInfo
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
    }

    private func presentTaskInfo(projectID: String, taskID: String) {
        presentedTaskInfo = PresentedTaskInfo(projectID: projectID, taskID: taskID)
    }
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
