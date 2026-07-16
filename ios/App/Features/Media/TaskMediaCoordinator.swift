import Dev3Kit
import Dev3UI
import Foundation
import Observation

@MainActor
protocol TaskMediaPushObserving: AnyObject {
    var taskMediaPushContext: TaskMediaPushContext { get }

    @discardableResult
    func addPushObserver(_ observer: @escaping @MainActor (RPCPushEvent) -> Void) -> UUID
    func removePushObserver(_ token: UUID)
}

struct TaskMediaPushContext: Equatable {
    let rpcGeneration: UUID
    let serverID: String?
    let snapshotServerID: String?
}

extension AppStore: TaskMediaPushObserving {
    var taskMediaPushContext: TaskMediaPushContext {
        TaskMediaPushContext(
            rpcGeneration: rpcGeneration,
            serverID: controller.activeServer?.instanceId,
            snapshotServerID: snapshotServerID
        )
    }
}

@MainActor
@Observable
final class TaskMediaCoordinator {
    private(set) var mediaStore: TaskMediaStore

    @ObservationIgnored private weak var pushSource: (any TaskMediaPushObserving)?
    @ObservationIgnored private let serviceProviderFactory: @MainActor () -> any TaskMediaServiceProviding
    @ObservationIgnored private var pushObserverToken: UUID?
    @ObservationIgnored private var rpcGeneration: UUID?
    @ObservationIgnored private var serverID: String?
    @ObservationIgnored private var snapshotServerID: String?
    @ObservationIgnored private var acceptsPushes = false

    init(
        pushSource: any TaskMediaPushObserving,
        serviceProviderFactory: @escaping @MainActor () -> any TaskMediaServiceProviding
    ) {
        self.pushSource = pushSource
        self.serviceProviderFactory = serviceProviderFactory
        mediaStore = TaskMediaStore(serviceProvider: UnavailableTaskMediaServiceProvider())
    }

    func start() {
        guard pushObserverToken == nil, let pushSource else { return }
        pushObserverToken = pushSource.addPushObserver { [weak self] push in
            guard let self, let context = self.pushSource?.taskMediaPushContext else { return }
            if !matches(context) {
                synchronizeContext(
                    rpcGeneration: context.rpcGeneration,
                    serverID: context.serverID,
                    snapshotServerID: context.snapshotServerID
                )
            }
            guard acceptsPushes else { return }
            mediaStore.receive(push)
        }
    }

    func synchronize(
        tasksByProject: [String: [Dev3Task]],
        rpcGeneration: UUID,
        serverID: String?,
        snapshotServerID: String?
    ) {
        synchronizeContext(
            rpcGeneration: rpcGeneration,
            serverID: serverID,
            snapshotServerID: snapshotServerID
        )
        guard acceptsPushes else { return }
        mediaStore.seed(tasks: tasksByProject.values.flatMap(\.self))
    }

    private func synchronizeContext(
        rpcGeneration: UUID,
        serverID: String?,
        snapshotServerID: String?
    ) {
        if self.serverID != serverID {
            retireCurrentStore()
            mediaStore = TaskMediaStore(serviceProvider: UnavailableTaskMediaServiceProvider())
            self.serverID = serverID
            self.rpcGeneration = nil
            if let serverID, snapshotServerID == serverID {
                mediaStore.rebindServiceProvider(serviceProviderFactory())
                self.rpcGeneration = rpcGeneration
            }
        } else if self.rpcGeneration != rpcGeneration {
            acceptsPushes = false
            if serverID != nil {
                mediaStore.rebindServiceProvider(serviceProviderFactory())
            }
            self.rpcGeneration = rpcGeneration
        }
        self.snapshotServerID = snapshotServerID
        acceptsPushes = serverID != nil && snapshotServerID == serverID && self.rpcGeneration == rpcGeneration
    }

    func stop() {
        if let pushObserverToken {
            pushSource?.removePushObserver(pushObserverToken)
        }
        pushObserverToken = nil
        rpcGeneration = nil
        snapshotServerID = nil
        acceptsPushes = false
        mediaStore.closePresentation()
        mediaStore.rebindServiceProvider(UnavailableTaskMediaServiceProvider())
    }

    private func retireCurrentStore() {
        acceptsPushes = false
        mediaStore.closePresentation()
        mediaStore.rebindServiceProvider(UnavailableTaskMediaServiceProvider())
    }

    private func matches(_ context: TaskMediaPushContext) -> Bool {
        rpcGeneration == context.rpcGeneration &&
            serverID == context.serverID &&
            snapshotServerID == context.snapshotServerID
    }
}
