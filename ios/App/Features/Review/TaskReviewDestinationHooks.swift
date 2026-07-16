import Dev3Kit
import Dev3UI
import Foundation
import SwiftUI

typealias TaskDiffDestinationHook = @MainActor (_ project: Dev3Project, _ task: Dev3Task) -> AnyView
typealias TaskPRStatusSheetHook = @MainActor (_ project: Dev3Project, _ task: Dev3Task) -> AnyView

struct TaskReviewDestinationHooks {
    let diffDestination: TaskDiffDestinationHook
    let prStatusSheet: TaskPRStatusSheetHook
}

@MainActor
enum TaskReviewDestinationFactory {
    static func make(
        appStore: AppStore,
        rpcClientProvider: @escaping @MainActor @Sendable () -> RPCClient?,
        serverID: String
    ) -> TaskReviewDestinationHooks {
        let readStore = LocalTaskDiffReadStore()
        return TaskReviewDestinationHooks(
            diffDestination: { project, task in
                let service = RPCTaskDiffService(rpcClientProvider: rpcClientProvider)
                let compareRef = preferredCompareRef(task: task, project: project)
                let store = TaskDiffStore(
                    serverID: serverID,
                    projectID: project.id,
                    taskID: task.id,
                    compareRef: compareRef,
                    compareLabel: compareRef,
                    isConnected: appStore.isConnected,
                    service: service,
                    readPersistence: readStore
                )
                return AnyView(TaskDiffDestinationHost(appStore: appStore, store: store))
            },
            prStatusSheet: { _, task in
                let service = RPCTaskPRStatusService(rpcClientProvider: rpcClientProvider)
                let store = TaskPRStatusStore(
                    task: task,
                    pushedStatus: appStore.prStatusByTask[task.id],
                    isConnected: appStore.isConnected,
                    service: service
                )
                return AnyView(TaskPRStatusDestinationHost(appStore: appStore, store: store))
            }
        )
    }

    private static func preferredCompareRef(task: Dev3Task, project: Dev3Project) -> String {
        let configured = project.defaultCompareRef?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let configured, !configured.isEmpty {
            return configured
        }
        if !task.baseBranch.isEmpty {
            return task.baseBranch
        }
        return project.defaultBaseBranch.isEmpty ? "main" : project.defaultBaseBranch
    }
}

@MainActor
private struct TaskDiffDestinationHost: View {
    let appStore: AppStore
    let store: TaskDiffStore

    var body: some View {
        TaskDiffScreen(store: store)
            .onChange(of: appStore.isConnected) { _, connected in
                store.setConnected(connected)
                if connected {
                    Task { await store.load() }
                }
            }
    }
}

@MainActor
private struct TaskPRStatusDestinationHost: View {
    let appStore: AppStore
    let store: TaskPRStatusStore
    @State private var pushObserverToken: UUID?

    var body: some View {
        TaskPRStatusScreen(store: store)
            .onAppear { startObservingPushes() }
            .onDisappear { stopObservingPushes() }
            .onChange(of: appStore.isConnected) { _, connected in
                store.setConnected(connected)
                if connected {
                    Task { await store.refresh() }
                }
            }
    }

    private func startObservingPushes() {
        guard pushObserverToken == nil else { return }
        pushObserverToken = appStore.addPushObserver { push in
            store.receive(push)
        }
    }

    private func stopObservingPushes() {
        if let pushObserverToken {
            appStore.removePushObserver(pushObserverToken)
        }
        pushObserverToken = nil
    }
}
