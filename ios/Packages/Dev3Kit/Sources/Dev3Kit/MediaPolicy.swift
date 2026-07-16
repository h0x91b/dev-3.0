import Foundation

public enum Dev3MediaPayloadError: Error, Equatable, LocalizedError, Sendable {
    case invalidDataURL
    case unsupportedMIME(String)
    case payloadTooLarge
    case invalidArtifactHTML
    case invalidAssetName(String)
    case duplicateAssetName(String)
    case tooManyAssets
    case artifactAssetsTooLarge
    case invalidDownload

    public var errorDescription: String? {
        switch self {
        case .invalidDataURL:
            "The media payload was not valid base64 data."
        case let .unsupportedMIME(mime):
            "The media type \"\(mime)\" is not supported."
        case .payloadTooLarge:
            "The media payload exceeded the 25 MB limit."
        case .invalidArtifactHTML:
            "The artifact HTML was invalid or too large."
        case let .invalidAssetName(name):
            "The artifact asset name \"\(name)\" is unsafe."
        case let .duplicateAssetName(name):
            "The artifact contains duplicate asset \"\(name)\"."
        case .tooManyAssets:
            "The artifact contains more than 20 assets."
        case .artifactAssetsTooLarge:
            "The artifact assets exceeded the 100 MB combined limit."
        case .invalidDownload:
            "The artifact download was invalid."
        }
    }
}

public struct Dev3DecodedMedia: Equatable, Sendable {
    public let mime: String
    public let data: Data

    public init(mime: String, data: Data) {
        self.mime = mime
        self.data = data
    }
}

public enum Dev3MediaDataURL {
    public static let maximumBytes = 25 * 1024 * 1024
    public static let supportedMIMEs: Set<String> = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp"
    ]

    public static func decode(_ value: String) throws -> Dev3DecodedMedia {
        guard value.hasPrefix("data:"),
              let comma = value.firstIndex(of: ",")
        else {
            throw Dev3MediaPayloadError.invalidDataURL
        }
        let metadata = value[value.index(value.startIndex, offsetBy: 5) ..< comma]
        let fields = metadata.split(separator: ";", omittingEmptySubsequences: false)
        guard let mimeField = fields.first,
              fields.dropFirst().contains(where: { $0.lowercased() == "base64" })
        else {
            throw Dev3MediaPayloadError.invalidDataURL
        }
        let mime = mimeField.lowercased()
        guard supportedMIMEs.contains(mime) else {
            throw Dev3MediaPayloadError.unsupportedMIME(mime)
        }
        let encoded = String(value[value.index(after: comma)...])
        guard let data = Data(base64Encoded: encoded) else {
            throw Dev3MediaPayloadError.invalidDataURL
        }
        guard data.count <= maximumBytes else {
            throw Dev3MediaPayloadError.payloadTooLarge
        }
        return Dev3DecodedMedia(mime: mime, data: data)
    }
}

public enum Dev3MediaHistory {
    public static func normalizedIDs(_ ids: [String], limit: Int) -> [String] {
        guard limit > 0 else { return [] }
        var seen = Set<String>()
        let newestUnique = ids.reversed().filter { id in
            !id.isEmpty && seen.insert(id).inserted
        }
        return Array(newestUnique.reversed().suffix(limit))
    }

    public static func replacementSelection(
        currentIDs: [String],
        currentIndex: Int?,
        incomingIDs: [String],
        newCount: Int
    ) -> Int? {
        guard !incomingIDs.isEmpty else { return nil }
        if newCount > 0 {
            return incomingIDs.count - 1
        }
        if let currentIndex, currentIDs.indices.contains(currentIndex) {
            if let preserved = incomingIDs.firstIndex(of: currentIDs[currentIndex]) {
                return preserved
            }
        }
        return min(max(currentIndex ?? incomingIDs.count - 1, 0), incomingIDs.count - 1)
    }
}

public struct Dev3ArtifactResource: Equatable, Sendable {
    public let name: String
    public let mime: String
    public let data: Data

    public init(name: String, mime: String, data: Data) {
        self.name = name
        self.mime = mime
        self.data = data
    }
}

public struct Dev3ArtifactWebBundle: Equatable, Sendable {
    public static let maximumHTMLBytes = 5 * 1024 * 1024
    public static let maximumAssetCount = 20
    public static let maximumTotalAssetBytes = 100 * 1024 * 1024

    public let artifactID: String
    public let document: Data
    public let assets: [String: Dev3ArtifactResource]
    public let urlSpace: Dev3ArtifactURLSpace

    public init(
        artifactID: String,
        html: String,
        assets payloads: [Dev3ArtifactContentAsset]
    ) throws {
        guard payloads.count <= Self.maximumAssetCount else {
            throw Dev3MediaPayloadError.tooManyAssets
        }
        let composed = Dev3ArtifactDocumentPolicy.compose(html)
        guard let document = composed.data(using: .utf8),
              document.count <= Self.maximumHTMLBytes
        else {
            throw Dev3MediaPayloadError.invalidArtifactHTML
        }

        var resources: [String: Dev3ArtifactResource] = [:]
        var totalBytes = 0
        for payload in payloads {
            guard isSafeRelativeArtifactPath(payload.name) else {
                throw Dev3MediaPayloadError.invalidAssetName(payload.name)
            }
            guard resources[payload.name] == nil else {
                throw Dev3MediaPayloadError.duplicateAssetName(payload.name)
            }
            let decoded = try Dev3MediaDataURL.decode(payload.dataUrl)
            guard decoded.mime == payload.mime.lowercased() else {
                throw Dev3MediaPayloadError.unsupportedMIME(payload.mime)
            }
            totalBytes += decoded.data.count
            guard totalBytes <= Self.maximumTotalAssetBytes else {
                throw Dev3MediaPayloadError.artifactAssetsTooLarge
            }
            resources[payload.name] = Dev3ArtifactResource(
                name: payload.name,
                mime: decoded.mime,
                data: decoded.data
            )
        }

        self.artifactID = artifactID
        self.document = document
        assets = resources
        urlSpace = Dev3ArtifactURLSpace(artifactID: artifactID)
    }
}

public enum Dev3ArtifactDocumentPolicy {
    public static let contentSecurityPolicy = [
        "default-src 'none'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "font-src 'self' data:",
        "connect-src 'none'",
        "frame-src 'none'",
        "child-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].joined(separator: "; ")

    public static func compose(_ source: String) -> String {
        let escapedCSP = contentSecurityPolicy.replacingOccurrences(of: "\"", with: "&quot;")
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(escapedCSP)\">"
        var output = source
        if let head = output.range(of: "<head", options: [.caseInsensitive]) {
            if let end = output[head.lowerBound...].firstIndex(of: ">") {
                output.insert(contentsOf: meta, at: output.index(after: end))
                return output
            }
        }
        if let html = output.range(of: "<html", options: [.caseInsensitive]) {
            if let end = output[html.lowerBound...].firstIndex(of: ">") {
                output.insert(contentsOf: "<head>\(meta)</head>", at: output.index(after: end))
                return output
            }
        }
        let body = source.replacingOccurrences(
            of: "<!doctype[^>]*>",
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        return "<!doctype html><html><head>\(meta)</head><body>\(body)</body></html>"
    }
}

public enum Dev3ArtifactResourceResolution: Equatable, Sendable {
    case document
    case asset(String)
    case denied
}

public struct Dev3ArtifactURLSpace: Equatable, Sendable {
    public static let scheme = "dev3artifact"

    public let host: String
    public let documentURL: URL

    public init(artifactID: String) {
        let safe = artifactID.lowercased().unicodeScalars.map { scalar -> Character in
            let isAllowed = CharacterSet.alphanumerics.contains(scalar) || scalar == "-"
            return isAllowed ? Character(String(scalar)) : "-"
        }
        let slug = String(safe).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        host = "artifact-\(slug.isEmpty ? "content" : String(slug.prefix(80)))"
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = host
        components.path = "/index.html"
        guard let url = components.url else {
            preconditionFailure("The static artifact origin must form a valid URL.")
        }
        documentURL = url
    }

    public func resolve(_ url: URL, assetNames: Set<String>) -> Dev3ArtifactResourceResolution {
        guard url.scheme?.lowercased() == Self.scheme,
              url.host?.lowercased() == host,
              url.user == nil,
              url.password == nil,
              url.port == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            return .denied
        }
        let rawPath = components.percentEncodedPath
        guard !rawPath.lowercased().contains("%2f"),
              !rawPath.lowercased().contains("%5c"),
              let path = rawPath.removingPercentEncoding,
              !path.contains("\\")
        else {
            return .denied
        }
        if path == "/index.html" {
            return .document
        }
        guard path.hasPrefix("/") else { return .denied }
        let name = String(path.dropFirst())
        guard isSafeRelativeArtifactPath(name), assetNames.contains(name) else {
            return .denied
        }
        return .asset(name)
    }

    public func allowsTopLevelNavigation(to url: URL, isInitial: Bool) -> Bool {
        guard resolve(url, assetNames: []) == .document else { return false }
        if isInitial {
            return url.fragment == nil
        }
        var requested = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var document = URLComponents(url: documentURL, resolvingAgainstBaseURL: false)
        requested?.fragment = nil
        document?.fragment = nil
        return requested?.url == document?.url && url.fragment != nil
    }
}

private func isSafeRelativeArtifactPath(_ path: String) -> Bool {
    guard !path.isEmpty,
          !path.hasPrefix("/"),
          !path.hasSuffix("/"),
          !path.contains("\\"),
          !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else {
        return false
    }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    return segments.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}

public enum Dev3ArtifactDownloadPolicy {
    public static let maximumBytes = 105 * 1024 * 1024

    public static func decode(_ response: Dev3ArtifactDownloadResponse) throws -> Dev3DecodedMedia {
        let mime = response.mime.lowercased()
        guard ["application/zip", "text/html"].contains(mime),
              let data = Data(base64Encoded: response.base64),
              data.count <= maximumBytes
        else {
            throw Dev3MediaPayloadError.invalidDownload
        }
        return Dev3DecodedMedia(mime: mime, data: data)
    }
}
