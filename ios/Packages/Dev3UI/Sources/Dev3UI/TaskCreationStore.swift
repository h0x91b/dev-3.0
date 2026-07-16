import Dev3Kit
import Foundation
import Observation

// swiftlint:disable file_length

public protocol TaskCreationServicing: Sendable {
    func getAgents() async throws -> [Dev3CodingAgent]
    func getGlobalSettings() async throws -> Dev3GlobalSettings
    func createTask(
        projectID: String,
        description: String,
        priority: Dev3TaskPriority
    ) async throws -> Dev3Task
    func renameTask(taskID: String, projectID: String, customTitle: String) async throws -> Dev3Task
    func setTaskLabels(taskID: String, projectID: String, labelIDs: [String]) async throws -> Dev3Task
    func setTaskWatched(taskID: String, projectID: String, watched: Bool) async throws -> Dev3Task
    func spawnVariants(
        taskID: String,
        projectID: String,
        variants: [Dev3LaunchVariant]
    ) async throws -> [Dev3Task]
    func getTasks(projectID: String) async throws -> [Dev3Task]
}

public struct TaskCreationServiceBinding: Sendable {
    public let provenance: TaskCreationProvenance
    public let service: any TaskCreationServicing

    public init(provenance: TaskCreationProvenance, service: any TaskCreationServicing) {
        self.provenance = provenance
        self.service = service
    }
}

public typealias TaskCreationServiceProvider =
    @MainActor () -> TaskCreationServiceBinding?

public typealias TaskCreationEventHandler =
    @MainActor (TaskCreationEvent) -> Void

public typealias TaskCreationTerminalHandler =
    @MainActor (_ projectID: String, _ taskID: String, _ provenance: TaskCreationProvenance) -> Void

@MainActor
@Observable
// The transaction store keeps one observable lifecycle so in-flight mutations cannot be orphaned.
// swiftlint:disable type_body_length
public final class TaskCreationStore {
    public let context: TaskCreationContext
    public private(set) var projects: [Dev3Project]
    public private(set) var agents: [Dev3CodingAgent] = []
    public private(set) var settings: Dev3GlobalSettings?
    public private(set) var isLoading = false
    public private(set) var isSubmitting = false
    public private(set) var errorMessage: String?
    public private(set) var warningMessages: [String] = []
    public private(set) var pendingTerminalTaskID: String?
    public private(set) var lastCreatedTaskID: String?
    public private(set) var hasUncertainMutation = false

    public var selectedProjectID: String? {
        didSet { projectSelectionChanged(from: oldValue) }
    }

    public var title = ""
    public var descriptionText = ""
    public var selectedLabelIDs: Set<String> = []
    public var priority = Dev3TaskPriority.p3
    public var watched = false
    public var variants = [TaskCreationVariant(agentID: nil, configurationID: nil)]

    private let serviceProvider: TaskCreationServiceProvider
    private let onEvent: TaskCreationEventHandler
    private let onTerminalReady: TaskCreationTerminalHandler
    private var loadRequestID = UUID()
    private var pendingTerminalProvenance: TaskCreationProvenance?

    public init(
        projects: [Dev3Project],
        selectedProjectID: String? = nil,
        context: TaskCreationContext = .create,
        serviceProvider: @escaping TaskCreationServiceProvider,
        onEvent: @escaping TaskCreationEventHandler = { _ in },
        onTerminalReady: @escaping TaskCreationTerminalHandler = { _, _, _ in }
    ) {
        self.context = context
        self.projects = Self.availableProjects(projects)
        self.serviceProvider = serviceProvider
        self.onEvent = onEvent
        self.onTerminalReady = onTerminalReady
        let contextProjectID = if case let .launchExisting(task) = context {
            task.projectId
        } else {
            selectedProjectID
        }
        self.selectedProjectID = Self.validProjectID(
            projects: self.projects,
            preferredID: contextProjectID
        )
    }

    public var existingTask: Dev3Task? {
        guard case let .launchExisting(task) = context else { return nil }
        return task
    }

    public var isLaunchingExistingTask: Bool {
        existingTask != nil
    }

    public var selectedProject: Dev3Project? {
        guard let selectedProjectID else { return nil }
        return projects.first { $0.id == selectedProjectID }
    }

    public var availableLabels: [Dev3Label] {
        (selectedProject?.labels ?? []).sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    public var favoriteOptions: [TaskCreationFavoriteOption] {
        guard let settings else { return [] }
        return TaskCreationAgentResolver.favoriteOptions(agents: agents, settings: settings)
    }

    public var canAddVariant: Bool {
        selectedProject?.kind != .virtual && !agents.isEmpty
    }

    public var canSubmit: Bool {
        let hasSource = existingTask != nil ||
            !descriptionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return !isLoading && !isSubmitting && !hasUncertainMutation && selectedProject != nil && hasSource
    }

    public func replaceProjects(_ updatedProjects: [Dev3Project]) {
        projects = Self.availableProjects(updatedProjects)
        selectedProjectID = Self.validProjectID(
            projects: projects,
            preferredID: selectedProjectID
        )
    }

    public func load(preservingSelections: Bool = false) async {
        guard let binding = serviceProvider() else {
            resetForUnavailableConnection()
            return
        }
        let requestID = UUID()
        loadRequestID = requestID
        isLoading = true
        defer {
            if loadRequestID == requestID {
                isLoading = false
            }
        }
        errorMessage = nil
        let provenance = binding.provenance
        let priorWatched = watched
        let priorVariants = variants
        do {
            async let agents = binding.service.getAgents()
            async let settings = binding.service.getGlobalSettings()
            let loaded = try await (agents, settings)
            guard owns(provenance), loadRequestID == requestID else { return }
            self.agents = loaded.0
            self.settings = loaded.1
            if preservingSelections {
                watched = priorWatched
                variants = preserveValidVariants(
                    priorVariants,
                    agents: loaded.0,
                    settings: loaded.1
                )
            } else {
                watched = existingTask?.watched ?? loaded.1.watchByDefault ?? false
                variants = [TaskCreationAgentResolver.defaultVariant(agents: loaded.0, settings: loaded.1)]
            }
            clampVariantsForSelectedProject()
        } catch {
            guard owns(provenance), loadRequestID == requestID else { return }
            errorMessage = "Could not load launch options: \(error.localizedDescription)"
        }
    }

    public func connectionChanged(to provenance: TaskCreationProvenance) async {
        if pendingTerminalProvenance?.serverID == provenance.serverID {
            pendingTerminalProvenance = provenance
        } else {
            pendingTerminalTaskID = nil
            pendingTerminalProvenance = nil
        }
        await load(preservingSelections: true)
    }

    public func activeServerChanged(to serverID: String?) {
        guard pendingTerminalProvenance?.serverID != serverID else { return }
        pendingTerminalTaskID = nil
        pendingTerminalProvenance = nil
    }

    public func dismissError() {
        errorMessage = nil
    }

    func shouldDismissAfterSubmission(
        mode: TaskCreationMode,
        result: TaskCreationLaunchResult?
    ) -> Bool {
        switch mode {
        case .save:
            lastCreatedTaskID != nil && !hasUncertainMutation
        case .saveAndStart:
            result != nil
        }
    }

    public func addVariant() {
        guard canAddVariant, let settings else { return }
        variants.append(TaskCreationAgentResolver.defaultVariant(agents: agents, settings: settings))
    }

    public func removeVariant(id: UUID) {
        guard variants.count > 1 else { return }
        variants.removeAll { $0.id == id }
    }

    public func selectAgent(_ agentID: String, for variantID: UUID) {
        guard let settings,
              let agent = agents.first(where: { $0.id == agentID }),
              let index = variants.firstIndex(where: { $0.id == variantID })
        else {
            return
        }
        variants[index].agentID = agentID
        variants[index].configurationID = TaskCreationAgentResolver.defaultConfiguration(
            for: agent,
            settings: settings
        )?.id
        variants[index].accountID = nil
    }

    public func selectConfiguration(_ configurationID: String, for variantID: UUID) {
        guard let settings,
              let index = variants.firstIndex(where: { $0.id == variantID }),
              let agentID = variants[index].agentID,
              let agent = agents.first(where: { $0.id == agentID }),
              let configuration = agent.configurations.first(where: { $0.id == configurationID }),
              TaskCreationAgentResolver.isConfigurationEnabled(configuration, settings: settings)
        else {
            return
        }
        variants[index].configurationID = configurationID
    }

    public func applyFavorite(_ favorite: TaskCreationFavoriteOption, to variantID: UUID) {
        guard favorite.isEnabled,
              favoriteOptions.contains(where: { $0.id == favorite.id && $0.isEnabled }),
              let index = variants.firstIndex(where: { $0.id == variantID })
        else {
            return
        }
        variants[index].agentID = favorite.agentID
        variants[index].configurationID = favorite.configurationID
        variants[index].accountID = nil
    }

    @discardableResult
    // The transaction stays linear so every RPC result is provenance-checked before its follow-up.
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public func submit(_ mode: TaskCreationMode) async -> TaskCreationLaunchResult? {
        guard !isSubmitting, !hasUncertainMutation else { return nil }
        warningMessages = []
        errorMessage = nil
        lastCreatedTaskID = nil

        let project: Dev3Project
        do {
            project = try validatedProject(for: mode)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
        guard let binding = serviceProvider() else {
            errorMessage = "Reconnect to dev3 before creating a task."
            return nil
        }

        isSubmitting = true
        defer { isSubmitting = false }
        let provenance = binding.provenance
        let description = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)

        if let existingTask {
            guard mode == .saveAndStart else {
                errorMessage = TaskCreationValidationError.existingTaskUnavailable.localizedDescription
                return nil
            }
            return await launch(
                sourceTask: existingTask,
                project: project,
                binding: binding,
                provenance: provenance
            )
        }

        let createdTask: Dev3Task
        do {
            createdTask = try await binding.service.createTask(
                projectID: project.id,
                description: description,
                priority: priority
            )
        } catch {
            await reconcileAmbiguousMutation(
                projectID: project.id,
                binding: binding,
                action: "creation"
            )
            return nil
        }
        guard continueTransaction(provenance), createdTask.projectId == project.id else {
            await reconcileAmbiguousMutation(
                projectID: project.id,
                binding: binding,
                action: "creation"
            )
            return nil
        }
        lastCreatedTaskID = createdTask.id
        onEvent(.created(createdTask, provenance: provenance))

        var currentTask = createdTask
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTitle.isEmpty {
            do {
                currentTask = try await binding.service.renameTask(
                    taskID: createdTask.id,
                    projectID: project.id,
                    customTitle: trimmedTitle
                )
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                onEvent(.updated(currentTask, provenance: provenance))
            } catch {
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                warningMessages.append("The task was created, but its title could not be updated.")
            }
        }

        if !selectedLabelIDs.isEmpty {
            do {
                currentTask = try await binding.service.setTaskLabels(
                    taskID: createdTask.id,
                    projectID: project.id,
                    labelIDs: selectedLabelIDs.sorted()
                )
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                onEvent(.updated(currentTask, provenance: provenance))
            } catch {
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                warningMessages.append("The task was created, but its labels could not be updated.")
            }
        }

        let serverWatched = currentTask.watched ?? settings?.watchByDefault ?? false
        if watched != serverWatched {
            do {
                currentTask = try await binding.service.setTaskWatched(
                    taskID: createdTask.id,
                    projectID: project.id,
                    watched: watched
                )
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                onEvent(.updated(currentTask, provenance: provenance))
            } catch {
                guard continueCreatedTaskTransaction(provenance) else { return nil }
                warningMessages.append("The task was created, but its watch setting could not be updated.")
            }
        }

        guard mode == .saveAndStart else { return nil }
        return await launch(
            sourceTask: createdTask,
            project: project,
            binding: binding,
            provenance: provenance
        )
    }

    public func receiveTaskUpdate(_ task: Dev3Task, provenance: TaskCreationProvenance) {
        guard task.id == pendingTerminalTaskID,
              provenance == pendingTerminalProvenance,
              owns(provenance)
        else {
            return
        }
        evaluateTerminalReadiness(task, provenance: provenance)
    }

    public func pendingTaskRemoved(provenance: TaskCreationProvenance) {
        guard let taskID = pendingTerminalTaskID,
              provenance == pendingTerminalProvenance,
              owns(provenance)
        else {
            return
        }
        pendingTerminalTaskID = nil
        pendingTerminalProvenance = nil
        let message = "The launched task is no longer available, so its terminal was not opened."
        errorMessage = message
        onEvent(
            .launchMissing(
                projectID: selectedProjectID ?? existingTask?.projectId ?? "",
                taskID: taskID,
                provenance: provenance,
                message: message
            )
        )
    }
}

// swiftlint:enable type_body_length

private extension TaskCreationStore {
    func launch(
        sourceTask: Dev3Task,
        project: Dev3Project,
        binding: TaskCreationServiceBinding,
        provenance: TaskCreationProvenance
    ) async -> TaskCreationLaunchResult? {
        let launchVariants = effectiveVariants(for: project).map(\.launchVariant)
        do {
            let spawnedTasks = try await binding.service.spawnVariants(
                taskID: sourceTask.id,
                projectID: project.id,
                variants: launchVariants
            )
            guard continueTransaction(provenance),
                  !spawnedTasks.isEmpty,
                  spawnedTasks.allSatisfy({ $0.projectId == project.id })
            else {
                await reconcileAmbiguousMutation(
                    projectID: project.id,
                    binding: binding,
                    action: "launch"
                )
                return nil
            }
            let result = TaskCreationLaunchResult(
                sourceTaskID: sourceTask.id,
                projectID: project.id,
                variants: spawnedTasks,
                provenance: provenance
            )
            onEvent(.replaced(result))
            if let first = spawnedTasks.first {
                pendingTerminalTaskID = first.id
                pendingTerminalProvenance = provenance
                evaluateTerminalReadiness(first, provenance: provenance)
            }
            return result
        } catch {
            await reconcileAmbiguousMutation(
                projectID: project.id,
                binding: binding,
                action: "launch"
            )
            return nil
        }
    }

    static func availableProjects(_ projects: [Dev3Project]) -> [Dev3Project] {
        projects
            .filter { $0.deleted != true }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func validProjectID(projects: [Dev3Project], preferredID: String?) -> String? {
        if let preferredID, projects.contains(where: { $0.id == preferredID }) {
            return preferredID
        }
        return nil
    }

    func projectSelectionChanged(from oldValue: String?) {
        guard selectedProjectID != oldValue else { return }
        selectedLabelIDs = []
        clampVariantsForSelectedProject()
    }

    func clampVariantsForSelectedProject() {
        guard selectedProject?.kind == .virtual, variants.count > 1 else { return }
        variants = [variants[0]]
    }

    func effectiveVariants(for project: Dev3Project) -> [TaskCreationVariant] {
        project.kind == .virtual ? Array(variants.prefix(1)) : variants
    }

    func preserveValidVariants(
        _ priorVariants: [TaskCreationVariant],
        agents: [Dev3CodingAgent],
        settings: Dev3GlobalSettings
    ) -> [TaskCreationVariant] {
        let fallback = TaskCreationAgentResolver.defaultVariant(agents: agents, settings: settings)
        return priorVariants.map { variant in
            if TaskCreationAgentResolver.isVariantSelectable(
                variant,
                agents: agents,
                settings: settings
            ) {
                return variant
            }
            return TaskCreationVariant(
                id: variant.id,
                agentID: fallback.agentID,
                configurationID: fallback.configurationID
            )
        }
    }

    func validatedProject(for mode: TaskCreationMode) throws -> Dev3Project {
        guard let project = selectedProject else {
            throw TaskCreationValidationError.projectUnavailable
        }
        if let existingTask {
            guard existingTask.status == .todo,
                  existingTask.projectId == project.id,
                  mode == .saveAndStart
            else {
                throw TaskCreationValidationError.existingTaskUnavailable
            }
        } else {
            guard !descriptionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw TaskCreationValidationError.descriptionRequired
            }
        }
        guard mode == .saveAndStart else { return project }
        guard let settings else {
            throw TaskCreationValidationError.noSelectableAgent
        }
        let launchVariants = effectiveVariants(for: project)
        guard !launchVariants.isEmpty else {
            throw TaskCreationValidationError.noSelectableAgent
        }
        let invalidVariantIndex = launchVariants.firstIndex {
            !TaskCreationAgentResolver.isVariantSelectable(
                $0,
                agents: agents,
                settings: settings
            )
        }
        if let index = invalidVariantIndex {
            throw TaskCreationValidationError.invalidVariant(index)
        }
        return project
    }

    func owns(_ provenance: TaskCreationProvenance) -> Bool {
        serviceProvider()?.provenance == provenance
    }

    func continueTransaction(_ provenance: TaskCreationProvenance) -> Bool {
        guard owns(provenance) else {
            errorMessage = "The active dev3 connection changed. Review the board before continuing."
            return false
        }
        return true
    }

    func continueCreatedTaskTransaction(_ provenance: TaskCreationProvenance) -> Bool {
        guard owns(provenance) else {
            hasUncertainMutation = true
            errorMessage = "The task was created, but the active dev3 connection changed. " +
                "Inspect the refreshed board before trying again."
            return false
        }
        return true
    }

    func resetForUnavailableConnection() {
        agents = []
        settings = nil
        loadRequestID = UUID()
        pendingTerminalTaskID = nil
        pendingTerminalProvenance = nil
        isLoading = false
        errorMessage = "Reconnect to dev3 to load task creation options."
    }

    func reconcileAmbiguousMutation(
        projectID: String,
        binding: TaskCreationServiceBinding,
        action: String
    ) async {
        hasUncertainMutation = true
        guard owns(binding.provenance) else {
            errorMessage = "The active dev3 connection changed. Review the board before continuing."
            return
        }
        let tasks = try? await binding.service.getTasks(projectID: projectID)
        if let tasks, owns(binding.provenance) {
            onEvent(
                .reconciled(
                    projectID: projectID,
                    tasks: tasks,
                    provenance: binding.provenance
                )
            )
        }
        guard owns(binding.provenance) else {
            errorMessage = "The active dev3 connection changed. Review the board before continuing."
            return
        }
        errorMessage = "The task \(action) result was uncertain. " +
            "Inspect the refreshed board before trying again."
    }

    func evaluateTerminalReadiness(_ task: Dev3Task, provenance: TaskCreationProvenance) {
        let preparationError = task.preparationError?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preparationError, !preparationError.isEmpty {
            pendingTerminalTaskID = nil
            pendingTerminalProvenance = nil
            errorMessage = "Task preparation failed: \(preparationError)"
            onEvent(.preparationFailed(task, provenance: provenance))
            return
        }
        guard task.shuttingDown != true, Self.isTerminalStatus(task.status) else {
            pendingTerminalTaskID = nil
            pendingTerminalProvenance = nil
            let message = task.shuttingDown == true
                ? "The task started shutting down before its terminal became ready."
                : "The task is no longer active, so its terminal was not opened."
            errorMessage = message
            onEvent(.launchUnavailable(task, provenance: provenance, message: message))
            return
        }
        if task.preparing == false, task.worktreePath == nil {
            pendingTerminalTaskID = nil
            pendingTerminalProvenance = nil
            let message = "Task preparation ended before its terminal became available."
            errorMessage = message
            onEvent(.launchUnavailable(task, provenance: provenance, message: message))
            return
        }
        guard task.preparing != true, task.worktreePath != nil else { return }
        pendingTerminalTaskID = nil
        pendingTerminalProvenance = nil
        onTerminalReady(task.projectId, task.id, provenance)
    }

    static func isTerminalStatus(_ status: Dev3TaskStatus) -> Bool {
        switch status {
        case .inProgress, .userQuestions, .reviewByAI, .reviewByUser, .reviewByColleague:
            true
        case .todo, .completed, .cancelled:
            false
        }
    }
}
