import Foundation

public struct Dev3TaskMediaHistory: Equatable, Sendable {
    public var images: [Dev3SharedImage]
    public var artifacts: [Dev3SharedArtifact]
    public var selectedImageIndex: Int?
    public var selectedArtifactIndex: Int?

    public init(
        images: [Dev3SharedImage] = [],
        artifacts: [Dev3SharedArtifact] = [],
        selectedImageIndex: Int? = nil,
        selectedArtifactIndex: Int? = nil
    ) {
        self.images = images
        self.artifacts = artifacts
        self.selectedImageIndex = selectedImageIndex
        self.selectedArtifactIndex = selectedArtifactIndex
    }
}

public struct Dev3MediaCatalog: Equatable, Sendable {
    public private(set) var taskHistories: [String: Dev3TaskMediaHistory] = [:]

    public init() {}

    public func history(for taskID: String) -> Dev3TaskMediaHistory {
        taskHistories[taskID] ?? Dev3TaskMediaHistory()
    }

    public mutating func receive(_ push: CLIShowImagePush) {
        replaceImages(
            taskID: push.taskId,
            images: push.images,
            newCount: push.newCount
        )
    }

    public mutating func receive(_ push: CLIShowArtifactPush) {
        replaceArtifacts(
            taskID: push.taskId,
            artifacts: push.artifacts,
            newCount: push.newCount
        )
    }

    public mutating func seed(tasks: [Dev3Task]) {
        for task in tasks {
            if let images = task.sharedImages {
                replaceImages(taskID: task.id, images: images, newCount: 0)
            }
            if let artifacts = task.sharedArtifacts {
                replaceArtifacts(taskID: task.id, artifacts: artifacts, newCount: 0)
            }
        }
    }

    public mutating func replaceImages(
        taskID: String,
        images: [Dev3SharedImage],
        newCount: Int,
        initialIndex: Int? = nil
    ) {
        var history = history(for: taskID)
        let normalized = Self.normalizedImages(images)
        history.selectedImageIndex = Self.selection(
            currentIDs: history.images.map(\.id),
            currentIndex: history.selectedImageIndex,
            incomingIDs: normalized.map(\.id),
            newCount: newCount,
            initialIndex: initialIndex
        )
        history.images = normalized
        taskHistories[taskID] = history
    }

    public mutating func replaceArtifacts(
        taskID: String,
        artifacts: [Dev3SharedArtifact],
        newCount: Int,
        initialIndex: Int? = nil
    ) {
        var history = history(for: taskID)
        let normalized = Self.normalizedArtifacts(artifacts)
        history.selectedArtifactIndex = Self.selection(
            currentIDs: history.artifacts.map(\.id),
            currentIndex: history.selectedArtifactIndex,
            incomingIDs: normalized.map(\.id),
            newCount: newCount,
            initialIndex: initialIndex
        )
        history.artifacts = normalized
        taskHistories[taskID] = history
    }

    public mutating func selectImage(taskID: String, index: Int) {
        var history = history(for: taskID)
        guard history.images.indices.contains(index) else { return }
        history.selectedImageIndex = index
        taskHistories[taskID] = history
    }

    public mutating func selectArtifact(taskID: String, index: Int) {
        var history = history(for: taskID)
        guard history.artifacts.indices.contains(index) else { return }
        history.selectedArtifactIndex = index
        taskHistories[taskID] = history
    }

    public mutating func removeTask(_ taskID: String) {
        taskHistories[taskID] = nil
    }

    private static func selection(
        currentIDs: [String],
        currentIndex: Int?,
        incomingIDs: [String],
        newCount: Int,
        initialIndex: Int?
    ) -> Int? {
        guard !incomingIDs.isEmpty else { return nil }
        if let initialIndex {
            return min(max(initialIndex, 0), incomingIDs.count - 1)
        }
        return Dev3MediaHistory.replacementSelection(
            currentIDs: currentIDs,
            currentIndex: currentIndex,
            incomingIDs: incomingIDs,
            newCount: newCount
        )
    }

    private static func normalizedImages(_ values: [Dev3SharedImage]) -> [Dev3SharedImage] {
        let ids = Dev3MediaHistory.normalizedIDs(values.map(\.id), limit: 50)
        let newest = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        return ids.compactMap { newest[$0] }
    }

    private static func normalizedArtifacts(_ values: [Dev3SharedArtifact]) -> [Dev3SharedArtifact] {
        let ids = Dev3MediaHistory.normalizedIDs(values.map(\.id), limit: 20)
        let newest = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        return ids.compactMap { newest[$0] }
    }
}
