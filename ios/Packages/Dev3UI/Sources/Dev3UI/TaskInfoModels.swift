import Dev3Kit
import Foundation

public enum TaskInfoDestination: Equatable, Identifiable, Sendable {
    case status(Dev3TaskStatus)
    case customColumn(id: String, name: String)

    public var id: String {
        switch self {
        case let .status(status):
            "status:\(status.rawValue)"
        case let .customColumn(id, _):
            "custom:\(id)"
        }
    }

    public var displayName: String {
        switch self {
        case let .status(status):
            status.taskInfoDisplayName
        case let .customColumn(_, name):
            name
        }
    }
}

public enum TaskInfoConfirmationKind: Equatable, Sendable {
    case terminalMove(Dev3TaskStatus)
    case delete
    case agentCompletion(requestID: String)
}

public struct TaskInfoConfirmation: Equatable, Identifiable, Sendable {
    public let kind: TaskInfoConfirmationKind
    public let title: String
    public let message: String
    public let confirmTitle: String
    public let cancelTitle: String
    public let isDestructive: Bool

    public init(
        kind: TaskInfoConfirmationKind,
        title: String,
        message: String,
        confirmTitle: String,
        cancelTitle: String = "Cancel",
        isDestructive: Bool = true
    ) {
        self.kind = kind
        self.title = title
        self.message = message
        self.confirmTitle = confirmTitle
        self.cancelTitle = cancelTitle
        self.isDestructive = isDestructive
    }

    public var id: String {
        switch kind {
        case let .terminalMove(status):
            "move:\(status.rawValue)"
        case .delete:
            "delete"
        case let .agentCompletion(requestID):
            "agent-completion:\(requestID)"
        }
    }
}

public enum TaskInfoCompletionPolicy {
    public static func confirmation(
        task: Dev3Task,
        project: Dev3Project,
        newStatus: Dev3TaskStatus,
        branchStatus: Dev3BranchStatus?
    ) -> TaskInfoConfirmation? {
        guard newStatus == .completed || newStatus == .cancelled else { return nil }
        guard task.worktreePath != nil, let branchStatus else { return nil }

        var warnings: [String] = []
        if branchStatus.insertions > 0 || branchStatus.deletions > 0 {
            warnings.append(
                "Uncommitted changes: +\(branchStatus.insertions) / " +
                    "-\(branchStatus.deletions) lines"
            )
        }
        if branchStatus.unpushed == -1, branchStatus.ahead > 0 {
            warnings.append("\(branchStatus.ahead) commit(s) never pushed — will be lost")
        } else if branchStatus.unpushed > 0 {
            warnings.append("\(branchStatus.unpushed) unpushed commit(s) — will be lost")
        }
        // SwiftFormat's multiline-brace rule intentionally differs from SwiftLint here.
        // swiftlint:disable opening_brace
        if branchStatus.unpushed >= 0,
           branchStatus.ahead > 0,
           !branchStatus.mergedByContent
        {
            let baseBranch = task.baseBranch.isEmpty ? project.defaultBaseBranch : task.baseBranch
            warnings.append(
                "\(branchStatus.ahead) commit(s) pushed but not merged into " +
                    "\(baseBranch.isEmpty ? "main" : baseBranch)"
            )
        }
        // swiftlint:enable opening_brace
        guard !warnings.isEmpty else { return nil }

        let warningList = warnings.map { "• \($0)" }.joined(separator: "\n")
        return TaskInfoConfirmation(
            kind: .terminalMove(newStatus),
            title: "Unsaved Changes",
            message: warningList + "\n\nThe worktree and branch will be deleted. Continue?",
            confirmTitle: newStatus == .completed ? "Complete task" : "Cancel task"
        )
    }

    public static func deleteConfirmation(task: Dev3Task) -> TaskInfoConfirmation {
        TaskInfoConfirmation(
            kind: .delete,
            title: "Delete",
            message: "Delete task \"\(task.displayTitle)\"?",
            confirmTitle: "Delete task"
        )
    }

    public static func cancelConfirmation(task: Dev3Task) -> TaskInfoConfirmation {
        TaskInfoConfirmation(
            kind: .terminalMove(.cancelled),
            title: "Cancel",
            message: "Cancel task \"\(task.displayTitle)\"?",
            confirmTitle: "Cancel task"
        )
    }

    public static func agentCompletionConfirmation(
        request: AgentCompletionRequestedPush
    ) -> TaskInfoConfirmation {
        var message = "The AI agent working on this task reports it is fully done and asks " +
            "to mark the task as completed.\n\nApproving will destroy the worktree and terminal session."
        // SwiftFormat's multiline-brace rule intentionally differs from SwiftLint here.
        // swiftlint:disable opening_brace
        if let overview = request.taskOverview?.trimmingCharacters(in: .whitespacesAndNewlines),
           !overview.isEmpty
        {
            message = "\(request.taskTitle)\n\(overview)\n\n\(message)"
        } else {
            message = "\(request.taskTitle)\n\n\(message)"
        }
        // swiftlint:enable opening_brace
        return TaskInfoConfirmation(
            kind: .agentCompletion(requestID: request.requestId),
            title: "Agent requests completion",
            message: message,
            confirmTitle: "Complete task",
            cancelTitle: "Keep session"
        )
    }
}

public extension Dev3TaskStatus {
    var taskInfoDisplayName: String {
        switch self {
        case .todo:
            "To do"
        case .inProgress:
            "Agent is working"
        case .userQuestions:
            "Has questions"
        case .reviewByAI:
            "AI review"
        case .reviewByUser:
            "Your review"
        case .reviewByColleague:
            "PR review"
        case .completed:
            "Completed"
        case .cancelled:
            "Cancelled"
        }
    }
}
