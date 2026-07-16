import Dev3Kit
import Dev3UI
import Foundation

protocol TaskDiffRPCRequesting: Sendable {
    func requestTaskDiff(_ request: TaskDiffFetchRequest) async throws -> Dev3TaskDiff
}

extension RPCClient: TaskDiffRPCRequesting {
    func requestTaskDiff(_ request: TaskDiffFetchRequest) async throws -> Dev3TaskDiff {
        try await getTaskDiff(
            taskId: request.taskID,
            projectId: request.projectID,
            mode: request.mode,
            compareRef: request.compareRef,
            compareLabel: request.compareLabel,
            count: request.count
        )
    }
}

typealias TaskDiffRPCClientProvider = @MainActor @Sendable () -> (any TaskDiffRPCRequesting)?

actor RPCTaskDiffService: TaskDiffServicing {
    private let rpcClientProvider: TaskDiffRPCClientProvider

    init(rpcClientProvider: @escaping TaskDiffRPCClientProvider) {
        self.rpcClientProvider = rpcClientProvider
    }

    func taskDiff(_ request: TaskDiffFetchRequest) async throws -> Dev3TaskDiff {
        guard let rpcClient = await rpcClientProvider() else {
            throw OfflineTaskDiffError()
        }
        return try await rpcClient.requestTaskDiff(request)
    }
}

private struct OfflineTaskDiffError: LocalizedError {
    var errorDescription: String? {
        "Reconnect to load this diff."
    }
}

actor LocalTaskDiffReadStore: TaskDiffReadPersisting {
    private struct Storage: Codable {
        var scopes: [String: [String: TimeInterval]]
    }

    private let defaults: UserDefaults
    private let storageKey = "dev3.native.diff-read-state.v1"
    private let maximumSignatures = 2000

    init() {
        defaults = .standard
    }

    init?(suiteName: String) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        self.defaults = defaults
    }

    func readSignatures(serverID: String, taskID: String) -> Set<String> {
        let storage = load()
        guard let signatures = storage.scopes[scope(serverID: serverID, taskID: taskID)] else {
            return []
        }
        return Set(signatures.keys)
    }

    func setRead(
        _ isRead: Bool,
        signature: String,
        serverID: String,
        taskID: String
    ) {
        var storage = load()
        let scope = scope(serverID: serverID, taskID: taskID)
        if isRead {
            storage.scopes[scope, default: [:]][signature] = Date().timeIntervalSince1970
        } else {
            storage.scopes[scope]?.removeValue(forKey: signature)
            if storage.scopes[scope]?.isEmpty == true {
                storage.scopes.removeValue(forKey: scope)
            }
        }
        prune(&storage)
        save(storage)
    }

    private func scope(serverID: String, taskID: String) -> String {
        "\(serverID)\u{1f}\(taskID)"
    }

    private func load() -> Storage {
        guard let data = defaults.data(forKey: storageKey),
              let storage = try? JSONDecoder().decode(Storage.self, from: data)
        else {
            return Storage(scopes: [:])
        }
        return storage
    }

    private func save(_ storage: Storage) {
        guard let data = try? JSONEncoder().encode(storage) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private func prune(_ storage: inout Storage) {
        let entries = storage.scopes.flatMap { scope, signatures in
            signatures.map { signature, timestamp in (scope, signature, timestamp) }
        }
        guard entries.count > maximumSignatures else { return }
        let stale = entries.sorted { $0.2 < $1.2 }.prefix(entries.count - maximumSignatures)
        for entry in stale {
            storage.scopes[entry.0]?.removeValue(forKey: entry.1)
            if storage.scopes[entry.0]?.isEmpty == true {
                storage.scopes.removeValue(forKey: entry.0)
            }
        }
    }
}
