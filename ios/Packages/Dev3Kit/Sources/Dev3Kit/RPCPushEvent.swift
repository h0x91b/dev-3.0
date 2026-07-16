import Foundation

public struct TaskUpdatedPush: Codable, Equatable, Sendable {
    public let projectId: String
    public let task: Dev3Task
}

public struct TaskRemovedPush: Codable, Equatable, Sendable {
    public let projectId: String
    public let taskId: String
}

public struct TaskPreparationFailedPush: Codable, Equatable, Sendable {
    public let taskId: String
    public let projectId: String
    public let taskTitle: String
    public let error: String
}

public struct ProjectUpdatedPush: Codable, Equatable, Sendable {
    public let project: Dev3Project
}

public struct TaskIdentifierPush: Codable, Equatable, Sendable {
    public let taskId: String
}

public struct ProjectIdentifierPush: Codable, Equatable, Sendable {
    public let projectId: String
}

public struct TaskPRStatusPush: Codable, Equatable, Sendable {
    public let projectId: String
    public let taskId: String
    public let prNumber: Int?
    public let prUrl: String?
    public let autoMergeEnabled: Bool?
    public let ciStatus: String?
    public let reviewState: String?
    public let reviewDecision: String?
    public let unresolvedCount: Int?
    public let mergeState: Dev3PRMergeState?
    public let checks: [Dev3PRCheck]
    public let prTitle: String?
    public let isDraft: Bool?
}

public enum Dev3NotificationLevel: String, Codable, Equatable, Sendable {
    case info
    case success
    case error
}

public struct CLIToastPush: Codable, Equatable, Sendable {
    public let taskId: String?
    public let projectId: String?
    public let message: String
    public let level: Dev3NotificationLevel
    public let durationMs: Int?
    public let taskSeq: Int?
    public let taskTitle: String?
    public let projectName: String?
}

public struct CLIAttentionPush: Codable, Equatable, Sendable {
    public let taskId: String
    public let reason: String
}

public struct WebNotificationPush: Codable, Equatable, Sendable {
    public let taskId: String
    public let projectId: String
    public let title: String
    public let body: String
    public let level: Dev3NotificationLevel
    public let taskSeq: Int?
    public let taskTitle: String?
    public let projectName: String?
}

public struct AgentCompletionRequestedPush: Codable, Equatable, Sendable {
    public let requestId: String
    public let taskId: String
    public let projectId: String
    public let taskTitle: String
    public let taskOverview: String?
}

public struct OSC52ClipboardPush: Codable, Equatable, Sendable {
    public let taskId: String
    public let text: String
    public let len: Int
}

public struct Dev3SharedImage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let storedPath: String
    public let originalPath: String
    public let name: String
    public let mime: String
    public let bytes: Int
    public let caption: String?
    public let createdAt: Double
}

public struct Dev3SharedArtifactAsset: Codable, Equatable, Sendable {
    public let name: String
    public let storedPath: String
    public let originalPath: String
    public let mime: String
    public let bytes: Int
}

public struct Dev3SharedArtifact: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let name: String
    public let storedPath: String
    public let originalPath: String
    public let bytes: Int
    public let createdAt: Double
    public let assets: [Dev3SharedArtifactAsset]
    public let bundlePath: String?
    public let bundleBytes: Int?
}

public struct CLIShowImagePush: Codable, Equatable, Sendable {
    public let taskId: String
    public let projectId: String
    public let images: [Dev3SharedImage]
    public let newCount: Int
    public let taskSeq: Int
    public let taskTitle: String
    public let projectName: String
}

public struct CLIShowArtifactPush: Codable, Equatable, Sendable {
    public let taskId: String
    public let projectId: String
    public let artifacts: [Dev3SharedArtifact]
    public let newCount: Int
    public let taskSeq: Int
    public let taskTitle: String
    public let projectName: String
}

/// Typed v1 push catalog. Unknown events remain observable for forward compatibility.
public enum RPCPushEvent: Equatable, Sendable {
    case taskUpdated(TaskUpdatedPush)
    case taskRemoved(TaskRemovedPush)
    case taskPreparationFailed(TaskPreparationFailedPush)
    case projectUpdated(ProjectUpdatedPush)
    case taskPRStatus(TaskPRStatusPush)
    case ptyDied(TaskIdentifierPush)
    case projectPtyDied(ProjectIdentifierPush)
    case terminalBell(TaskIdentifierPush)
    case cliToast(CLIToastPush)
    case cliAttention(CLIAttentionPush)
    case cliShowImage(CLIShowImagePush)
    case cliShowArtifact(CLIShowArtifactPush)
    case webNotification(WebNotificationPush)
    case agentCompletionRequested(AgentCompletionRequestedPush)
    case osc52Clipboard(OSC52ClipboardPush)
    case qrTokenConsumed
    case unknown(name: String, payload: JSONValue)

    static func decode(name: String, payload: JSONValue) throws -> RPCPushEvent {
        switch name {
        case "taskUpdated":
            try .taskUpdated(payload.decode(TaskUpdatedPush.self))
        case "taskRemoved":
            try .taskRemoved(payload.decode(TaskRemovedPush.self))
        case "taskPreparationFailed":
            try .taskPreparationFailed(payload.decode(TaskPreparationFailedPush.self))
        case "projectUpdated":
            try .projectUpdated(payload.decode(ProjectUpdatedPush.self))
        case "taskPrStatus":
            try .taskPRStatus(payload.decode(TaskPRStatusPush.self))
        case "ptyDied":
            try .ptyDied(payload.decode(TaskIdentifierPush.self))
        default:
            try decodeInteraction(name: name, payload: payload)
        }
    }

    private static func decodeInteraction(name: String, payload: JSONValue) throws -> RPCPushEvent {
        switch name {
        case "projectPtyDied":
            try .projectPtyDied(payload.decode(ProjectIdentifierPush.self))
        case "terminalBell":
            try .terminalBell(payload.decode(TaskIdentifierPush.self))
        case "cliToast":
            try .cliToast(payload.decode(CLIToastPush.self))
        case "cliAttention":
            try .cliAttention(payload.decode(CLIAttentionPush.self))
        case "cliShowImage":
            try .cliShowImage(payload.decode(CLIShowImagePush.self))
        case "cliShowArtifact":
            try .cliShowArtifact(payload.decode(CLIShowArtifactPush.self))
        default:
            try decodeNotification(name: name, payload: payload)
        }
    }

    private static func decodeNotification(name: String, payload: JSONValue) throws -> RPCPushEvent {
        switch name {
        case "webNotification":
            try .webNotification(payload.decode(WebNotificationPush.self))
        case "agentCompletionRequested":
            try .agentCompletionRequested(payload.decode(AgentCompletionRequestedPush.self))
        case "osc52Clipboard":
            try .osc52Clipboard(payload.decode(OSC52ClipboardPush.self))
        case "qrTokenConsumed":
            .qrTokenConsumed
        default:
            .unknown(name: name, payload: payload)
        }
    }
}

extension JSONValue {
    func decode<Value: Decodable>(_ type: Value.Type) throws -> Value {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}
