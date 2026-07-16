import Dev3Kit
import Foundation

enum TaskMediaServiceError: Error, LocalizedError, Sendable {
    case imageUnavailable
    case connectionUnavailable

    var errorDescription: String? {
        switch self {
        case .imageUnavailable:
            "The shared image is no longer available."
        case .connectionUnavailable:
            "Reconnect to this dev3 instance to load shared media."
        }
    }
}

struct TaskMediaBinary: Equatable, Sendable {
    let data: Data
    let mime: String
    let fileName: String
}

protocol TaskMediaServicing: Sendable {
    var taskID: String { get }

    func loadImage(_ image: Dev3SharedImage) async throws -> TaskMediaBinary
    func loadArtifact(_ artifact: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle
    func loadArtifactDownload(_ artifact: Dev3SharedArtifact) async throws -> TaskMediaBinary
}

protocol TaskMediaServiceProviding: Sendable {
    func service(for taskID: String) -> any TaskMediaServicing
}

struct RPCTaskMediaServiceProvider: TaskMediaServiceProviding {
    let rpcClient: RPCClient

    func service(for taskID: String) -> any TaskMediaServicing {
        RPCTaskMediaService(taskID: taskID, rpcClient: rpcClient)
    }
}

struct UnavailableTaskMediaServiceProvider: TaskMediaServiceProviding {
    func service(for taskID: String) -> any TaskMediaServicing {
        UnavailableTaskMediaService(taskID: taskID)
    }
}

private struct UnavailableTaskMediaService: TaskMediaServicing {
    let taskID: String

    func loadImage(_: Dev3SharedImage) async throws -> TaskMediaBinary {
        throw TaskMediaServiceError.connectionUnavailable
    }

    func loadArtifact(_: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle {
        throw TaskMediaServiceError.connectionUnavailable
    }

    func loadArtifactDownload(_: Dev3SharedArtifact) async throws -> TaskMediaBinary {
        throw TaskMediaServiceError.connectionUnavailable
    }
}

actor RPCTaskMediaService: TaskMediaServicing {
    nonisolated let taskID: String

    private let rpcClient: RPCClient

    init(taskID: String, rpcClient: RPCClient) {
        self.taskID = taskID
        self.rpcClient = rpcClient
    }

    func loadImage(_ image: Dev3SharedImage) async throws -> TaskMediaBinary {
        guard let response = try await rpcClient.readSharedImage(path: image.storedPath) else {
            throw TaskMediaServiceError.imageUnavailable
        }
        let decoded = try Dev3MediaDataURL.decode(response.dataUrl)
        return TaskMediaBinary(data: decoded.data, mime: decoded.mime, fileName: image.name)
    }

    func loadArtifact(_ artifact: Dev3SharedArtifact) async throws -> Dev3ArtifactWebBundle {
        let response = try await rpcClient.readSharedArtifactContent(artifact: artifact)
        return try Dev3ArtifactWebBundle(
            artifactID: artifact.id,
            html: response.html,
            assets: response.assets
        )
    }

    func loadArtifactDownload(_ artifact: Dev3SharedArtifact) async throws -> TaskMediaBinary {
        let response = try await rpcClient.readSharedArtifactDownload(artifact: artifact)
        let decoded = try Dev3ArtifactDownloadPolicy.decode(response)
        return TaskMediaBinary(
            data: decoded.data,
            mime: decoded.mime,
            fileName: response.fileName
        )
    }
}
