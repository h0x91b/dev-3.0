@testable import dev3
import Dev3Kit
import Foundation
import Testing

@Suite("Task media store")
struct TaskMediaStoreTests {
    @Test("Rebinding retains history and routes later loads and shares to the new provider")
    @MainActor
    func providerRebindRetainsHistory() async throws {
        let oldService = RecordingTaskMediaService(
            taskID: "task-a",
            imageData: Data("old".utf8)
        )
        let newService = RecordingTaskMediaService(
            taskID: "task-a",
            imageData: Data("new".utf8)
        )
        let store = TaskMediaStore(serviceProvider: RecordingTaskMediaProvider(service: oldService))
        let task = try decodeTask()
        let push = try decodeImagePush()

        store.seed(tasks: [task])
        store.receive(push)
        await eventually("The original provider should serve the initial push") {
            store.currentImage.flatMap(store.imageData(for:)) == Data("old".utf8)
        }
        let oldLoadCountBeforeRebind = await oldService.imageLoadCount
        store.rebindServiceProvider(RecordingTaskMediaProvider(service: newService))

        await eventually("The rebound provider should load the visible image") {
            store.currentImage.flatMap(store.imageData(for:)) == Data("new".utf8)
        }
        store.prepareImageShare()
        await eventually("The share payload should use data from the rebound provider") {
            store.sharePayload?.data == Data("new".utf8)
        }

        #expect(store.catalog.history(for: "task-a").images.map(\.id) == ["image-a"])
        #expect(await oldService.imageLoadCount == oldLoadCountBeforeRebind)
        #expect(await newService.imageLoadCount == 1)
    }

    @Test("Task removal prunes retained history, cache, and presentation")
    @MainActor
    func taskRemovalPrunesRetainedState() async throws {
        let service = RecordingTaskMediaService(
            taskID: "task-a",
            imageData: Data("image".utf8)
        )
        let store = TaskMediaStore(serviceProvider: RecordingTaskMediaProvider(service: service))
        try store.receive(decodeImagePush())

        await eventually("The image should be cached before task removal") {
            !store.imageCache.isEmpty
        }
        let removal = try JSONDecoder().decode(
            TaskRemovedPush.self,
            from: Data(#"{"projectId":"project","taskId":"task-a"}"#.utf8)
        )
        store.receive(.taskRemoved(removal))

        #expect(store.catalog.taskHistories["task-a"] == nil)
        #expect(store.imageCache.isEmpty)
        #expect(store.imageErrors.isEmpty)
        #expect(store.presentation == nil)
    }

    @MainActor
    private func eventually(
        _ failureMessage: String,
        condition: @MainActor () -> Bool
    ) async {
        for _ in 0 ..< 100 {
            if condition() {
                return
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record(Comment(rawValue: failureMessage))
    }

    private func decodeTask() throws -> Dev3Task {
        let json = #"""
        {
          "id":"task-a","seq":1,"projectId":"project","title":"Task A","description":"Media test",
          "status":"in-progress","baseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
          "updatedAt":"2026-07-16T10:00:00Z","sharedImages":[{
            "id":"image-a","storedPath":"/shared/image-a.png","originalPath":"/tmp/image-a.png",
            "name":"image-a.png","mime":"image/png","bytes":3,"createdAt":1
          }]
        }
        """#
        return try JSONDecoder().decode(Dev3Task.self, from: Data(json.utf8))
    }

    private func decodeImagePush() throws -> CLIShowImagePush {
        let json = #"""
        {
          "taskId":"task-a","projectId":"project","images":[{
            "id":"image-a","storedPath":"/shared/image-a.png","originalPath":"/tmp/image-a.png",
            "name":"image-a.png","mime":"image/png","bytes":3,"createdAt":1
          }],"newCount":1,"taskSeq":1,"taskTitle":"Task A","projectName":"Project"
        }
        """#
        return try JSONDecoder().decode(CLIShowImagePush.self, from: Data(json.utf8))
    }
}

private struct RecordingTaskMediaProvider: TaskMediaServiceProviding {
    let service: RecordingTaskMediaService

    func service(for _: String) -> any TaskMediaServicing {
        service
    }
}

private actor RecordingTaskMediaService: TaskMediaServicing {
    nonisolated let taskID: String
    private(set) var imageLoadCount = 0
    private let imageData: Data

    init(taskID: String, imageData: Data) {
        self.taskID = taskID
        self.imageData = imageData
    }

    func loadImage(_ image: Dev3SharedImage) async throws -> TaskMediaBinary {
        imageLoadCount += 1
        return TaskMediaBinary(data: imageData, mime: image.mime, fileName: image.name)
    }

    func loadArtifact(_: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle {
        throw RecordingTaskMediaError.unexpectedArtifactLoad
    }

    func loadArtifactDownload(_: Dev3SharedArtifact) async throws -> TaskMediaBinary {
        throw RecordingTaskMediaError.unexpectedArtifactLoad
    }
}

private enum RecordingTaskMediaError: Error {
    case unexpectedArtifactLoad
}
