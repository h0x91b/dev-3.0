import Dev3Kit
import Foundation
import Observation

public struct TaskDiffFetchRequest: Equatable, Sendable {
    public let taskID: String
    public let projectID: String
    public let mode: Dev3TaskDiffMode
    public let compareRef: String?
    public let compareLabel: String?
    public let count: Int?

    public init(
        taskID: String,
        projectID: String,
        mode: Dev3TaskDiffMode,
        compareRef: String?,
        compareLabel: String?,
        count: Int?
    ) {
        self.taskID = taskID
        self.projectID = projectID
        self.mode = mode
        self.compareRef = compareRef
        self.compareLabel = compareLabel
        self.count = count
    }
}

public protocol TaskDiffServicing: Sendable {
    func taskDiff(_ request: TaskDiffFetchRequest) async throws -> Dev3TaskDiff
}

public protocol TaskDiffReadPersisting: Sendable {
    func readSignatures(serverID: String, taskID: String) async -> Set<String>
    func setRead(
        _ isRead: Bool,
        signature: String,
        serverID: String,
        taskID: String
    ) async
}

public enum TaskDiffScreenPhase: Equatable, Sendable {
    case offline
    case loading
    case empty
    case content
    case failed(String)
}

@MainActor
@Observable
public final class TaskDiffStore {
    public let serverID: String
    public let projectID: String
    public let taskID: String

    public private(set) var selection: TaskDiffModeSelection
    public private(set) var compareRef: String
    public private(set) var compareLabel: String
    public private(set) var payload: Dev3TaskDiff?
    public private(set) var isConnected: Bool
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var readSignatures: Set<String> = []

    private let service: any TaskDiffServicing
    private let readPersistence: any TaskDiffReadPersisting
    private var requestGeneration = 0
    private var loadedReadState = false

    public init(
        serverID: String,
        projectID: String,
        taskID: String,
        compareRef: String,
        compareLabel: String? = nil,
        initialSelection: TaskDiffModeSelection = .uncommitted,
        isConnected: Bool,
        service: any TaskDiffServicing,
        readPersistence: any TaskDiffReadPersisting
    ) {
        self.serverID = serverID
        self.projectID = projectID
        self.taskID = taskID
        self.compareRef = compareRef
        self.compareLabel = compareLabel ?? compareRef
        selection = initialSelection
        self.isConnected = isConnected
        self.service = service
        self.readPersistence = readPersistence
    }

    public var phase: TaskDiffScreenPhase {
        if payload == nil, !isConnected {
            return .offline
        }
        if payload == nil, isLoading {
            return .loading
        }
        if let errorMessage, payload == nil {
            return .failed(errorMessage)
        }
        guard let payload else {
            return .loading
        }
        if payload.files.isEmpty, payload.skippedFiles.isEmpty {
            return .empty
        }
        return .content
    }

    public var sortedFiles: [Dev3TaskDiffFile] {
        payload?.files.sorted {
            $0.displayPath.localizedStandardCompare($1.displayPath) == .orderedAscending
        } ?? []
    }

    public var sortedSkippedFiles: [Dev3SkippedDiffFile] {
        payload?.skippedFiles.sorted {
            $0.displayPath.localizedStandardCompare($1.displayPath) == .orderedAscending
        } ?? []
    }

    public var fileSummaries: [TaskDiffFileSummary] {
        let files = sortedFiles.map(TaskDiffFileSummary.init(file:))
        let skipped = sortedSkippedFiles.map(TaskDiffFileSummary.init(skippedFile:))
        return (files + skipped).sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    public func setConnected(_ connected: Bool) {
        isConnected = connected
        if connected {
            errorMessage = nil
        } else {
            requestGeneration += 1
            isLoading = false
        }
    }

    public func load() async {
        guard isConnected else { return }
        if !loadedReadState {
            let persisted = await readPersistence.readSignatures(serverID: serverID, taskID: taskID)
            guard isConnected else { return }
            readSignatures = persisted
            loadedReadState = true
        }

        requestGeneration += 1
        let generation = requestGeneration
        isLoading = true
        errorMessage = nil
        defer {
            if requestGeneration == generation {
                isLoading = false
            }
        }
        do {
            let requestRef = selection.mode == .branch || selection.mode == .unpushed
                ? normalizedCompareRef
                : nil
            let result = try await service.taskDiff(TaskDiffFetchRequest(
                taskID: taskID,
                projectID: projectID,
                mode: selection.mode,
                compareRef: requestRef,
                compareLabel: requestRef == nil ? nil : compareLabel,
                count: selection.count
            ))
            guard requestGeneration == generation else { return }
            payload = result
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            errorMessage = "Could not load the diff: \(error.localizedDescription)"
        }
    }

    public func select(_ nextSelection: TaskDiffModeSelection) async {
        guard isConnected, selection != nextSelection else { return }
        selection = nextSelection
        await load()
    }

    public func updateCompareRef(_ ref: String, label: String? = nil) async {
        let trimmed = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isConnected, !trimmed.isEmpty else { return }
        compareRef = trimmed
        compareLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? trimmed
        if selection.mode == .branch || selection.mode == .unpushed {
            await load()
        }
    }

    public func isRead(_ file: Dev3TaskDiffFile) -> Bool {
        readSignatures.contains(TaskDiffReadSignature.make(taskID: taskID, file: file))
    }

    public func isRead(_ file: Dev3SkippedDiffFile) -> Bool {
        readSignatures.contains(TaskDiffReadSignature.make(taskID: taskID, skippedFile: file))
    }

    public func toggleRead(_ file: Dev3TaskDiffFile) async {
        await toggle(signature: TaskDiffReadSignature.make(taskID: taskID, file: file))
    }

    public func toggleRead(_ file: Dev3SkippedDiffFile) async {
        await toggle(signature: TaskDiffReadSignature.make(taskID: taskID, skippedFile: file))
    }

    public func setAllRead(_ read: Bool) async {
        let signatures = sortedFiles.map { TaskDiffReadSignature.make(taskID: taskID, file: $0) } +
            sortedSkippedFiles.map { TaskDiffReadSignature.make(taskID: taskID, skippedFile: $0) }
        for signature in signatures {
            if read {
                readSignatures.insert(signature)
            } else {
                readSignatures.remove(signature)
            }
        }
        await withTaskGroup(of: Void.self) { group in
            for signature in signatures {
                group.addTask { [readPersistence, serverID, taskID] in
                    await readPersistence.setRead(
                        read,
                        signature: signature,
                        serverID: serverID,
                        taskID: taskID
                    )
                }
            }
        }
    }

    private var normalizedCompareRef: String? {
        let trimmed = compareRef.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func toggle(signature: String) async {
        let nextRead: Bool
        if readSignatures.remove(signature) != nil {
            nextRead = false
        } else {
            readSignatures.insert(signature)
            nextRead = true
        }
        await readPersistence.setRead(
            nextRead,
            signature: signature,
            serverID: serverID,
            taskID: taskID
        )
    }
}

private extension String {
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}
