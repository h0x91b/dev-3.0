import Foundation
import Security

public protocol SecureDataStoring: Sendable {
    func read(account: String) throws -> Data?
    func write(_ data: Data, account: String) throws
    func delete(account: String) throws
}

public struct KeychainSecureDataStore: SecureDataStoring, Sendable {
    public let service: String

    public init(service: String = "com.ittaiz.dev3.paired-servers") {
        self.service = service
    }

    public func read(account: String) throws -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainStoreError(status: status)
        }
        return data
    }

    public func write(_ data: Data, account: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        let attributes: [CFString: Any] = [kSecValueData: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else { throw KeychainStoreError(status: updateStatus) }

        var insert = query
        insert[kSecValueData] = data
        insert[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainStoreError(status: addStatus) }
    }

    public func delete(account: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError(status: status)
        }
    }
}

public struct KeychainStoreError: Error, Equatable, LocalizedError, Sendable {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }

    public var errorDescription: String? {
        "The secure server store is unavailable (\(status))."
    }
}

public struct PairedServerSnapshot: Codable, Equatable, Sendable {
    public var servers: [PairedServer]
    public var activeInstanceId: String?

    public init(servers: [PairedServer] = [], activeInstanceId: String? = nil) {
        self.servers = servers
        self.activeInstanceId = activeInstanceId
    }

    public var activeServer: PairedServer? {
        guard let activeInstanceId else { return nil }
        return servers.first(where: { $0.instanceId == activeInstanceId })
    }
}

public actor PairedServerStore {
    public static let account = "paired-server-snapshot-v1"

    private let secureStore: any SecureDataStoring
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(secureStore: any SecureDataStoring = KeychainSecureDataStore()) {
        self.secureStore = secureStore
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        decoder = JSONDecoder()
    }

    public func load() throws -> PairedServerSnapshot {
        guard let data = try secureStore.read(account: Self.account) else {
            return PairedServerSnapshot()
        }
        return try decoder.decode(PairedServerSnapshot.self, from: data)
    }

    @discardableResult
    public func upsert(_ server: PairedServer, makeActive: Bool = true) throws -> PairedServerSnapshot {
        var snapshot = try load()
        snapshot.servers.removeAll(where: { $0.instanceId == server.instanceId })
        snapshot.servers.append(server)
        snapshot.servers.sort { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        if makeActive || snapshot.activeInstanceId == nil {
            snapshot.activeInstanceId = server.instanceId
        }
        try save(snapshot)
        return snapshot
    }

    @discardableResult
    public func setActive(instanceId: String) throws -> PairedServerSnapshot {
        var snapshot = try load()
        guard snapshot.servers.contains(where: { $0.instanceId == instanceId }) else {
            throw PairedServerStoreError.serverNotFound
        }
        snapshot.activeInstanceId = instanceId
        try save(snapshot)
        return snapshot
    }

    @discardableResult
    public func delete(instanceId: String) throws -> PairedServerSnapshot {
        var snapshot = try load()
        snapshot.servers.removeAll(where: { $0.instanceId == instanceId })
        if snapshot.activeInstanceId == instanceId {
            snapshot.activeInstanceId = snapshot.servers.first?.instanceId
        }
        try save(snapshot)
        return snapshot
    }

    public func server(instanceId: String) throws -> PairedServer? {
        try load().servers.first(where: { $0.instanceId == instanceId })
    }

    public func server(origin: URL) throws -> PairedServer? {
        let normalizedOrigin = try PairingURLParser.normalizedOrigin(from: origin)
        return try load().servers.first(where: { $0.origin == normalizedOrigin })
    }

    private func save(_ snapshot: PairedServerSnapshot) throws {
        if snapshot.servers.isEmpty {
            try secureStore.delete(account: Self.account)
            return
        }
        try secureStore.write(encoder.encode(snapshot), account: Self.account)
    }
}

public enum PairedServerStoreError: Error, Equatable, LocalizedError, Sendable {
    case serverNotFound

    public var errorDescription: String? {
        "The saved instance could not be found."
    }
}
