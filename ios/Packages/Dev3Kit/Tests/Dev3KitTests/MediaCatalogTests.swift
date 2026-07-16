@testable import Dev3Kit
import Foundation
import Testing

@Suite("Shell media catalog")
struct MediaCatalogTests {
    @Test("Pushes from A, B, then A retain isolated histories")
    func crossTaskPushIsolation() throws {
        var catalog = Dev3MediaCatalog()
        try catalog.receive(imagePush(taskID: "task-a", imageIDs: ["a1"], newCount: 1))
        try catalog.receive(imagePush(taskID: "task-b", imageIDs: ["b1", "b2"], newCount: 2))
        try catalog.receive(imagePush(taskID: "task-a", imageIDs: ["a1", "a2"], newCount: 1))

        #expect(catalog.history(for: "task-a").images.map(\.id) == ["a1", "a2"])
        #expect(catalog.history(for: "task-a").selectedImageIndex == 1)
        #expect(catalog.history(for: "task-b").images.map(\.id) == ["b1", "b2"])
        #expect(catalog.history(for: "task-b").selectedImageIndex == 1)
    }

    @Test("Artifact and image histories stay independent per task")
    func mediaKindsRemainIndependent() throws {
        var catalog = Dev3MediaCatalog()
        try catalog.receive(imagePush(taskID: "task-a", imageIDs: ["a1"], newCount: 1))
        try catalog.receive(artifactPush(taskID: "task-a", artifactIDs: ["r1"], newCount: 1))
        try catalog.receive(artifactPush(taskID: "task-b", artifactIDs: ["r2"], newCount: 1))

        #expect(catalog.history(for: "task-a").images.map(\.id) == ["a1"])
        #expect(catalog.history(for: "task-a").artifacts.map(\.id) == ["r1"])
        #expect(catalog.history(for: "task-b").images.isEmpty)
        #expect(catalog.history(for: "task-b").artifacts.map(\.id) == ["r2"])
    }

    @Test("Removing a task prunes only its media history")
    func taskRemovalPrunesHistory() throws {
        var catalog = Dev3MediaCatalog()
        try catalog.receive(imagePush(taskID: "task-a", imageIDs: ["a1"], newCount: 1))
        try catalog.receive(imagePush(taskID: "task-b", imageIDs: ["b1"], newCount: 1))
        try catalog.receive(artifactPush(taskID: "task-a", artifactIDs: ["r1"], newCount: 1))

        catalog.removeTask("task-a")

        #expect(catalog.history(for: "task-a") == Dev3TaskMediaHistory())
        #expect(catalog.taskHistories["task-a"] == nil)
        #expect(catalog.history(for: "task-b").images.map(\.id) == ["b1"])
    }

    private func imagePush(
        taskID: String,
        imageIDs: [String],
        newCount: Int
    ) throws -> CLIShowImagePush {
        let records = imageIDs.enumerated().map { index, id in
            """
            {"id":"\(id)","storedPath":"/shared/\(id).png","originalPath":"/tmp/\(id).png",\
            "name":"\(id).png","mime":"image/png","bytes":1,"createdAt":\(index + 1)}
            """
        }
        let images = records.joined(separator: ",")
        let json = """
        {"taskId":"\(taskID)","projectId":"project","images":[\(images)],"newCount":\(newCount),\
        "taskSeq":1,"taskTitle":"Task","projectName":"Project"}
        """
        return try JSONDecoder().decode(CLIShowImagePush.self, from: Data(json.utf8))
    }

    private func artifactPush(
        taskID: String,
        artifactIDs: [String],
        newCount: Int
    ) throws -> CLIShowArtifactPush {
        let records = artifactIDs.enumerated().map { index, id in
            """
            {"id":"\(id)","kind":"html","title":"\(id)","name":"\(id).html",\
            "storedPath":"/shared/\(id).html","originalPath":"/tmp/\(id).html",\
            "bytes":1,"createdAt":\(index + 1),"assets":[]}
            """
        }
        let artifacts = records.joined(separator: ",")
        let json = """
        {"taskId":"\(taskID)","projectId":"project","artifacts":[\(artifacts)],\
        "newCount":\(newCount),"taskSeq":1,"taskTitle":"Task","projectName":"Project"}
        """
        return try JSONDecoder().decode(CLIShowArtifactPush.self, from: Data(json.utf8))
    }
}
