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

    /// Pairing probes a QR-supplied host that may be unreachable from the phone (a
    /// VPN `utun`, a VM bridge address, a stale DHCP lease). URLSession's default 60s
    /// request timeout stalls the whole pairing flow for a full minute per dead host,
    /// so the `/instance` probe gets a short deadline. A timeout surfaces as a URLError
    /// (not a `SessionHTTPError`), which `pairingInstanceFailureMessage(for:)` maps to
    /// the reachability message — scenario (c) — exactly as intended. Only the probe is
    /// shortened; authenticated requests keep URLSession's normal timeout.
    static let instanceProbeTimeout: TimeInterval = 5

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
        request.timeoutInterval = Self.instanceProbeTimeout
        log("→ GET /instance (\(origin.host ?? origin.absoluteString))")
        do {
            let response = try await loader.data(for: request)
            guard response.statusCode == 200 else {
                log("← GET /instance \(response.statusCode)")
                throw SessionHTTPError.httpStatus(response.statusCode)
            }
            let instance = try decoder.decode(RemoteInstanceInfo.self, from: response.data)
            guard instance.protocolVersion == Self.supportedProtocolVersion else {
                log("← GET /instance unsupported protocol v\(instance.protocolVersion)")
                throw SessionHTTPError.unsupportedProtocol(instance.protocolVersion)
            }
            log("← GET /instance 200 (protocol v\(instance.protocolVersion))")
            return instance
        } catch let error as SessionHTTPError {
            throw error
        } catch {
            log("✗ GET /instance \(Self.describe(error))")
            throw error
        }
    }

    public func exchange(origin: URL, token: String) async throws -> SessionAuthResponse {
        var request = try SessionRequestFactory.request(origin: origin, path: "/auth/exchange")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(NativeExchangeBody(token: token, client: "ios"))
        log("→ POST /auth/exchange (client=ios)")
        do {
            let data = try await loader.data(for: request)
            let response = authResponse(from: data)
            let cookie = response.sessionToken != nil ? " +cookie" : ""
            log("← POST /auth/exchange \(response.statusCode)\(cookie)")
            return response
        } catch {
            log("✗ POST /auth/exchange \(Self.describe(error))")
            throw error
        }
    }

    public func refresh(requestFactory: SessionRequestFactory) async throws -> SessionAuthResponse {
        var request = try await requestFactory.authenticatedRequest(path: "/auth/refresh")
        request.httpMethod = "POST"
        do {
            let data = try await loader.data(for: request)
            let response = authResponse(from: data)
            log("← POST /auth/refresh \(response.statusCode)")
            return response
        } catch {
            log("✗ POST /auth/refresh \(Self.describe(error))")
            throw error
        }
    }

    private func log(_ message: String) {
        DiagnosticsLog.shared.record(category: "http", message)
    }

    private static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            return "network error (\(urlError.code.rawValue): \(urlError.localizedDescription))"
        }
        return String(describing: error)
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
