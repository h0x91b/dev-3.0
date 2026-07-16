import Foundation

/// Owns the active RPC client alongside the session controller so feature stores can share it.
@MainActor
public final class ConnectionRuntime {
    public let controller: ConnectionController
    public var onRPCClientChange: ((RPCClient) -> Void)? {
        didSet {
            if let client = registry.client {
                onRPCClientChange?(client)
            }
        }
    }

    private let registry: RPCClientRegistry

    public var rpcClient: RPCClient? {
        registry.client
    }

    /// Creates a PTY client backed by the same rolling session credential as RPC.
    /// A fresh client is returned per terminal so their socket lifecycles stay isolated.
    public func makePTYClient() -> PTYClient? {
        guard let requestBuilder = registry.requestBuilder else { return nil }
        return PTYClient(requestBuilder: requestBuilder)
    }

    public init(
        store: PairedServerStore = PairedServerStore(),
        transport: any SessionHTTPTransporting = SessionHTTPClient(),
        discovery: any BonjourDiscovering = BonjourDiscovery(),
        pathObserver: any NetworkPathObserving = NetworkPathObserver()
    ) {
        let registry = RPCClientRegistry()
        self.registry = registry
        controller = ConnectionController(
            store: store,
            transport: transport,
            discovery: discovery,
            pathObserver: pathObserver,
            connectionFactory: { requestBuilder in
                let client = RPCClient(requestBuilder: requestBuilder)
                registry.requestBuilder = requestBuilder
                registry.client = client
                return client
            }
        )
        registry.onChange = { [weak self] client in
            self?.onRPCClientChange?(client)
        }
    }
}

@MainActor
private final class RPCClientRegistry {
    var requestBuilder: (any AuthenticatedRequestBuilding)?
    var client: RPCClient? {
        didSet {
            if let client {
                onChange?(client)
            }
        }
    }

    var onChange: ((RPCClient) -> Void)?
}
