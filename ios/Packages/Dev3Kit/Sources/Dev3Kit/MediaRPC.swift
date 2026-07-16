import Foundation

public struct Dev3ImageDataURLResponse: Codable, Equatable, Sendable {
    public let dataUrl: String

    public init(dataUrl: String) {
        self.dataUrl = dataUrl
    }
}

public struct Dev3ArtifactContentAsset: Codable, Equatable, Sendable {
    public let name: String
    public let mime: String
    public let dataUrl: String

    public init(name: String, mime: String, dataUrl: String) {
        self.name = name
        self.mime = mime
        self.dataUrl = dataUrl
    }
}

public struct Dev3ArtifactContentResponse: Codable, Equatable, Sendable {
    public let html: String
    public let assets: [Dev3ArtifactContentAsset]

    public init(html: String, assets: [Dev3ArtifactContentAsset]) {
        self.html = html
        self.assets = assets
    }
}

public struct Dev3ArtifactDownloadResponse: Codable, Equatable, Sendable {
    public let fileName: String
    public let mime: String
    public let base64: String

    public init(fileName: String, mime: String, base64: String) {
        self.fileName = fileName
        self.mime = mime
        self.base64 = base64
    }
}

private struct MediaPathParams: Encodable, Sendable {
    let path: String
}

private struct MediaArtifactParams: Encodable, Sendable {
    let artifact: Dev3SharedArtifact
}

public extension RPCClient {
    func readSharedImage(path: String) async throws -> Dev3ImageDataURLResponse? {
        try await call("readImageBase64", params: MediaPathParams(path: path))
    }

    func readSharedArtifactContent(
        artifact: Dev3SharedArtifact
    ) async throws -> Dev3ArtifactContentResponse {
        try await call(
            "readArtifactContent",
            params: MediaArtifactParams(artifact: artifact)
        )
    }

    func readSharedArtifactDownload(
        artifact: Dev3SharedArtifact
    ) async throws -> Dev3ArtifactDownloadResponse {
        try await call(
            "readArtifactDownload",
            params: MediaArtifactParams(artifact: artifact)
        )
    }
}
