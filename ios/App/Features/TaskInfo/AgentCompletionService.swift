import Dev3Kit

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
