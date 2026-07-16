import Dev3Kit
import Foundation

protocol AgentCompletionServicing: Sendable {
    func respond(requestID: String, approved: Bool) async throws
}

protocol AgentCompletionServiceProviding: Sendable {
    func service() -> any AgentCompletionServicing
}

struct RPCAgentCompletionServiceProvider: AgentCompletionServiceProviding {
    let rpcClient: RPCClient

    func service() -> any AgentCompletionServicing {
        RPCAgentCompletionService(rpcClient: rpcClient)
    }
}

struct UnavailableCompletionProvider: AgentCompletionServiceProviding {
    func service() -> any AgentCompletionServicing {
        UnavailableAgentCompletionService()
    }
}

private enum AgentCompletionServiceError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "The completion response will be sent after dev3 reconnects."
    }
}

private actor UnavailableAgentCompletionService: AgentCompletionServicing {
    func respond(requestID _: String, approved _: Bool) async throws {
        throw AgentCompletionServiceError.unavailable
    }
}

private actor RPCAgentCompletionService: AgentCompletionServicing {
    private let rpcClient: RPCClient

    init(rpcClient: RPCClient) {
        self.rpcClient = rpcClient
    }

    func respond(requestID: String, approved: Bool) async throws {
        try await rpcClient.respondToAgentCompletionRequest(
            requestId: requestID,
            approved: approved
        )
    }
}
