@testable import dev3
import Dev3Kit
import Foundation
import Testing

@Suite("Task media coordinator")
struct TaskMediaCoordinatorTests {
    @Test("Snapshots seed silently and global pushes surface immediately")
    @MainActor
    func snapshotSeedingAndGlobalPushFanout() throws {
        let source = RecordingMediaPushSource()
        let service = ImmediateMediaService(taskID: "task-b")
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: { FixedMediaProvider(service: service) }
        )
        let generation = UUID()
        source.context = mediaContext(generation: generation, serverID: "server-a")

        coordinator.start()
        try coordinator.synchronize(
            tasksByProject: ["project": [decodeSeededTask()]],
            rpcGeneration: generation,
            serverID: "server-a",
            snapshotServerID: "server-a"
        )

        #expect(source.observerCount == 1)
        #expect(coordinator.mediaStore.catalog.history(for: "task-a").images.map(\.id) == ["seed-image"])
        #expect(coordinator.mediaStore.catalog.history(for: "task-a").artifacts.map(\.id) == ["seed-report"])
        #expect(coordinator.mediaStore.presentation == nil)

        let start = ContinuousClock.now
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-b", imageID: "live-image")))
        #expect(ContinuousClock.now - start < .seconds(2))
        #expect(coordinator.mediaStore.presentation == .image(taskID: "task-b"))
        #expect(coordinator.mediaStore.catalog.history(for: "task-b").images.map(\.id) == ["live-image"])

        let removal = try JSONDecoder().decode(
            TaskRemovedPush.self,
            from: Data(#"{"projectId":"project","taskId":"task-b"}"#.utf8)
        )
        source.emit(.taskRemoved(removal))
        #expect(coordinator.mediaStore.catalog.taskHistories["task-b"] == nil)
        #expect(coordinator.mediaStore.presentation == nil)

        coordinator.stop()
        #expect(source.observerCount == 0)
    }

    @Test("The first authoritative server push can present media")
    @MainActor
    func firstPushSynchronizesAuthoritativeContext() throws {
        let generation = UUID()
        let source = RecordingMediaPushSource(
            context: mediaContext(generation: generation, serverID: "server-a")
        )
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: {
                FixedMediaProvider(service: ImmediateMediaService(taskID: "task-a"))
            }
        )

        coordinator.start()
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "first-image")))

        #expect(coordinator.mediaStore.presentation == .image(taskID: "task-a"))
        #expect(coordinator.mediaStore.catalog.history(for: "task-a").images.map(\.id) == ["first-image"])
    }

    @Test("A same-server reconnect push preserves cached media before the root resynchronizes")
    @MainActor
    func reconnectPushPreservesCatalog() throws {
        let firstGeneration = UUID()
        let source = RecordingMediaPushSource(
            context: mediaContext(generation: firstGeneration, serverID: "server-a")
        )
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: {
                FixedMediaProvider(service: ImmediateMediaService(taskID: "task-a"))
            }
        )

        coordinator.start()
        try coordinator.synchronize(
            tasksByProject: ["project": [decodeSeededTask()]],
            rpcGeneration: firstGeneration,
            serverID: "server-a",
            snapshotServerID: "server-a"
        )
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "before-reconnect")))

        source.context = mediaContext(generation: UUID(), serverID: "server-a")
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "after-reconnect")))

        #expect(
            coordinator.mediaStore.catalog.history(for: "task-a").images.map(\.id) == [
                "seed-image", "before-reconnect", "after-reconnect"
            ]
        )
    }

    @Test("Server switches reject late pushes until the new snapshot is authoritative")
    @MainActor
    func serverSwitchGatesLatePushes() throws {
        let source = RecordingMediaPushSource()
        let providerBox = MediaProviderBox(
            provider: FixedMediaProvider(service: ImmediateMediaService(taskID: "task-a"))
        )
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: { providerBox.provider }
        )

        coordinator.start()
        let serverAGeneration = UUID()
        source.context = mediaContext(generation: serverAGeneration, serverID: "server-a")
        try coordinator.synchronize(
            tasksByProject: ["project": [decodeSeededTask()]],
            rpcGeneration: serverAGeneration,
            serverID: "server-a",
            snapshotServerID: "server-a"
        )
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "server-a-image")))
        #expect(coordinator.mediaStore.presentation == .image(taskID: "task-a"))

        let serverBGeneration = UUID()
        source.context = TaskMediaPushContext(
            rpcGeneration: serverBGeneration,
            serverID: "server-b",
            snapshotServerID: "server-a"
        )
        try coordinator.synchronize(
            tasksByProject: ["project": [decodeSeededTask()]],
            rpcGeneration: serverBGeneration,
            serverID: "server-b",
            snapshotServerID: "server-a"
        )
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "late-old-image")))

        #expect(coordinator.mediaStore.catalog.taskHistories.isEmpty)
        #expect(coordinator.mediaStore.presentation == nil)

        providerBox.provider = FixedMediaProvider(service: ImmediateMediaService(taskID: "task-b"))
        source.context = mediaContext(generation: serverBGeneration, serverID: "server-b")
        coordinator.synchronize(
            tasksByProject: ["project": []],
            rpcGeneration: serverBGeneration,
            serverID: "server-b",
            snapshotServerID: "server-b"
        )
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-b", imageID: "server-b-image")))

        #expect(coordinator.mediaStore.presentation == .image(taskID: "task-b"))
        #expect(coordinator.mediaStore.catalog.history(for: "task-b").images.map(\.id) == ["server-b-image"])
    }

    @Test("A nil server identity never authorizes media pushes")
    @MainActor
    func nilServerIdentityRejectsPushes() throws {
        let source = RecordingMediaPushSource()
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: {
                FixedMediaProvider(service: ImmediateMediaService(taskID: "stale"))
            }
        )
        let generation = UUID()
        source.context = mediaContext(generation: generation, serverID: nil)
        coordinator.start()
        try coordinator.synchronize(
            tasksByProject: ["project": [decodeSeededTask()]],
            rpcGeneration: generation,
            serverID: nil,
            snapshotServerID: nil
        )

        try source.emit(.cliShowImage(decodeImagePush(taskID: "stale", imageID: "late-image")))

        #expect(coordinator.mediaStore.catalog.taskHistories.isEmpty)
        #expect(coordinator.mediaStore.presentation == nil)
    }

    @Test("Client replacement and coordinator stop cancel in-flight media loads")
    @MainActor
    func lifecycleCancelsInflightLoads() async throws {
        let source = RecordingMediaPushSource()
        let oldService = SuspendingMediaService(taskID: "task-a")
        let newService = SuspendingMediaService(taskID: "task-a")
        let providerBox = MediaProviderBox(provider: FixedMediaProvider(service: oldService))
        let coordinator = TaskMediaCoordinator(
            pushSource: source,
            serviceProviderFactory: { providerBox.provider }
        )
        let firstGeneration = UUID()
        source.context = mediaContext(generation: firstGeneration, serverID: "server-a")

        coordinator.start()
        coordinator.synchronize(
            tasksByProject: ["project": []],
            rpcGeneration: firstGeneration,
            serverID: "server-a",
            snapshotServerID: "server-a"
        )
        try source.emit(.cliShowImage(decodeImagePush(taskID: "task-a", imageID: "image-a")))
        await eventually("The old provider should begin loading") {
            await oldService.startCount == 1
        }

        providerBox.provider = FixedMediaProvider(service: newService)
        let secondGeneration = UUID()
        source.context = mediaContext(generation: secondGeneration, serverID: "server-a")
        coordinator.synchronize(
            tasksByProject: ["project": []],
            rpcGeneration: secondGeneration,
            serverID: "server-a",
            snapshotServerID: "server-a"
        )
        await eventually("Rebinding should cancel the old load and start the new one") {
            let oldCancellationCount = await oldService.cancellationCount
            let newStartCount = await newService.startCount
            return oldCancellationCount == 1 && newStartCount == 1
        }

        coordinator.stop()
        await eventually("Stopping should cancel the replacement load") {
            await newService.cancellationCount == 1
        }
        #expect(source.observerCount == 0)
    }

    @MainActor
    private func eventually(
        _ failureMessage: String,
        condition: () async -> Bool
    ) async {
        for _ in 0 ..< 100 {
            if await condition() {
                return
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record(Comment(rawValue: failureMessage))
    }

    private func decodeSeededTask() throws -> Dev3Task {
        let json = #"""
        {
          "id":"task-a","seq":1,"projectId":"project","title":"Task A","description":"Media test",
          "status":"in-progress","baseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
          "updatedAt":"2026-07-16T10:00:00Z","sharedImages":[{
            "id":"seed-image","storedPath":"/shared/seed.png","originalPath":"/tmp/seed.png",
            "name":"seed.png","mime":"image/png","bytes":3,"createdAt":1
          }],"sharedArtifacts":[{
            "id":"seed-report","kind":"html","title":"Seed report","name":"report.html",
            "storedPath":"/shared/report.html","originalPath":"/tmp/report.html","bytes":12,
            "createdAt":2,"assets":[]
          }]
        }
        """#
        return try JSONDecoder().decode(Dev3Task.self, from: Data(json.utf8))
    }

    private func decodeImagePush(taskID: String, imageID: String) throws -> CLIShowImagePush {
        let json = """
        {
          "taskId":"\(taskID)","projectId":"project","images":[{
            "id":"\(imageID)","storedPath":"/shared/\(imageID).png",
            "originalPath":"/tmp/\(imageID).png","name":"\(imageID).png",
            "mime":"image/png","bytes":3,"createdAt":1
          }],"newCount":1,"taskSeq":1,"taskTitle":"Task","projectName":"Project"
        }
        """
        return try JSONDecoder().decode(CLIShowImagePush.self, from: Data(json.utf8))
    }

    private func mediaContext(generation: UUID, serverID: String?) -> TaskMediaPushContext {
        TaskMediaPushContext(
            rpcGeneration: generation,
            serverID: serverID,
            snapshotServerID: serverID
        )
    }
}

@MainActor
private final class RecordingMediaPushSource: TaskMediaPushObserving {
    private var observers: [UUID: @MainActor (RPCPushEvent) -> Void] = [:]
    var context: TaskMediaPushContext

    init(
        context: TaskMediaPushContext = TaskMediaPushContext(
            rpcGeneration: UUID(),
            serverID: nil,
            snapshotServerID: nil
        )
    ) {
        self.context = context
    }

    var taskMediaPushContext: TaskMediaPushContext {
        context
    }

    var observerCount: Int {
        observers.count
    }

    func addPushObserver(_ observer: @escaping @MainActor (RPCPushEvent) -> Void) -> UUID {
        let token = UUID()
        observers[token] = observer
        return token
    }

    func removePushObserver(_ token: UUID) {
        observers[token] = nil
    }

    func emit(_ push: RPCPushEvent) {
        for observer in observers.values {
            observer(push)
        }
    }
}

@MainActor
private final class MediaProviderBox {
    var provider: any TaskMediaServiceProviding

    init(provider: any TaskMediaServiceProviding) {
        self.provider = provider
    }
}

private struct FixedMediaProvider: TaskMediaServiceProviding {
    let service: any TaskMediaServicing

    func service(for _: String) -> any TaskMediaServicing {
        service
    }
}

private actor SuspendingMediaService: TaskMediaServicing {
    nonisolated let taskID: String
    private(set) var startCount = 0
    private(set) var cancellationCount = 0

    init(taskID: String) {
        self.taskID = taskID
    }

    func loadImage(_ image: Dev3SharedImage) async throws -> TaskMediaBinary {
        startCount += 1
        do {
            try await Task.sleep(for: .seconds(30))
        } catch is CancellationError {
            cancellationCount += 1
            throw CancellationError()
        }
        return TaskMediaBinary(data: Data(), mime: image.mime, fileName: image.name)
    }

    func loadArtifact(_: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle {
        throw CoordinatorMediaTestError.unexpectedArtifactLoad
    }

    func loadArtifactDownload(_: Dev3SharedArtifact) async throws -> TaskMediaBinary {
        throw CoordinatorMediaTestError.unexpectedArtifactLoad
    }
}

private actor ImmediateMediaService: TaskMediaServicing {
    nonisolated let taskID: String

    init(taskID: String) {
        self.taskID = taskID
    }

    func loadImage(_ image: Dev3SharedImage) async throws -> TaskMediaBinary {
        TaskMediaBinary(data: Data("image".utf8), mime: image.mime, fileName: image.name)
    }

    func loadArtifact(_: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle {
        throw CoordinatorMediaTestError.unexpectedArtifactLoad
    }

    func loadArtifactDownload(_: Dev3SharedArtifact) async throws -> TaskMediaBinary {
        throw CoordinatorMediaTestError.unexpectedArtifactLoad
    }
}

private enum CoordinatorMediaTestError: Error {
    case unexpectedArtifactLoad
}
