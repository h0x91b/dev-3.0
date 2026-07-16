import Dev3Kit
import Foundation
import Observation

enum TaskMediaPresentation: Equatable, Identifiable, Sendable {
    case image(taskID: String)
    case artifact(taskID: String)

    var id: String {
        switch self {
        case let .image(taskID):
            "image:\(taskID)"
        case let .artifact(taskID):
            "artifact:\(taskID)"
        }
    }

    var taskID: String {
        switch self {
        case let .image(taskID), let .artifact(taskID):
            taskID
        }
    }
}

enum TaskArtifactLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded(Dev3ArtifactWebBundle)
    case failed(String)
}

struct TaskMediaSharePayload: Identifiable, Sendable {
    let id = UUID()
    let data: Data
    let mime: String
    let fileName: String
}

@MainActor
@Observable
final class TaskMediaStore {
    private(set) var catalog = Dev3MediaCatalog()
    private(set) var imageCache: [String: Data] = [:]
    private(set) var imageErrors: [String: String] = [:]
    private(set) var imageLoadingKeys = Set<String>()
    private(set) var artifactState = TaskArtifactLoadState.idle
    var presentation: TaskMediaPresentation?
    var isArtifactFullscreen = false
    var sharePayload: TaskMediaSharePayload?
    var transientError: String?

    @ObservationIgnored private var imageTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var imageLoadIDs: [String: UUID] = [:]
    @ObservationIgnored private var artifactTask: Task<Void, Never>?
    @ObservationIgnored private var artifactLoadID: UUID?
    @ObservationIgnored private var historyPrefetchTask: Task<Void, Never>?
    @ObservationIgnored private var shareTask: Task<Void, Never>?
    @ObservationIgnored private var serviceProvider: any TaskMediaServiceProviding

    init(serviceProvider: any TaskMediaServiceProviding) {
        self.serviceProvider = serviceProvider
    }

    var images: [Dev3SharedImage] {
        guard let taskID = presentation?.taskID else { return [] }
        return catalog.history(for: taskID).images
    }

    var artifacts: [Dev3SharedArtifact] {
        guard let taskID = presentation?.taskID else { return [] }
        return catalog.history(for: taskID).artifacts
    }

    var selectedImageIndex: Int? {
        guard let taskID = presentation?.taskID else { return nil }
        return catalog.history(for: taskID).selectedImageIndex
    }

    var selectedArtifactIndex: Int? {
        guard let taskID = presentation?.taskID else { return nil }
        return catalog.history(for: taskID).selectedArtifactIndex
    }

    var currentImage: Dev3SharedImage? {
        guard let selectedImageIndex, images.indices.contains(selectedImageIndex) else { return nil }
        return images[selectedImageIndex]
    }

    var currentArtifact: Dev3SharedArtifact? {
        guard let selectedArtifactIndex,
              artifacts.indices.contains(selectedArtifactIndex) else { return nil }
        return artifacts[selectedArtifactIndex]
    }
}

extension TaskMediaStore {
    func imageData(for image: Dev3SharedImage) -> Data? {
        guard let taskID = presentation?.taskID else { return nil }
        return imageCache[cacheKey(taskID: taskID, mediaID: image.id)]
    }

    func imageError(for image: Dev3SharedImage) -> String? {
        guard let taskID = presentation?.taskID else { return nil }
        return imageErrors[cacheKey(taskID: taskID, mediaID: image.id)]
    }

    func seed(tasks: [Dev3Task]) {
        var updated = catalog
        updated.seed(tasks: tasks)
        catalog = updated
    }

    func rebindServiceProvider(_ serviceProvider: any TaskMediaServiceProviding) {
        cancelActiveRequests()
        self.serviceProvider = serviceProvider
        imageCache.removeAll()
        imageErrors.removeAll()
        sharePayload = nil
        transientError = nil

        switch presentation {
        case .image:
            loadSelectedImageAndNeighbors()
        case .artifact:
            loadSelectedArtifact()
        case nil:
            break
        }
    }

    func receive(_ event: RPCPushEvent) {
        switch event {
        case let .cliShowImage(push):
            receive(push)
        case let .cliShowArtifact(push):
            receive(push)
        case let .taskRemoved(push):
            removeTask(push.taskId)
        default:
            break
        }
    }

    func receive(_ push: CLIShowImagePush) {
        var updated = catalog
        updated.receive(push)
        catalog = updated
        presentation = .image(taskID: push.taskId)
        trimImageCache()
        loadSelectedImageAndNeighbors()
    }

    func receive(_ push: CLIShowArtifactPush) {
        var updated = catalog
        updated.receive(push)
        catalog = updated
        presentation = .artifact(taskID: push.taskId)
        loadSelectedArtifact()
    }

    func showImages(
        taskID: String,
        images: [Dev3SharedImage],
        newCount: Int = 0,
        initialIndex: Int? = nil
    ) {
        var updated = catalog
        updated.replaceImages(
            taskID: taskID,
            images: images,
            newCount: newCount,
            initialIndex: initialIndex
        )
        catalog = updated
        guard !updated.history(for: taskID).images.isEmpty else { return }
        presentation = .image(taskID: taskID)
        trimImageCache()
        loadSelectedImageAndNeighbors()
    }

    func showArtifacts(
        taskID: String,
        artifacts: [Dev3SharedArtifact],
        newCount: Int = 0,
        initialIndex: Int? = nil
    ) {
        var updated = catalog
        updated.replaceArtifacts(
            taskID: taskID,
            artifacts: artifacts,
            newCount: newCount,
            initialIndex: initialIndex
        )
        catalog = updated
        guard !updated.history(for: taskID).artifacts.isEmpty else { return }
        presentation = .artifact(taskID: taskID)
        loadSelectedArtifact()
    }

    func showSeededImages(taskID: String, initialIndex: Int? = nil) {
        let history = catalog.history(for: taskID)
        showImages(taskID: taskID, images: history.images, initialIndex: initialIndex)
    }

    func showSeededArtifacts(taskID: String, initialIndex: Int? = nil) {
        let history = catalog.history(for: taskID)
        showArtifacts(taskID: taskID, artifacts: history.artifacts, initialIndex: initialIndex)
    }

    func closePresentation() {
        presentation = nil
        isArtifactFullscreen = false
    }

    func removeTask(_ taskID: String) {
        let wasPresented = presentation?.taskID == taskID
        var updated = catalog
        updated.removeTask(taskID)
        catalog = updated

        let prefix = cacheKey(taskID: taskID, mediaID: "")
        imageCache = imageCache.filter { !$0.key.hasPrefix(prefix) }
        imageErrors = imageErrors.filter { !$0.key.hasPrefix(prefix) }
        let removedKeys = imageTasks.keys.filter { $0.hasPrefix(prefix) }
        for key in removedKeys {
            imageTasks[key]?.cancel()
            imageTasks[key] = nil
            imageLoadIDs[key] = nil
            imageLoadingKeys.remove(key)
        }

        guard wasPresented else { return }
        cancelActiveRequests()
        artifactState = .idle
        sharePayload = nil
        transientError = nil
        closePresentation()
    }
}

extension TaskMediaStore {
    func selectImage(_ index: Int) {
        guard case let .image(taskID) = presentation else { return }
        var updated = catalog
        updated.selectImage(taskID: taskID, index: index)
        catalog = updated
        loadSelectedImageAndNeighbors()
    }

    func moveImage(by delta: Int) {
        guard let selectedImageIndex else { return }
        selectImage(min(max(selectedImageIndex + delta, 0), images.count - 1))
    }

    func selectArtifact(_ index: Int) {
        guard case let .artifact(taskID) = presentation else { return }
        var updated = catalog
        updated.selectArtifact(taskID: taskID, index: index)
        catalog = updated
        loadSelectedArtifact()
    }

    func moveArtifact(by delta: Int) {
        guard let selectedArtifactIndex else { return }
        selectArtifact(min(max(selectedArtifactIndex + delta, 0), artifacts.count - 1))
    }

    func prefetchImageHistory() {
        guard case let .image(taskID) = presentation else { return }
        historyPrefetchTask?.cancel()
        let pending = images.filter { image in
            let key = cacheKey(taskID: taskID, mediaID: image.id)
            return imageCache[key] == nil && imageErrors[key] == nil
        }
        historyPrefetchTask = Task { [weak self] in
            for image in pending {
                guard !Task.isCancelled else { return }
                self?.loadImageIfNeeded(image, taskID: taskID)
                await self?.waitForImage(image.id, taskID: taskID)
            }
        }
    }

    func prepareImageShare() {
        guard case let .image(taskID) = presentation,
              let image = currentImage else { return }
        let key = cacheKey(taskID: taskID, mediaID: image.id)
        let service = serviceProvider.service(for: taskID)
        shareTask?.cancel()
        shareTask = Task { [weak self] in
            guard let self else { return }
            do {
                let binary: TaskMediaBinary
                if let data = imageCache[key] {
                    binary = TaskMediaBinary(data: data, mime: image.mime, fileName: image.name)
                } else {
                    binary = try await service.loadImage(image)
                    guard !Task.isCancelled else { return }
                    imageCache[key] = binary.data
                }
                guard !Task.isCancelled else { return }
                sharePayload = TaskMediaSharePayload(
                    data: binary.data,
                    mime: binary.mime,
                    fileName: binary.fileName
                )
            } catch {
                guard !Task.isCancelled else { return }
                transientError = error.localizedDescription
            }
            shareTask = nil
        }
    }

    func prepareArtifactShare() {
        guard case let .artifact(taskID) = presentation,
              let artifact = currentArtifact else { return }
        let service = serviceProvider.service(for: taskID)
        shareTask?.cancel()
        shareTask = Task { [weak self] in
            guard let self else { return }
            do {
                let binary = try await service.loadArtifactDownload(artifact)
                guard !Task.isCancelled else { return }
                sharePayload = TaskMediaSharePayload(
                    data: binary.data,
                    mime: binary.mime,
                    fileName: binary.fileName
                )
            } catch {
                guard !Task.isCancelled else { return }
                transientError = error.localizedDescription
            }
            shareTask = nil
        }
    }

    private func loadSelectedImageAndNeighbors() {
        guard case let .image(taskID) = presentation,
              let selectedImageIndex else { return }
        let neighbors = [selectedImageIndex, selectedImageIndex + 1, selectedImageIndex - 1]
            .filter { images.indices.contains($0) }
        for index in neighbors {
            loadImageIfNeeded(images[index], taskID: taskID)
        }
    }

    private func loadImageIfNeeded(_ image: Dev3SharedImage, taskID: String) {
        let key = cacheKey(taskID: taskID, mediaID: image.id)
        guard imageCache[key] == nil,
              imageErrors[key] == nil,
              imageTasks[key] == nil else { return }
        let service = serviceProvider.service(for: taskID)
        let loadID = UUID()
        imageLoadIDs[key] = loadID
        imageLoadingKeys.insert(key)
        imageTasks[key] = Task { [weak self] in
            defer {
                if self?.imageLoadIDs[key] == loadID {
                    self?.imageLoadingKeys.remove(key)
                    self?.imageTasks[key] = nil
                    self?.imageLoadIDs[key] = nil
                }
            }
            do {
                let binary = try await service.loadImage(image)
                guard !Task.isCancelled, self?.imageLoadIDs[key] == loadID else { return }
                self?.imageCache[key] = binary.data
            } catch is CancellationError {
                return
            } catch {
                if self?.imageLoadIDs[key] == loadID {
                    self?.imageErrors[key] = error.localizedDescription
                }
            }
        }
    }

    private func waitForImage(_ id: String, taskID: String) async {
        await imageTasks[cacheKey(taskID: taskID, mediaID: id)]?.value
    }

    private func loadSelectedArtifact() {
        artifactTask?.cancel()
        guard case let .artifact(taskID) = presentation,
              let artifact = currentArtifact
        else {
            artifactState = .idle
            return
        }
        let loadID = UUID()
        let service = serviceProvider.service(for: taskID)
        artifactLoadID = loadID
        artifactState = .loading
        artifactTask = Task { [weak self] in
            do {
                let bundle = try await service.loadArtifact(artifact)
                guard !Task.isCancelled, self?.artifactLoadID == loadID else { return }
                self?.artifactState = .loaded(bundle)
            } catch is CancellationError {
                return
            } catch {
                guard self?.artifactLoadID == loadID else { return }
                self?.artifactState = .failed(error.localizedDescription)
            }
            if self?.artifactLoadID == loadID {
                self?.artifactTask = nil
                self?.artifactLoadID = nil
            }
        }
    }

    private func trimImageCache() {
        let retained = Set(catalog.taskHistories.flatMap { taskID, history in
            history.images.map { cacheKey(taskID: taskID, mediaID: $0.id) }
        })
        imageCache = imageCache.filter { retained.contains($0.key) }
        imageErrors = imageErrors.filter { retained.contains($0.key) }
        let droppedKeys = imageTasks.keys.filter { !retained.contains($0) }
        for key in droppedKeys {
            imageTasks[key]?.cancel()
            imageTasks[key] = nil
            imageLoadIDs[key] = nil
            imageLoadingKeys.remove(key)
        }
    }

    private func cancelActiveRequests() {
        for task in imageTasks.values {
            task.cancel()
        }
        imageTasks.removeAll()
        imageLoadIDs.removeAll()
        imageLoadingKeys.removeAll()
        artifactTask?.cancel()
        artifactTask = nil
        artifactLoadID = nil
        historyPrefetchTask?.cancel()
        historyPrefetchTask = nil
        shareTask?.cancel()
        shareTask = nil
    }

    private func cacheKey(taskID: String, mediaID: String) -> String {
        "\(taskID)\u{0}\(mediaID)"
    }
}
