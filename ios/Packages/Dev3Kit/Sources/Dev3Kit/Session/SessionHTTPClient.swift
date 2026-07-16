import Foundation

public struct HTTPDataResponse: Sendable {
    public let data: Data
    public let statusCode: Int
    public let headers: [String: String]

    public init(data: Data, statusCode: Int, headers: [String: String]) {
        self.data = data
        self.statusCode = statusCode
        self.headers = headers
    }

    public func header(named name: String) -> String? {
        headers.first(where: { $0.key.caseInsensitiveCompare(name) == .orderedSame })?.value
    }
}

public protocol HTTPDataLoading: Sendable {
    func data(for request: URLRequest) async throws -> HTTPDataResponse
}

public struct URLSessionDataLoader: HTTPDataLoading, Sendable {
    private let session: URLSession

    public init() {
        session = Self.makeSession()
    }

    public init(session: URLSession) {
        self.session = session
    }

    public func data(for request: URLRequest) async throws -> HTTPDataResponse {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw SessionHTTPError.invalidResponse
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String, let value = entry.value as? String else { return }
            result[key] = value
        }
        return HTTPDataResponse(data: data, statusCode: response.statusCode, headers: headers)
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

public struct SessionAuthResponse: Equatable, Sendable {
    public let statusCode: Int
    public let sessionToken: String?

    public init(statusCode: Int, sessionToken: String?) {
        self.statusCode = statusCode
        self.sessionToken = sessionToken
    }

    public var isAccepted: Bool {
        (200 ..< 300).contains(statusCode) && sessionToken != nil
    }

    public var isRejected: Bool {
        statusCode == 401 || statusCode == 403
    }
}

public protocol SessionHTTPTransporting: Sendable {
    func fetchInstance(origin: URL) async throws -> RemoteInstanceInfo
    func exchange(origin: URL, token: String) async throws -> SessionAuthResponse
    func refresh(requestFactory: SessionRequestFactory) async throws -> SessionAuthResponse
}

public struct SessionHTTPClient: SessionHTTPTransporting, Sendable {
    public static let supportedProtocolVersion = 1

    private let loader: any HTTPDataLoading
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(loader: any HTTPDataLoading = URLSessionDataLoader()) {
        self.loader = loader
    }

    public func fetchInstance(origin: URL) async throws -> RemoteInstanceInfo {
        var request = try SessionRequestFactory.request(origin: origin, path: "/instance")
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let response = try await loader.data(for: request)
        guard response.statusCode == 200 else {
            throw SessionHTTPError.httpStatus(response.statusCode)
        }
        let instance = try decoder.decode(RemoteInstanceInfo.self, from: response.data)
        guard instance.protocolVersion == Self.supportedProtocolVersion else {
            throw SessionHTTPError.unsupportedProtocol(instance.protocolVersion)
        }
        return instance
    }

    public func exchange(origin: URL, token: String) async throws -> SessionAuthResponse {
        var request = try SessionRequestFactory.request(origin: origin, path: "/auth/exchange")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(NativeExchangeBody(token: token, client: "ios"))
        return try await authResponse(from: loader.data(for: request))
    }

    public func refresh(requestFactory: SessionRequestFactory) async throws -> SessionAuthResponse {
        var request = try await requestFactory.authenticatedRequest(path: "/auth/refresh")
        request.httpMethod = "POST"
        return try await authResponse(from: loader.data(for: request))
    }

    private func authResponse(from response: HTTPDataResponse) -> SessionAuthResponse {
        SessionAuthResponse(
            statusCode: response.statusCode,
            sessionToken: response.header(named: "Set-Cookie").flatMap(Self.sessionToken(fromSetCookie:))
        )
    }

    public static func sessionToken(fromSetCookie header: String) -> String? {
        guard let cookie = header.split(separator: ";", maxSplits: 1).first,
              let equals = cookie.firstIndex(of: "=")
        else {
            return nil
        }
        let name = cookie[..<equals].trimmingCharacters(in: .whitespaces)
        let value = cookie[cookie.index(after: equals)...].trimmingCharacters(in: .whitespaces)
        guard name == "dev3_session", !value.isEmpty else { return nil }
        return value
    }
}

private struct NativeExchangeBody: Codable {
    let token: String
    let client: String
}

public enum SessionHTTPError: Error, Equatable, LocalizedError, Sendable {
    case invalidResponse
    case httpStatus(Int)
    case unsupportedProtocol(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The instance returned an invalid response."
        case let .httpStatus(status):
            "The instance returned HTTP \(status)."
        case let .unsupportedProtocol(version):
            "This instance uses unsupported protocol version \(version)."
        }
    }
}
