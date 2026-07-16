import Foundation

public struct Dev3TerminalFontPreferenceStore {
    public static let defaultSize = 13.0
    public static let minimumSize = 8.0
    public static let maximumSize = 28.0

    private let defaults: UserDefaults
    private let keyPrefix: String

    public init(defaults: UserDefaults = .standard, keyPrefix: String = "dev3.terminal.font-size") {
        self.defaults = defaults
        self.keyPrefix = keyPrefix
    }

    public func size(for serverID: String, fallback: Double = defaultSize) -> Double {
        let preferenceKey = key(for: serverID)
        guard defaults.object(forKey: preferenceKey) != nil else {
            return Self.clamp(fallback)
        }
        return Self.clamp(defaults.double(forKey: preferenceKey))
    }

    public func setSize(_ size: Double, for serverID: String) {
        defaults.set(Self.clamp(size), forKey: key(for: serverID))
    }

    public func reset(for serverID: String) {
        defaults.removeObject(forKey: key(for: serverID))
    }

    public static func clamp(_ size: Double) -> Double {
        min(max(size, minimumSize), maximumSize)
    }

    private func key(for serverID: String) -> String {
        "\(keyPrefix).\(serverID)"
    }
}
