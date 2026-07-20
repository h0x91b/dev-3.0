import Foundation

// The v1 facade intentionally keeps the complete supported wire surface in one searchable file.
// swiftlint:disable file_length

public struct Dev3ProjectTasks: Codable, Equatable, Sendable {
    public let projectId: String
    public let tasks: [Dev3Task]
}

public enum Dev3TmuxAction: String, Codable, CaseIterable, Sendable {
    case splitH
    case splitV
    case zoom
    case killPane
    case nextPane
    case prevPane
    case newWindow
    case nextLayout
    case layoutTiled
    case layoutEvenH
    case layoutEvenV
    case layoutMainH
    case layoutMainV
}

public enum Dev3NavigationStep: String, Codable, Sendable {
    case next
    case previous = "prev"
}

public struct Dev3TmuxPaneCount: Codable, Equatable, Sendable {
    public let count: Int
}

public struct Dev3TmuxKillResult: Codable, Equatable, Sendable {
    public let killed: Bool
}

public struct Dev3ProjectPullResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let branch: String?
    public let output: String
    public let error: String
}

public enum Dev3RendererErrorSource: String, Codable, Sendable {
    case error
    case unhandledRejection = "unhandledrejection"
}

private struct ProjectIDParams: Encodable, Sendable {
    let projectId: String
}

private struct TaskIDParams: Encodable, Sendable {
    let taskId: String
}

private struct TaskProjectParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
}

private struct CreateTaskParams: Encodable, Sendable {
    let projectId: String
    let description: String
    let status: Dev3TaskStatus?
    let existingBranch: String?
    let scratch: Bool?
    let opsWorkDir: String?
    let priority: Dev3TaskPriority?
}

private struct EditTaskParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let description: String
}

private struct RenameTaskParams: Encodable, Sendable {
    enum CodingKeys: String, CodingKey {
        case taskId
        case projectId
        case customTitle
    }

    let taskId: String
    let projectId: String
    let customTitle: String?

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(taskId, forKey: .taskId)
        try container.encode(projectId, forKey: .projectId)
        if let customTitle {
            try container.encode(customTitle, forKey: .customTitle)
        } else {
            try container.encodeNil(forKey: .customTitle)
        }
    }
}

private struct MoveTaskParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let newStatus: Dev3TaskStatus
    let force: Bool?
    let clientPlayedSound: Bool?
}

private struct SetTaskPriorityParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let priority: Dev3TaskPriority
}

private struct ToggleTaskWatchParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let watched: Bool
}

private struct SetTaskLabelsParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let labelIds: [String]
}

private struct MoveTaskToCustomColumnParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let customColumnId: String?
}

private struct CreateLabelParams: Encodable, Sendable {
    let projectId: String
    let name: String
    let color: String?
}

private struct UpdateLabelParams: Encodable, Sendable {
    let projectId: String
    let labelId: String
    let name: String?
    let color: String?
}

private struct DeleteLabelParams: Encodable, Sendable {
    let projectId: String
    let labelId: String
}

private struct AddTaskNoteParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let content: String
    let source: Dev3NoteSource?
}

private struct UpdateTaskNoteParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let noteId: String
    let content: String
}

private struct DeleteTaskNoteParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let noteId: String
}

private struct SetUserOverviewParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let userOverview: String
}

private struct SpawnVariantsParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let targetStatus: Dev3TaskStatus
    let variants: [Dev3LaunchVariant]
}

private struct GetPTYURLParams: Encodable, Sendable {
    let taskId: String
    let resume: Bool?
}

private struct TmuxActionParams: Encodable, Sendable {
    let taskId: String
    let action: Dev3TmuxAction
    let force: Bool?
}

private struct TmuxPaneNavigateParams: Encodable, Sendable {
    let taskId: String
    let step: Dev3NavigationStep?
    let index: Int?
    let paneId: String?
    let zoom: Bool?
}

private struct TmuxWindowNavigateParams: Encodable, Sendable {
    let taskId: String
    let step: Dev3NavigationStep?
    let index: Int?
}

private struct TmuxKillPaneParams: Encodable, Sendable {
    let taskId: String
    let paneId: String
    let force: Bool?
}

private struct BranchStatusParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let compareRef: String?
}

private struct TaskDiffParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let mode: Dev3TaskDiffMode
    let compareRef: String?
    let compareLabel: String?
    let count: Int?
}

private struct CreatePullRequestParams: Encodable, Sendable {
    let taskId: String
    let projectId: String
    let autoMerge: Bool?
}

private struct ActiveContextParams: Encodable, Sendable {
    enum CodingKeys: String, CodingKey {
        case projectId
        case taskId
    }

    let projectId: String?
    let taskId: String?

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let projectId {
            try container.encode(projectId, forKey: .projectId)
        } else {
            try container.encodeNil(forKey: .projectId)
        }
        if let taskId {
            try container.encode(taskId, forKey: .taskId)
        } else {
            try container.encodeNil(forKey: .taskId)
        }
    }
}

private struct ForegroundParams: Encodable, Sendable {
    let focused: Bool
}

private struct TerminalFocusParams: Encodable, Sendable {
    let active: Bool
}

private struct RendererErrorParams: Encodable, Sendable {
    let description: String
    let source: Dev3RendererErrorSource
}

private struct AgentCompletionResponseParams: Encodable, Sendable {
    let requestId: String
    let approved: Bool
}

/// Typed wrappers for the native v1 method subset in `AppRPCSchema`.
public extension RPCClient {
    func getProjects() async throws -> [Dev3Project] {
        try await call("getProjects")
    }

    func getAllProjectTasks() async throws -> [Dev3ProjectTasks] {
        try await call("getAllProjectTasks")
    }

    func getTasks(projectId: String) async throws -> [Dev3Task] {
        try await call("getTasks", params: ProjectIDParams(projectId: projectId))
    }

    func createTask(
        projectId: String,
        description: String,
        status: Dev3TaskStatus? = nil,
        existingBranch: String? = nil,
        scratch: Bool? = nil,
        opsWorkDir: String? = nil,
        priority: Dev3TaskPriority? = nil
    ) async throws -> Dev3Task {
        try await call(
            "createTask",
            params: CreateTaskParams(
                projectId: projectId,
                description: description,
                status: status,
                existingBranch: existingBranch,
                scratch: scratch,
                opsWorkDir: opsWorkDir,
                priority: priority
            )
        )
    }

    func editTask(taskId: String, projectId: String, description: String) async throws -> Dev3Task {
        try await call(
            "editTask",
            params: EditTaskParams(taskId: taskId, projectId: projectId, description: description)
        )
    }

    func renameTask(taskId: String, projectId: String, customTitle: String?) async throws -> Dev3Task {
        try await call(
            "renameTask",
            params: RenameTaskParams(taskId: taskId, projectId: projectId, customTitle: customTitle)
        )
    }

    func moveTask(
        taskId: String,
        projectId: String,
        newStatus: Dev3TaskStatus,
        force: Bool? = nil,
        clientPlayedSound: Bool? = nil
    ) async throws -> Dev3Task {
        try await call(
            "moveTask",
            params: MoveTaskParams(
                taskId: taskId,
                projectId: projectId,
                newStatus: newStatus,
                force: force,
                clientPlayedSound: clientPlayedSound
            )
        )
    }

    func setTaskPriority(
        taskId: String,
        projectId: String,
        priority: Dev3TaskPriority
    ) async throws -> [Dev3Task] {
        try await call(
            "setTaskPriority",
            params: SetTaskPriorityParams(taskId: taskId, projectId: projectId, priority: priority)
        )
    }

    func toggleTaskWatch(
        taskId: String,
        projectId: String,
        watched: Bool
    ) async throws -> Dev3Task {
        try await call(
            "toggleTaskWatch",
            params: ToggleTaskWatchParams(taskId: taskId, projectId: projectId, watched: watched)
        )
    }

    func setTaskLabels(
        taskId: String,
        projectId: String,
        labelIds: [String]
    ) async throws -> Dev3Task {
        try await call(
            "setTaskLabels",
            params: SetTaskLabelsParams(taskId: taskId, projectId: projectId, labelIds: labelIds)
        )
    }

    func moveTaskToCustomColumn(
        taskId: String,
        projectId: String,
        customColumnId: String?
    ) async throws -> Dev3Task {
        try await call(
            "moveTaskToCustomColumn",
            params: MoveTaskToCustomColumnParams(
                taskId: taskId,
                projectId: projectId,
                customColumnId: customColumnId
            )
        )
    }

    func createLabel(projectId: String, name: String, color: String? = nil) async throws -> Dev3Label {
        try await call(
            "createLabel",
            params: CreateLabelParams(projectId: projectId, name: name, color: color)
        )
    }

    func updateLabel(
        projectId: String,
        labelId: String,
        name: String? = nil,
        color: String? = nil
    ) async throws -> Dev3Label {
        try await call(
            "updateLabel",
            params: UpdateLabelParams(projectId: projectId, labelId: labelId, name: name, color: color)
        )
    }

    func deleteLabel(projectId: String, labelId: String) async throws {
        try await callVoid(
            "deleteLabel",
            params: DeleteLabelParams(projectId: projectId, labelId: labelId)
        )
    }

    func addTaskNote(
        taskId: String,
        projectId: String,
        content: String,
        source: Dev3NoteSource? = nil
    ) async throws -> Dev3Task {
        try await call(
            "addTaskNote",
            params: AddTaskNoteParams(
                taskId: taskId,
                projectId: projectId,
                content: content,
                source: source
            )
        )
    }

    func updateTaskNote(
        taskId: String,
        projectId: String,
        noteId: String,
        content: String
    ) async throws -> Dev3Task {
        try await call(
            "updateTaskNote",
            params: UpdateTaskNoteParams(
                taskId: taskId,
                projectId: projectId,
                noteId: noteId,
                content: content
            )
        )
    }

    func deleteTaskNote(taskId: String, projectId: String, noteId: String) async throws -> Dev3Task {
        try await call(
            "deleteTaskNote",
            params: DeleteTaskNoteParams(taskId: taskId, projectId: projectId, noteId: noteId)
        )
    }

    func setUserOverview(
        taskId: String,
        projectId: String,
        userOverview: String
    ) async throws -> Dev3Task {
        try await call(
            "setUserOverview",
            params: SetUserOverviewParams(
                taskId: taskId,
                projectId: projectId,
                userOverview: userOverview
            )
        )
    }

    func deleteTask(taskId: String, projectId: String) async throws {
        try await callVoid(
            "deleteTask",
            params: TaskProjectParams(taskId: taskId, projectId: projectId)
        )
    }

    func spawnVariants(
        taskId: String,
        projectId: String,
        targetStatus: Dev3TaskStatus,
        variants: [Dev3LaunchVariant]
    ) async throws -> [Dev3Task] {
        try await call(
            "spawnVariants",
            params: SpawnVariantsParams(
                taskId: taskId,
                projectId: projectId,
                targetStatus: targetStatus,
                variants: variants
            )
        )
    }

    func getPtyUrl(taskId: String, resume: Bool? = nil) async throws -> Dev3PTYResolution {
        try await call(
            "getPtyUrl",
            params: GetPTYURLParams(taskId: taskId, resume: resume)
        )
    }

    func getProjectPtyUrl(projectId: String) async throws -> String {
        try await call("getProjectPtyUrl", params: ProjectIDParams(projectId: projectId))
    }

    func resumeTask(taskId: String) async throws -> String {
        try await call("resumeTask", params: TaskIDParams(taskId: taskId))
    }

    func restartTask(taskId: String) async throws -> String {
        try await call("restartTask", params: TaskIDParams(taskId: taskId))
    }

    /// Pins the tmux copy-mode scroll position before a resize so a pinch-zoom
    /// does not snap the view toward the bottom (issue E). No-op server-side when
    /// no pane is scrolled back.
    func anchorCopyModeScroll(taskId: String) async throws {
        try await callVoid("anchorCopyModeScroll", params: TaskIDParams(taskId: taskId))
    }

    func tmuxAction(taskId: String, action: Dev3TmuxAction, force: Bool? = nil) async throws {
        try await callVoid(
            "tmuxAction",
            params: TmuxActionParams(taskId: taskId, action: action, force: force)
        )
    }

    func tmuxPaneNavigate(
        taskId: String,
        step: Dev3NavigationStep? = nil,
        index: Int? = nil,
        paneId: String? = nil,
        zoom: Bool? = nil
    ) async throws -> Dev3TmuxPaneNavigation {
        try await call(
            "tmuxPaneNavigate",
            params: TmuxPaneNavigateParams(
                taskId: taskId,
                step: step,
                index: index,
                paneId: paneId,
                zoom: zoom
            )
        )
    }

    func tmuxWindowNavigate(
        taskId: String,
        step: Dev3NavigationStep? = nil,
        index: Int? = nil
    ) async throws -> Dev3TmuxWindowNavigation {
        try await call(
            "tmuxWindowNavigate",
            params: TmuxWindowNavigateParams(taskId: taskId, step: step, index: index)
        )
    }

    func tmuxPaneCount(taskId: String) async throws -> Dev3TmuxPaneCount {
        try await call("tmuxPaneCount", params: TaskIDParams(taskId: taskId))
    }

    func tmuxKillPane(
        taskId: String,
        paneId: String,
        force: Bool? = nil
    ) async throws -> Dev3TmuxKillResult {
        try await call(
            "tmuxKillPane",
            params: TmuxKillPaneParams(taskId: taskId, paneId: paneId, force: force)
        )
    }

    func getTerminalPreview(taskId: String) async throws -> String? {
        try await call("getTerminalPreview", params: TaskIDParams(taskId: taskId))
    }

    func getBranchStatus(
        taskId: String,
        projectId: String,
        compareRef: String? = nil
    ) async throws -> Dev3BranchStatus {
        try await call(
            "getBranchStatus",
            params: BranchStatusParams(taskId: taskId, projectId: projectId, compareRef: compareRef)
        )
    }

    func getTaskDiff(
        taskId: String,
        projectId: String,
        mode: Dev3TaskDiffMode,
        compareRef: String? = nil,
        compareLabel: String? = nil,
        count: Int? = nil
    ) async throws -> Dev3TaskDiff {
        try await call(
            "getTaskDiff",
            params: TaskDiffParams(
                taskId: taskId,
                projectId: projectId,
                mode: mode,
                compareRef: compareRef,
                compareLabel: compareLabel,
                count: count
            )
        )
    }

    func refreshTaskPrStatus(taskId: String, projectId: String) async throws {
        try await callVoid(
            "refreshTaskPrStatus",
            params: TaskProjectParams(taskId: taskId, projectId: projectId)
        )
    }

    func pushTask(taskId: String, projectId: String) async throws {
        try await callVoid(
            "pushTask",
            params: TaskProjectParams(taskId: taskId, projectId: projectId)
        )
    }

    func createPullRequest(
        taskId: String,
        projectId: String,
        autoMerge: Bool? = nil
    ) async throws {
        try await callVoid(
            "createPullRequest",
            params: CreatePullRequestParams(
                taskId: taskId,
                projectId: projectId,
                autoMerge: autoMerge
            )
        )
    }

    func pullProjectMain(projectId: String) async throws -> Dev3ProjectPullResult {
        try await call("pullProjectMain", params: ProjectIDParams(projectId: projectId))
    }

    func getAgents() async throws -> [Dev3CodingAgent] {
        try await call("getAgents")
    }

    func getGlobalSettings() async throws -> Dev3GlobalSettings {
        try await call("getGlobalSettings")
    }

    func getAppVersion() async throws -> Dev3AppVersion {
        try await call("getAppVersion")
    }

    func setActiveContext(projectId: String?, taskId: String?) async throws {
        try await callVoid(
            "setActiveContext",
            params: ActiveContextParams(projectId: projectId, taskId: taskId)
        )
    }

    func setWindowForeground(_ focused: Bool) async throws {
        try await callVoid("setWindowForeground", params: ForegroundParams(focused: focused))
    }

    func setTerminalFocus(_ active: Bool) async throws {
        try await callVoid("setTerminalFocus", params: TerminalFocusParams(active: active))
    }

    func respondToAgentCompletionRequest(requestId: String, approved: Bool) async throws {
        try await callVoid(
            "respondToAgentCompletionRequest",
            params: AgentCompletionResponseParams(requestId: requestId, approved: approved)
        )
    }

    func ping() async throws -> Dev3Ping {
        try await call("ping")
    }

    func logRendererError(
        description: String,
        source: Dev3RendererErrorSource
    ) async throws {
        try await callVoid(
            "logRendererError",
            params: RendererErrorParams(description: description, source: source)
        )
    }
}
