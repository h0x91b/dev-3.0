import Foundation

/// A lossless Codable value for forward-compatible fields and generic RPC payloads.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .integer(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

/// Wire source: src/shared/types.ts:32-40.
public enum Dev3TaskStatus: String, Codable, CaseIterable, Sendable {
    case todo
    case inProgress = "in-progress"
    case userQuestions = "user-questions"
    case reviewByAI = "review-by-ai"
    case reviewByUser = "review-by-user"
    case reviewByColleague = "review-by-colleague"
    case completed
    case cancelled
}

/// Wire source: src/shared/types.ts:152.
public enum Dev3TaskPriority: String, Codable, CaseIterable, Sendable {
    case p0 = "P0"
    case p1 = "P1"
    case p2 = "P2"
    case p3 = "P3"
    case p4 = "P4"
}

/// Wire source: src/shared/types.ts:794-798.
public struct Dev3Label: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let color: String

    public init(id: String, name: String, color: String) {
        self.id = id
        self.name = name
        self.color = color
    }
}

public struct Dev3ColumnAgentConfiguration: Codable, Equatable, Sendable {
    public let agentId: String
    public let configId: String
    public let prompt: String
}

public struct Dev3CustomColumn: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let color: String
    public let llmInstruction: String
    public let agentConfig: Dev3ColumnAgentConfiguration?
}

/// Wire source: src/shared/types.ts:910-962.
public struct Dev3Project: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case git
        case virtual
    }

    public let id: String
    public let name: String
    public let path: String
    public let setupScript: String
    public let setupScriptLaunchMode: String?
    public let devScript: String
    public let cleanupScript: String
    public let defaultBaseBranch: String
    public let defaultCompareRef: String?
    public let defaultCompareRefMode: String?
    public let githubAuthHost: String?
    public let githubAuthLogin: String?
    public let clonePaths: [String]?
    public let createdAt: String
    public let deleted: Bool?
    public let labels: [Dev3Label]?
    public let customColumns: [Dev3CustomColumn]?
    public let columnOrder: [String]?
    public let autoReviewEnabled: Bool?
    public let peerReviewEnabled: Bool?
    public let sparseCheckoutEnabled: Bool?
    public let sparseCheckoutPaths: [String]?
    public let builtinColumnAgents: [String: Dev3ColumnAgentConfiguration]?
    public let customStatusLabels: [String: String]?
    public let portCount: Int?
    public let kind: Kind?
    public let builtin: Bool?
}

public enum Dev3NoteSource: String, Codable, Sendable {
    case user
    case ai
}

/// Wire source: src/shared/types.ts:1730-1736.
public struct Dev3TaskNote: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let content: String
    public let source: Dev3NoteSource
    public let createdAt: String
    public let updatedAt: String
}

public struct Dev3PaneSession: Codable, Equatable, Sendable {
    public let paneId: String?
    public let agentCmd: String
    public let sessionId: String?
    public let agentId: String?
    public let configId: String?
    public let accountId: String?
}

/// Wire source: src/shared/types.ts:1601-1604.
public struct Dev3TaskSessionState: Codable, Equatable, Sendable {
    public let panes: [Dev3PaneSession]
}

public struct Dev3PRCheck: Codable, Equatable, Sendable {
    public let name: String
    public let status: String?
    public let conclusion: String?
    public let detailsUrl: String?
}

public struct Dev3PRMergeState: Codable, Equatable, Sendable {
    public let mergeable: String?
    public let status: String?
    public let state: String?
}

public struct Dev3TaskPRStatus: Codable, Equatable, Sendable {
    public let number: Int
    public let url: String
    public let autoMergeEnabled: Bool?
    public let ciStatus: String?
    public let reviewState: String?
    public let reviewDecision: String?
    public let unresolvedCount: Int?
    public let mergeState: Dev3PRMergeState?
    public let checks: [Dev3PRCheck]
    public let prTitle: String?
    public let isDraft: Bool?
    public let cachedAt: String
}

/// Wire source: src/shared/types.ts:1094-1324. Optional additive fields decode
/// without making older/newer backend versions incompatible with the v1 app.
public struct Dev3Task: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let seq: Int
    public let projectId: String
    public let title: String
    public let description: String
    public let overview: String?
    public let userOverview: String?
    public let customTitle: String?
    public let titleEditedByUser: Bool?
    public let status: Dev3TaskStatus
    public let priority: Dev3TaskPriority?
    public let baseBranch: String
    public let worktreePath: String?
    public let branchName: String?
    public let prNumber: Int?
    public let prUrl: String?
    public let prStatusCache: Dev3TaskPRStatus?
    public let groupId: String?
    public let variantIndex: Int?
    public let agentId: String?
    public let configId: String?
    public let accountId: String?
    public let createdAt: String
    public let updatedAt: String
    public let movedAt: String?
    public let lifecycleStartedAt: String?
    public let columnOrder: Int?
    public let tmuxSocket: String?
    public let labelIds: [String]?
    public let existingBranch: String?
    public let notes: [Dev3TaskNote]?
    public let customColumnId: String?
    public let preparing: Bool?
    public let preparingStage: String?
    public let preparingProgress: Int?
    public let preparingStartedAt: String?
    public let preparationError: String?
    public let shuttingDown: Bool?
    public let watched: Bool?
    public let sessionState: Dev3TaskSessionState?
    public let scratch: Bool?
    public let opsWorkDir: String?
    public let automationId: String?
    public let statusDurations: [String: Double]?
    public let statusEnteredAt: String?
    public let focusMs: Double?
    public let sharedImages: [Dev3SharedImage]?
    public let sharedArtifacts: [Dev3SharedArtifact]?

    public var displayTitle: String {
        if let customTitle, !customTitle.isEmpty {
            return customTitle
        }
        return title
    }

    public var displayOverview: String? {
        let user = userOverview?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let user, !user.isEmpty {
            return user
        }
        let agent = overview?.trimmingCharacters(in: .whitespacesAndNewlines)
        return agent?.isEmpty == false ? agent : nil
    }

    public var effectivePriority: Dev3TaskPriority {
        priority ?? .p3
    }
}

/// Wire source: src/shared/types.ts:1399-1404.
public struct Dev3LaunchVariant: Codable, Equatable, Sendable {
    public let agentId: String?
    public let configId: String?
    public let accountId: String?

    public init(agentId: String?, configId: String?, accountId: String? = nil) {
        self.agentId = agentId
        self.configId = configId
        self.accountId = accountId
    }
}

public struct Dev3AgentConfiguration: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    public let maxBudgetUsd: Double?
    public let appendPrompt: String?
    public let additionalArgs: [String]?
    public let envVars: [String: String]?
    public let baseCommandOverride: String?
    public let groupLabel: String?
    public let modeLabel: String?
    public let version: Int?
    public let requiresPxpipeProxy: Bool?
}

/// Wire source: src/shared/types.ts:254-280.
public struct Dev3CodingAgent: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let baseCommand: String
    public let isDefault: Bool?
    public let configurations: [Dev3AgentConfiguration]
    public let defaultConfigId: String?
    public let installCommand: String?
    public let installUrl: String?
}

/// Wire source: src/shared/types.ts:619-631.
public struct Dev3FavoriteAgentConfig: Codable, Equatable, Sendable {
    public let agentId: String
    public let configId: String
    public let uses: Double
    public let lastUsedAt: Double

    public init(agentId: String, configId: String, uses: Double, lastUsedAt: Double) {
        self.agentId = agentId
        self.configId = configId
        self.uses = uses
        self.lastUsedAt = lastUsedAt
    }
}

/// Wire source: src/shared/types.ts:634-699.
public struct Dev3GlobalSettings: Codable, Equatable, Sendable {
    public let defaultAgentId: String
    public let defaultConfigId: String
    public let taskDropPosition: String
    public let updateChannel: String
    public let theme: String?
    public let resolvedTheme: String?
    public let cloneBaseDirectory: String?
    public let terminalKeymap: String?
    public let playSoundOnTaskComplete: Bool?
    public let tipsDisabled: Bool?
    public let taskOpenMode: String?
    public let defaultDiffViewMode: String?
    public let preventSleepWhileRunning: Bool?
    public let skipQuitDialog: Bool?
    public let importShellEnv: Bool?
    public let focusMode: Bool?
    public let agentRateLimitTracking: Bool?
    public let watchByDefault: Bool?
    public let pxpipeProxyEnabled: Bool?
    public let favorites: [Dev3FavoriteAgentConfig]?
}

/// Wire source: src/shared/types.ts:1808-1823.
public struct Dev3BranchStatus: Codable, Equatable, Sendable {
    public struct FileStat: Codable, Equatable, Sendable {
        public let path: String
        public let insertions: Int
        public let deletions: Int
    }

    public let ahead: Int
    public let behind: Int
    public let canRebase: Bool
    public let insertions: Int
    public let deletions: Int
    public let unpushed: Int
    public let mergedByContent: Bool
    public let diffFiles: Int
    public let diffInsertions: Int
    public let diffDeletions: Int
    public let diffFileStats: [FileStat]
    public let prNumber: Int?
    public let prUrl: String?
    public let mergeCompletionFingerprint: String?
}

public enum Dev3TaskDiffMode: String, Codable, Sendable {
    case branch
    case uncommitted
    case unpushed
    case recent
}

public struct Dev3TaskDiffSummary: Codable, Equatable, Sendable {
    public let files: Int
    public let insertions: Int
    public let deletions: Int
}

public struct Dev3TaskDiffFile: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: String
    public let displayPath: String
    public let oldPath: String?
    public let newPath: String?
    public let oldContent: String
    public let newContent: String
    public let hunks: [String]?
    public let insertions: Int
    public let deletions: Int
}

public struct Dev3SkippedDiffFile: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let status: String
    public let reason: String
    public let displayPath: String
    public let oldPath: String?
    public let newPath: String?
    public let oldSize: Int?
    public let newSize: Int?
}

/// Wire source: src/shared/types.ts:1871-1883.
public struct Dev3TaskDiff: Codable, Equatable, Sendable {
    public let mode: Dev3TaskDiffMode
    public let compareRef: String?
    public let compareLabel: String
    public let fallbackReason: String?
    public let recentCount: Int?
    public let summary: Dev3TaskDiffSummary
    public let files: [Dev3TaskDiffFile]
    public let skippedFiles: [Dev3SkippedDiffFile]
}

public struct Dev3AppVersion: Codable, Equatable, Sendable {
    public let version: String
    public let channel: String
    public let buildChannel: String
}

public struct Dev3Ping: Codable, Equatable, Sendable {
    public let ok: Bool
    public let serverTime: Double

    private enum CodingKeys: String, CodingKey {
        case ok
        case serverTime = "t"
    }
}

public struct Dev3TmuxPaneNavigation: Codable, Equatable, Sendable {
    public let count: Int
    public let activeIndex: Int
    public let zoomed: Bool
    public let labels: [String]
}

public struct Dev3TmuxWindowNavigation: Codable, Equatable, Sendable {
    public let count: Int
    public let activeIndex: Int
    public let labels: [String]
}

public struct Dev3PTYURL: Codable, Equatable, Sendable {
    public let url: String
}

public enum Dev3PTYResolution: Decodable, Equatable, Sendable {
    case ready(url: String)
    case needsResume(Dev3TaskSessionState)

    private enum CodingKeys: String, CodingKey {
        case url
        case recoverable
        case sessionState
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let url = try container.decodeIfPresent(String.self, forKey: .url) {
            self = .ready(url: url)
            return
        }
        let recoverable = try container.decodeIfPresent(Bool.self, forKey: .recoverable)
        guard recoverable == true else {
            throw DecodingError.dataCorruptedError(
                forKey: .recoverable,
                in: container,
                debugDescription: "Expected a PTY URL or recoverable session state"
            )
        }
        self = try .needsResume(container.decode(Dev3TaskSessionState.self, forKey: .sessionState))
    }
}
