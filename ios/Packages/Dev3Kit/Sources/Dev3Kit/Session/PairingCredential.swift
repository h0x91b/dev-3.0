import Foundation

public struct PairingCredential: Equatable, Sendable {
    public let origin: URL
    public let token: String

    public init(origin: URL, token: String) throws {
        self.origin = try PairingURLParser.normalizedOrigin(from: origin)
        self.token = try PairingURLParser.normalizedToken(token)
    }
}

public enum PairingURLParserError: Error, Equatable, LocalizedError, Sendable {
    case emptyValue
    case invalidURL
    case unsupportedScheme
    case missingHost
    case userInfoNotAllowed
    case missingToken

    public var errorDescription: String? {
        switch self {
        case .emptyValue:
            "Enter an instance address and pairing code."
        case .invalidURL:
            "Enter a valid instance address."
        case .unsupportedScheme:
            "The instance address must start with http:// or https://."
        case .missingHost:
            "The instance address is missing a host."
        case .userInfoNotAllowed:
            "Instance addresses cannot contain a username or password."
        case .missingToken:
            "The pairing link is missing its token."
        }
    }
}

public enum PairingURLParser {
    public static func parseScannedValue(_ rawValue: String) throws -> PairingCredential {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw PairingURLParserError.emptyValue }
        guard let components = URLComponents(string: trimmed), let url = components.url else {
            throw PairingURLParserError.invalidURL
        }
        guard let token = components.queryItems?.first(where: { $0.name == "token" })?.value else {
            throw PairingURLParserError.missingToken
        }
        return try PairingCredential(origin: url, token: token)
    }

    public static func parseManual(origin rawOrigin: String, code: String) throws -> PairingCredential {
        let trimmedOrigin = rawOrigin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedOrigin.isEmpty else { throw PairingURLParserError.emptyValue }
        guard let origin = URL(string: trimmedOrigin) else { throw PairingURLParserError.invalidURL }
        return try PairingCredential(origin: origin, token: code)
    }

    public static func normalizedOrigin(from url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw PairingURLParserError.invalidURL
        }
        guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw PairingURLParserError.unsupportedScheme
        }
        guard components.user == nil, components.password == nil else {
            throw PairingURLParserError.userInfoNotAllowed
        }
        guard let host = components.host, !host.isEmpty else {
            throw PairingURLParserError.missingHost
        }

        components.scheme = scheme
        components.host = host.lowercased()
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let origin = components.url else { throw PairingURLParserError.invalidURL }
        return origin
    }

    public static func normalizedToken(_ rawToken: String) throws -> String {
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw PairingURLParserError.missingToken }
        return token
    }
}
