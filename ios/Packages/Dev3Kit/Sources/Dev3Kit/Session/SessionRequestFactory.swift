import Foundation

public struct PairedServer: Codable, Equatable, Identifiable, Sendable {
    public let origin: URL
    public let sessionToken: String
    public let name: String
    public let instanceId: String

    public var id: String {
        instanceId
    }

    public init(origin: URL, sessionToken: String, name: String, instanceId: String) throws {
        self.origin = try PairingURLParser.normalizedOrigin(from: origin)
        let normalizedToken = sessionToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedToken.isEmpty,
              normalizedToken.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              !normalizedToken.contains(";")
        else {
            throw SessionRequestError.invalidCredential
        }
        self.sessionToken = normalizedToken
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "dev3" : name
        self.instanceId = instanceId
    }
}

public struct RemoteInstanceInfo: Codable, Equatable, Sendable {
    public let instanceId: String
    public let name: String
    public let appVersion: String
    public let protocolVersion: Int

    public init(instanceId: String, name: String, appVersion: String, protocolVersion: Int) {
        self.instanceId = instanceId
        self.name = name
        self.appVersion = appVersion
        self.protocolVersion = protocolVersion
    }
}

public enum SessionRequestError: Error, Equatable, LocalizedError, Sendable {
    case invalidCredential
    case invalidPath
    case invalidURL

    public var errorDescription: String? {
        switch self {
        case .invalidCredential:
            "The saved session credential is invalid. Pair with the instance again."
        case .invalidPath, .invalidURL:
            "The instance request could not be created."
        }
    }
}

public protocol AuthenticatedRequestBuilding: Sendable {
    func authenticatedRequest(path: String, queryItems: [URLQueryItem]) async throws -> URLRequest
}

public extension AuthenticatedRequestBuilding {
    func authenticatedRequest(path: String) async throws -> URLRequest {
        try await authenticatedRequest(path: path, queryItems: [])
    }
}

public actor SessionRequestFactory: AuthenticatedRequestBuilding {
    private var server: PairedServer

    public init(server: PairedServer) {
        self.server = server
    }

    public func update(server: PairedServer) {
        self.server = server
    }

    public func serverSnapshot() -> PairedServer {
        server
    }

    public func authenticatedRequest(path: String, queryItems: [URLQueryItem] = []) throws -> URLRequest {
        var request = try Self.request(origin: server.origin, path: path, queryItems: queryItems)
        request.setValue("dev3_session=\(server.sessionToken)", forHTTPHeaderField: "Cookie")
        return request
    }

    public static func request(
        origin: URL,
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { throw SessionRequestError.invalidPath }
        let normalizedOrigin = try PairingURLParser.normalizedOrigin(from: origin)
        guard var components = URLComponents(url: normalizedOrigin, resolvingAgainstBaseURL: false) else {
            throw SessionRequestError.invalidURL
        }
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw SessionRequestError.invalidURL }
        return URLRequest(url: url)
    }
}
