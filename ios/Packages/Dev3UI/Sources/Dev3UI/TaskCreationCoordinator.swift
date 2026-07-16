import Dev3Kit
import Foundation
import Observation

public typealias TaskCreationWarningHandler = @MainActor (_ warnings: [String]) -> Void

@MainActor
@Observable
public final class TaskCreationCoordinator {
    public private(set) var creationStore: TaskCreationStore?
    public private(set) var isPresented = false

    private let projectsProvider: @MainActor () -> [Dev3Project]
    private let serviceProvider: TaskCreationServiceProvider
    private let onEvent: TaskCreationEventHandler
    private let onWarning: TaskCreationWarningHandler
    private let onTerminalReady: TaskCreationTerminalHandler
    private var activeServerID: String?
    private var activeProvenance: TaskCreationProvenance?
    private var didPresentWarnings = false

    public init(
        projectsProvider: @escaping @MainActor () -> [Dev3Project],
        serviceProvider: @escaping TaskCreationServiceProvider,
        onEvent: @escaping TaskCreationEventHandler,
        onWarning: @escaping TaskCreationWarningHandler = { _ in },
        onTerminalReady: @escaping TaskCreationTerminalHandler
    ) {
        self.projectsProvider = projectsProvider
        self.serviceProvider = serviceProvider
        self.onEvent = onEvent
        self.onWarning = onWarning
        self.onTerminalReady = onTerminalReady
    }

    public func presentCreate(projectID: String? = nil) {
        present(context: .create, selectedProjectID: projectID)
    }

    public func presentRun(task: Dev3Task) {
        guard task.status == .todo else { return }
        present(context: .launchExisting(task), selectedProjectID: task.projectId)
    }

    public func cancelPresentation() {
        guard creationStore?.isSubmitting != true else {
            isPresented = true
            return
        }
        isPresented = false
        releaseStoreIfIdle()
    }

    public func submissionCompleted(for submittedStore: TaskCreationStore? = nil) {
        if let submittedStore, submittedStore !== creationStore {
            return
        }
        guard let creationStore else { return }
        presentWarningsIfNeeded(from: creationStore)
        isPresented = false
        releaseStoreIfIdle()
    }

    public func receive(_ push: RPCPushEvent, provenance: TaskCreationProvenance?) {
        guard let creationStore, let provenance else { return }
        creationStore.receive(push, provenance: provenance)
        releaseStoreIfIdle()
    }

    public func synchronize(
        projects: [Dev3Project],
        tasksByProject: [String: [Dev3Task]],
        activeServerID newServerID: String?,
        provenance: TaskCreationProvenance?
    ) async {
        guard let creationStore else { return }
        if let provenance, serviceProvider()?.provenance != provenance {
            return
        }
        creationStore.replaceProjects(projects)

        if activeServerID != newServerID {
            let hadActiveServer = activeServerID != nil
            activeServerID = newServerID
            activeProvenance = nil
            creationStore.activeServerChanged(to: newServerID)
            if hadActiveServer {
                isPresented = false
                self.creationStore = nil
                return
            }
        }

        if let provenance, provenance != activeProvenance {
            activeProvenance = provenance
            await creationStore.connectionChanged(to: provenance)
        }

        guard provenance == activeProvenance,
              newServerID == activeServerID,
              let activeProvenance,
              serviceProvider()?.provenance == activeProvenance,
              let pendingTaskID = creationStore.pendingTerminalTaskID
        else {
            releaseStoreIfIdle()
            return
        }
        guard let pending = tasksByProject.values
            .lazy
            .compactMap({ tasks in tasks.first { $0.id == pendingTaskID } })
            .first
        else {
            await creationStore.reconcilePendingTaskAbsence(provenance: activeProvenance)
            releaseStoreIfIdle()
            return
        }
        creationStore.receiveTaskUpdate(pending, provenance: activeProvenance)
        releaseStoreIfIdle()
    }
}

private extension TaskCreationCoordinator {
    func present(context: TaskCreationContext, selectedProjectID: String?) {
        guard creationStore == nil else {
            isPresented = true
            return
        }
        let binding = serviceProvider()
        activeProvenance = binding?.provenance
        activeServerID = binding?.provenance.serverID
        didPresentWarnings = false
        creationStore = TaskCreationStore(
            projects: projectsProvider(),
            selectedProjectID: selectedProjectID,
            context: context,
            serviceProvider: serviceProvider,
            onEvent: onEvent,
            onTerminalReady: { [weak self] projectID, taskID, provenance in
                self?.terminalBecameReady(
                    projectID: projectID,
                    taskID: taskID,
                    provenance: provenance
                )
            }
        )
        isPresented = true
    }

    func terminalBecameReady(
        projectID: String,
        taskID: String,
        provenance: TaskCreationProvenance
    ) {
        guard provenance == activeProvenance,
              serviceProvider()?.provenance == provenance
        else {
            return
        }
        if let creationStore {
            presentWarningsIfNeeded(from: creationStore)
        }
        isPresented = false
        creationStore = nil
        onTerminalReady(projectID, taskID, provenance)
    }

    func presentWarningsIfNeeded(from store: TaskCreationStore) {
        guard !didPresentWarnings else { return }
        didPresentWarnings = true
        onWarning(store.warningMessages)
    }

    func releaseStoreIfIdle() {
        guard !isPresented, creationStore?.pendingTerminalTaskID == nil else { return }
        creationStore = nil
    }
}
