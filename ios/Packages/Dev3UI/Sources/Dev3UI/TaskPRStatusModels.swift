import Dev3Kit
import Foundation

// SwiftFormat keeps simple switch cases compact.
// swiftlint:disable switch_case_on_newline

public enum TaskPRCheckState: String, CaseIterable, Sendable {
    case failure
    case pending
    case success
    case unknown

    public init(check: Dev3PRCheck) {
        let verdict = (check.conclusion ?? check.status ?? "").uppercased()
        if [
            "FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED",
            "STARTUP_FAILURE"
        ].contains(verdict) {
            self = .failure
        } else if [
            "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"
        ].contains(verdict) {
            self = .pending
        } else if ["SUCCESS", "NEUTRAL", "SKIPPED"].contains(verdict) {
            self = .success
        } else {
            self = .unknown
        }
    }

    public var displayName: String {
        switch self {
        case .failure: "Failed"
        case .pending: "Pending"
        case .success: "Passed"
        case .unknown: "Unknown"
        }
    }

    fileprivate var sortOrder: Int {
        switch self {
        case .failure: 0
        case .pending: 1
        case .success: 2
        case .unknown: 3
        }
    }
}

public enum TaskPRMergeability: Equatable, Sendable {
    case mergeable
    case notMergeable(TaskPRMergeabilityReason?)
    case unknown
}

public enum TaskPRMergeabilityReason: String, Equatable, Sendable {
    case conflict
    case blocked
    case behind
    case draft
    case unstable
    case hooks

    public var displayName: String {
        switch self {
        case .conflict: "Merge conflicts"
        case .blocked: "Blocked by repository rules"
        case .behind: "Branch is behind its base"
        case .draft: "Pull request is a draft"
        case .unstable: "Required checks are unstable"
        case .hooks: "Repository hooks are blocking the merge"
        }
    }
}

public enum TaskPRMergeBlocker: Equatable, Sendable {
    case mergeState(TaskPRMergeabilityReason)
    case unresolvedThreads(Int)
    case reviewRequired
    case changesRequested
    case failedChecks([String])
    case pendingChecks([String])

    public var displayName: String {
        switch self {
        case let .mergeState(reason): reason.displayName
        case let .unresolvedThreads(count):
            count == 1 ? "1 unresolved review thread" : "\(count) unresolved review threads"
        case .reviewRequired: "Review approval is required"
        case .changesRequested: "Changes were requested"
        case let .failedChecks(checks): "Failed checks: \(checks.joined(separator: ", "))"
        case let .pendingChecks(checks): "Pending checks: \(checks.joined(separator: ", "))"
        }
    }
}

public struct TaskPRStatusDetail: Equatable, Sendable {
    public let projectID: String
    public let taskID: String
    public let number: Int
    public let url: String
    public let title: String?
    public let isDraft: Bool?
    public let autoMergeEnabled: Bool?
    public let ciStatus: String?
    public let reviewState: String?
    public let reviewDecision: String?
    public let unresolvedCount: Int?
    public let mergeState: Dev3PRMergeState?
    public let checks: [Dev3PRCheck]

    public init?(task: Dev3Task) {
        if let cache = task.prStatusCache {
            self.init(projectID: task.projectId, taskID: task.id, cache: cache)
            return
        }
        guard let number = task.prNumber, let url = task.prUrl else { return nil }
        self.init(
            projectID: task.projectId,
            taskID: task.id,
            number: number,
            url: url,
            title: nil,
            isDraft: nil,
            autoMergeEnabled: nil,
            ciStatus: nil,
            reviewState: nil,
            reviewDecision: nil,
            unresolvedCount: nil,
            mergeState: nil,
            checks: []
        )
    }

    public init?(push: TaskPRStatusPush) {
        guard let number = push.prNumber, let url = push.prUrl else { return nil }
        self.init(
            projectID: push.projectId,
            taskID: push.taskId,
            number: number,
            url: url,
            title: push.prTitle,
            isDraft: push.isDraft,
            autoMergeEnabled: push.autoMergeEnabled,
            ciStatus: push.ciStatus,
            reviewState: push.reviewState,
            reviewDecision: push.reviewDecision,
            unresolvedCount: push.unresolvedCount,
            mergeState: push.mergeState,
            checks: push.checks
        )
    }

    public init(projectID: String, taskID: String, cache: Dev3TaskPRStatus) {
        self.init(
            projectID: projectID,
            taskID: taskID,
            number: cache.number,
            url: cache.url,
            title: cache.prTitle,
            isDraft: cache.isDraft,
            autoMergeEnabled: cache.autoMergeEnabled,
            ciStatus: cache.ciStatus,
            reviewState: cache.reviewState,
            reviewDecision: cache.reviewDecision,
            unresolvedCount: cache.unresolvedCount,
            mergeState: cache.mergeState,
            checks: cache.checks
        )
    }

    public var sortedChecks: [Dev3PRCheck] {
        checks.enumerated()
            .sorted { left, right in
                let leftState = TaskPRCheckState(check: left.element).sortOrder
                let rightState = TaskPRCheckState(check: right.element).sortOrder
                return leftState == rightState ? left.offset < right.offset : leftState < rightState
            }
            .map(\.element)
    }

    public var mergeability: TaskPRMergeability {
        Self.summarizeMergeability(mergeState)
    }

    public var mergeBlockers: [TaskPRMergeBlocker] {
        guard case let .notMergeable(reason) = mergeability else { return [] }
        var blockers: [TaskPRMergeBlocker] = []
        if let reason, reason != .blocked {
            blockers.append(.mergeState(reason))
        }
        if let unresolvedCount, unresolvedCount > 0 {
            blockers.append(.unresolvedThreads(unresolvedCount))
        }
        if reviewDecision == "review_required" {
            blockers.append(.reviewRequired)
        } else if reviewDecision == "changes_requested" {
            blockers.append(.changesRequested)
        }

        let failed = uniqueCheckNames(state: .failure)
        if !failed.isEmpty {
            blockers.append(.failedChecks(failed))
        }
        let pending = uniqueCheckNames(state: .pending)
        if !pending.isEmpty {
            blockers.append(.pendingChecks(pending))
        }
        if blockers.isEmpty, let reason {
            blockers.append(.mergeState(reason))
        }
        return blockers
    }

    public static func summarizeMergeability(_ state: Dev3PRMergeState?) -> TaskPRMergeability {
        guard let state else { return .unknown }
        let mergeable = state.mergeable?.uppercased()
        let status = state.status?.uppercased()
        if mergeable == "CONFLICTING" || status == "DIRTY" {
            return .notMergeable(.conflict)
        }
        let blockedReasons: [String: TaskPRMergeabilityReason] = [
            "BLOCKED": .blocked,
            "BEHIND": .behind,
            "DRAFT": .draft,
            "UNSTABLE": .unstable,
            "HAS_HOOKS": .hooks
        ]
        if let status, let reason = blockedReasons[status] {
            return .notMergeable(reason)
        }
        if mergeable == "MERGEABLE" || status == "CLEAN" || status == "HAS_HOOKS" {
            return .mergeable
        }
        return .unknown
    }

    private init(
        projectID: String,
        taskID: String,
        number: Int,
        url: String,
        title: String?,
        isDraft: Bool?,
        autoMergeEnabled: Bool?,
        ciStatus: String?,
        reviewState: String?,
        reviewDecision: String?,
        unresolvedCount: Int?,
        mergeState: Dev3PRMergeState?,
        checks: [Dev3PRCheck]
    ) {
        self.projectID = projectID
        self.taskID = taskID
        self.number = number
        self.url = url
        self.title = title
        self.isDraft = isDraft
        self.autoMergeEnabled = autoMergeEnabled
        self.ciStatus = ciStatus
        self.reviewState = reviewState
        self.reviewDecision = reviewDecision
        self.unresolvedCount = unresolvedCount
        self.mergeState = mergeState
        self.checks = checks
    }

    private func uniqueCheckNames(state: TaskPRCheckState) -> [String] {
        var seen: Set<String> = []
        return checks.compactMap { check in
            guard TaskPRCheckState(check: check) == state else { return nil }
            let name = check.name.isEmpty ? "Unnamed check" : check.name
            guard seen.insert(name).inserted else { return nil }
            return name
        }
    }
}

public enum Dev3SafeExternalURL {
    public static func parse(_ rawValue: String?) -> URL? {
        guard let rawValue,
              let components = URLComponents(string: rawValue),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil
        else {
            return nil
        }
        return components.url
    }
}

// swiftlint:enable switch_case_on_newline
