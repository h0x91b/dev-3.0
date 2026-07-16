@testable import Dev3Kit
import Foundation
import Testing

@Suite("Captured media RPC payloads")
struct MediaRPCPayloadTests {
    @Test("Image response matches readImageBase64")
    func imageResponse() throws {
        let json = #"{"dataUrl":"data:image/png;base64,AAE="}"#
        let payload = Data(json.utf8)
        let response = try JSONDecoder().decode(Dev3ImageDataURLResponse.self, from: payload)

        #expect(response.dataUrl == "data:image/png;base64,AAE=")
    }

    @Test("Artifact content preserves server-bundled resource names")
    func artifactContentResponse() throws {
        let json = #"""
        {"html":"<html></html>","assets":[
          {"name":"chart.png","mime":"image/png","dataUrl":"data:image/png;base64,AAE="}
        ]}
        """#
        let payload = Data(json.utf8)
        let response = try JSONDecoder().decode(Dev3ArtifactContentResponse.self, from: payload)

        #expect(response.html == "<html></html>")
        #expect(response.assets == [Dev3ArtifactContentAsset(
            name: "chart.png",
            mime: "image/png",
            dataUrl: "data:image/png;base64,AAE="
        )])
    }

    @Test("Artifact download preserves file metadata and bytes")
    func artifactDownloadResponse() throws {
        let json = #"{"fileName":"report.zip","mime":"application/zip","base64":"UEs="}"#
        let payload = Data(json.utf8)
        let response = try JSONDecoder().decode(Dev3ArtifactDownloadResponse.self, from: payload)

        #expect(response == Dev3ArtifactDownloadResponse(
            fileName: "report.zip",
            mime: "application/zip",
            base64: "UEs="
        ))
    }

    @Test("Show pushes decode complete task-bound histories")
    func mediaPushHistories() throws {
        let imageJSON = #"""
        {"taskId":"task-1","projectId":"project-1","images":[{
          "id":"image-1","storedPath":"/worktrees/shared-images/image.png",
          "originalPath":"/tmp/image.png","name":"image.png","mime":"image/png","bytes":2,
          "caption":"Look here","createdAt":1710000000000
        }],"newCount":1,"taskSeq":42,"taskTitle":"Media task","projectName":"dev3"}
        """#
        let artifactJSON = #"""
        {"taskId":"task-1","projectId":"project-1","artifacts":[{
          "id":"artifact-1","kind":"html","title":"Report","name":"report.html",
          "storedPath":"/worktrees/shared-artifacts/report.html","originalPath":"/tmp/report.html",
          "bytes":20,"createdAt":1710000001000,"assets":[],"bundlePath":null,"bundleBytes":null
        }],"newCount":1,"taskSeq":42,"taskTitle":"Media task","projectName":"dev3"}
        """#
        let imagePayload = Data(imageJSON.utf8)
        let artifactPayload = Data(artifactJSON.utf8)

        let image = try JSONDecoder().decode(CLIShowImagePush.self, from: imagePayload)
        let artifact = try JSONDecoder().decode(CLIShowArtifactPush.self, from: artifactPayload)

        #expect(image.taskId == "task-1")
        #expect(image.images.first?.caption == "Look here")
        #expect(image.newCount == 1)
        #expect(artifact.artifacts.first?.title == "Report")
        #expect(artifact.artifacts.first?.bundlePath == nil)
    }
}
