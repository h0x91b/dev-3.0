public enum ConnectionState: String, CaseIterable, Equatable, Sendable {
    case pairing
    case connected
}

public struct CompanionServer: Equatable, Sendable {
    public let name: String

    public init(name: String) {
        self.name = name
    }

    public static let preview = CompanionServer(name: "Local dev3")
}
