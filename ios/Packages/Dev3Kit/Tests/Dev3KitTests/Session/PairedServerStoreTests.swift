@testable import Dev3Kit
import Foundation
import Testing

@Suite("Paired server store")
struct PairedServerStoreTests {
    @Test("The empty store never writes to the real Keychain")
    func emptyStore() async throws {
        let secureStore = MemorySecureDataStore()
        let store = PairedServerStore(secureStore: secureStore)

        #expect(try await store.load() == PairedServerSnapshot())
        #expect(secureStore.writeCount == 0)
    }

    @Test("Servers persist with one active selection")
    func upsertAndSelect() async throws {
        let secureStore = MemorySecureDataStore()
        let store = PairedServerStore(secureStore: secureStore)
        let alpha = try server(id: "alpha", name: "Alpha", port: 4100)
        let beta = try server(id: "beta", name: "Beta", port: 4200)

        _ = try await store.upsert(beta)
        var snapshot = try await store.upsert(alpha, makeActive: false)
        #expect(snapshot.servers.map(\.name) == ["Alpha", "Beta"])
        #expect(snapshot.activeInstanceId == "beta")

        snapshot = try await store.setActive(instanceId: "alpha")
        #expect(snapshot.activeServer == alpha)

        let reloaded = PairedServerStore(secureStore: secureStore)
        #expect(try await reloaded.load() == snapshot)
    }

    @Test("Replacing a server rotates its origin and credential")
    func replaceServer() async throws {
        let secureStore = MemorySecureDataStore()
        let store = PairedServerStore(secureStore: secureStore)
        _ = try await store.upsert(server(id: "same", name: "Old", port: 4100))
        let replacement = try server(id: "same", name: "New", port: 4200, token: "rotated")

        let snapshot = try await store.upsert(replacement)

        #expect(snapshot.servers == [replacement])
        #expect(snapshot.activeServer?.sessionToken == "rotated")
    }

    @Test("Deleting an active server selects the remaining server and removes the final blob")
    func deleteServers() async throws {
        let secureStore = MemorySecureDataStore()
        let store = PairedServerStore(secureStore: secureStore)
        _ = try await store.upsert(server(id: "alpha", name: "Alpha", port: 4100))
        _ = try await store.upsert(server(id: "beta", name: "Beta", port: 4200))

        var snapshot = try await store.delete(instanceId: "beta")
        #expect(snapshot.activeInstanceId == "alpha")
        snapshot = try await store.delete(instanceId: "alpha")
        #expect(snapshot == PairedServerSnapshot())
        #expect(secureStore.deleteCount == 1)
        #expect(secureStore.data == nil)
    }

    @Test("Stored credentials can be recovered by normalized origin")
    func lookupByOrigin() async throws {
        let store = PairedServerStore(secureStore: MemorySecureDataStore())
        let saved = try server(id: "alpha", name: "Alpha", port: 4100)
        _ = try await store.upsert(saved)

        let origin = try #require(URL(string: "HTTP://127.0.0.1:4100/path?query=1"))
        #expect(try await store.server(origin: origin) == saved)
    }

    private func server(
        id: String,
        name: String,
        port: Int,
        token: String = "session-token"
    ) throws -> PairedServer {
        try PairedServer(
            origin: #require(URL(string: "http://127.0.0.1:\(port)")),
            sessionToken: token,
            name: name,
            instanceId: id
        )
    }
}

private final class MemorySecureDataStore: SecureDataStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Data?
    private var writes = 0
    private var deletes = 0

    var data: Data? {
        lock.withLock { storage }
    }

    var writeCount: Int {
        lock.withLock { writes }
    }

    var deleteCount: Int {
        lock.withLock { deletes }
    }

    func read(account _: String) throws -> Data? {
        lock.withLock { storage }
    }

    func write(_ data: Data, account _: String) throws {
        lock.withLock {
            storage = data
            writes += 1
        }
    }

    func delete(account _: String) throws {
        lock.withLock {
            storage = nil
            deletes += 1
        }
    }
}
