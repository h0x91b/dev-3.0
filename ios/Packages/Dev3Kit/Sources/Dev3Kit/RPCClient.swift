import Foundation

public enum RPCClientError: Error, Equatable, LocalizedError, Sendable {
    case encodingFailed(String)
    case decodingFailed(String)
    case remote(String)
    case requestTimedOut(method: String)
    case connectionClosed(code: Int, reason: String)
    case connectionFailed(String)
    case connectionReplaced
    case requestCancelled

    public var errorDescription: String? {
        switch self {
        case let .encodingFailed(message), let .decodingFailed(message), let .remote(message),
             let .connectionFailed(message):
            message
        case let .requestTimedOut(method):
            "RPC request \"\(method)\" timed out."
        case let .connectionClosed(code, reason):
            reason.isEmpty ? "RPC connection closed with code \(code)." : reason
        case .connectionReplaced:
            "RPC connection was replaced."
        case .requestCancelled:
            "RPC request was cancelled."
        }
    }
}

/// Every open requires a full board refetch because the server does not replay pushes.
public enum RPCConnectionEvent: Equatable, Sendable {
    case opened(requiresRefetch: Bool)
    case closed(code: Int, reason: String)
    case failed(String)
}

private struct RPCRequestPacket: Encodable {
    let type = "request"
    let id: Int64
    let method: String
    let params: JSONValue
}

private struct PendingRPCRequest {
    let method: String
    let packet: String
    let continuation: CheckedContinuation<JSONValue, any Error>
    var sent: Bool
    var timeoutTask: Task<Void, Never>?
}

/// A reconnect-safe JSON-over-WebSocket client for the remote v1 protocol.
public actor RPCClient: SessionConnectionControlling {
    // Swift requires this spelling for actor stored properties; SwiftFormat enforces it.
    // swiftlint:disable:next modifier_order
    public nonisolated let pushes: AsyncStream<RPCPushEvent>
    // swiftlint:disable:next modifier_order
    public nonisolated let connectionEvents: AsyncStream<RPCConnectionEvent>

    private let requestBuilder: any AuthenticatedRequestBuilding
    private let transportFactory: any WebSocketTransportCreating
    private let requestTimeout: Duration
    private let pushContinuation: AsyncStream<RPCPushEvent>.Continuation
    private let connectionContinuation: AsyncStream<RPCConnectionEvent>.Continuation

    private var sessionEventHandler: (@Sendable (SessionConnectionEvent) -> Void)?
    private var transport: (any WebSocketTransport)?
    private var receiveTask: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var activeGeneration: UInt64?
    private var nextRequestID: Int64 = 0
    private var pending: [Int64: PendingRPCRequest] = [:]

    public init(
        requestBuilder: any AuthenticatedRequestBuilding,
        transportFactory: any WebSocketTransportCreating = URLSessionWebSocketTransportFactory.rpc,
        requestTimeout: Duration = .seconds(120)
    ) {
        self.requestBuilder = requestBuilder
        self.transportFactory = transportFactory
        self.requestTimeout = requestTimeout

        let pushPair = AsyncStream.makeStream(of: RPCPushEvent.self)
        pushes = pushPair.stream
        pushContinuation = pushPair.continuation

        let connectionPair = AsyncStream.makeStream(of: RPCConnectionEvent.self)
        connectionEvents = connectionPair.stream
        connectionContinuation = connectionPair.continuation
    }

    public func setSessionEventHandler(
        _ handler: (@Sendable (SessionConnectionEvent) -> Void)?
    ) async {
        sessionEventHandler = handler
    }

    /// Replaces any prior socket. Sent requests fail; unsent requests remain queued.
    public func connect() async throws {
        generation &+= 1
        let connectionGeneration = generation

        let priorTransport = transport
        activeGeneration = nil
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil
        rejectSentRequests(with: .connectionReplaced)
        if let priorTransport {
            await priorTransport.disconnect(code: 1000, reason: "Connection replaced")
        }

        let request = try await requestBuilder.authenticatedRequest(path: "/rpc")
        let candidate = try transportFactory.makeTransport(for: request)
        transport = candidate
        activeGeneration = connectionGeneration

        do {
            try await candidate.connect()
        } catch {
            guard activeGeneration == connectionGeneration else {
                throw RPCClientError.connectionReplaced
            }
            activeGeneration = nil
            transport = nil
            throw Self.connectionError(from: error)
        }

        guard activeGeneration == connectionGeneration else {
            await candidate.disconnect(code: 1000, reason: "Superseded connection")
            throw RPCClientError.connectionReplaced
        }

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(transport: candidate, generation: connectionGeneration)
        }
        try await flushQueuedRequests(through: candidate, generation: connectionGeneration)
        guard activeGeneration == connectionGeneration else {
            throw RPCClientError.connectionReplaced
        }
        emit(.opened(requiresRefetch: true), sessionEvent: .opened)
    }

    /// Intentionally closes the socket without generating a reconnect callback.
    /// Sent requests fail; unsent requests remain available for the next open.
    public func disconnect() async {
        generation &+= 1
        let priorTransport = transport
        activeGeneration = nil
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil
        rejectSentRequests(with: .connectionReplaced)
        if let priorTransport {
            await priorTransport.disconnect(code: 1000, reason: "Client disconnected")
        }
    }

    /// Low-level typed request entry point used by the v1 method facade.
    public func call<Response: Decodable & Sendable>(
        _ method: String,
        params: some Encodable & Sendable,
        as _: Response.Type = Response.self
    ) async throws -> Response {
        let paramsValue: JSONValue
        do {
            paramsValue = try JSONValue.decodeEncoded(params)
        } catch {
            throw RPCClientError.encodingFailed(error.localizedDescription)
        }

        let value = try await request(method: method, params: paramsValue)
        do {
            return try value.decode(Response.self)
        } catch {
            throw RPCClientError.decodingFailed(error.localizedDescription)
        }
    }

    public func call<Response: Decodable & Sendable>(
        _ method: String,
        as _: Response.Type = Response.self
    ) async throws -> Response {
        let value = try await request(method: method, params: .object([:]))
        do {
            return try value.decode(Response.self)
        } catch {
            throw RPCClientError.decodingFailed(error.localizedDescription)
        }
    }

    public func callVoid(
        _ method: String,
        params: some Encodable & Sendable
    ) async throws {
        let paramsValue: JSONValue
        do {
            paramsValue = try JSONValue.decodeEncoded(params)
        } catch {
            throw RPCClientError.encodingFailed(error.localizedDescription)
        }
        _ = try await request(method: method, params: paramsValue)
    }

    public func callVoid(_ method: String) async throws {
        _ = try await request(method: method, params: .object([:]))
    }
}

private extension RPCClient {
    private func request(method: String, params: JSONValue) async throws -> JSONValue {
        try Task.checkCancellation()
        nextRequestID &+= 1
        let requestID = nextRequestID
        let packet: String
        do {
            let data = try JSONEncoder().encode(
                RPCRequestPacket(id: requestID, method: method, params: params)
            )
            guard let encoded = String(data: data, encoding: .utf8) else {
                throw RPCClientError.encodingFailed("RPC request was not valid UTF-8.")
            }
            packet = encoded
        } catch let error as RPCClientError {
            throw error
        } catch {
            throw RPCClientError.encodingFailed(error.localizedDescription)
        }

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                var entry = PendingRPCRequest(
                    method: method,
                    packet: packet,
                    continuation: continuation,
                    sent: false,
                    timeoutTask: nil
                )
                entry.timeoutTask = makeTimeoutTask(requestID: requestID)
                pending[requestID] = entry

                if let transport, let activeGeneration {
                    Task { [weak self] in
                        await self?.sendPendingRequest(
                            requestID,
                            through: transport,
                            generation: activeGeneration
                        )
                    }
                }
            }
        } onCancel: {
            Task { [weak self] in
                await self?.cancelRequest(requestID)
            }
        }
    }

    private func makeTimeoutTask(requestID: Int64) -> Task<Void, Never> {
        let timeout = requestTimeout
        return Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            await self?.timeoutRequest(requestID)
        }
    }

    private func timeoutRequest(_ requestID: Int64) {
        guard let entry = removePending(requestID) else { return }
        entry.continuation.resume(
            throwing: RPCClientError.requestTimedOut(method: entry.method)
        )
    }

    private func cancelRequest(_ requestID: Int64) {
        guard let entry = removePending(requestID) else { return }
        entry.continuation.resume(throwing: RPCClientError.requestCancelled)
    }

    private func flushQueuedRequests(
        through transport: any WebSocketTransport,
        generation: UInt64
    ) async throws {
        for requestID in pending.keys.sorted() where pending[requestID]?.sent == false {
            await sendPendingRequest(requestID, through: transport, generation: generation)
            guard activeGeneration == generation else {
                throw RPCClientError.connectionReplaced
            }
        }
    }

    private func sendPendingRequest(
        _ requestID: Int64,
        through candidate: any WebSocketTransport,
        generation: UInt64
    ) async {
        guard activeGeneration == generation,
              var entry = pending[requestID],
              !entry.sent
        else {
            return
        }
        entry.sent = true
        pending[requestID] = entry

        do {
            try await candidate.send(.text(entry.packet))
        } catch {
            handleTransportFailure(error, generation: generation)
        }
    }

    private func receiveLoop(
        transport candidate: any WebSocketTransport,
        generation: UInt64
    ) async {
        while !Task.isCancelled {
            do {
                let frame = try await candidate.receive()
                guard !Task.isCancelled else { return }
                handle(frame, generation: generation)
            } catch is CancellationError {
                return
            } catch {
                handleTransportFailure(error, generation: generation)
                return
            }
        }
    }

    private func handle(_ frame: WebSocketFrame, generation: UInt64) {
        guard activeGeneration == generation else { return }
        let data: Data = switch frame {
        case let .data(value):
            value
        case let .text(value):
            Data(value.utf8)
        }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case let .object(packet) = value,
              case let .string(type)? = packet["type"]
        else {
            return
        }

        switch type {
        case "response":
            handleResponse(packet)
        case "message":
            handlePush(packet)
        default:
            break
        }
    }

    private func handleResponse(_ packet: [String: JSONValue]) {
        guard let requestID = packet["id"]?.int64Value,
              case let .bool(success)? = packet["success"],
              let entry = removePending(requestID)
        else {
            return
        }

        if success {
            entry.continuation.resume(returning: packet["payload"] ?? .null)
        } else {
            let message = packet["error"]?.stringValue ?? "RPC error"
            entry.continuation.resume(throwing: RPCClientError.remote(message))
        }
    }

    private func handlePush(_ packet: [String: JSONValue]) {
        guard case let .string(name)? = packet["id"],
              let event = try? RPCPushEvent.decode(
                  name: name,
                  payload: packet["payload"] ?? .object([:])
              )
        else {
            return
        }
        pushContinuation.yield(event)
    }

    private func handleTransportFailure(_ error: any Error, generation: UInt64) {
        guard activeGeneration == generation else { return }
        activeGeneration = nil
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil

        let mapped = Self.connectionError(from: error)
        rejectSentRequests(with: mapped)
        switch mapped {
        case let .connectionClosed(code, reason):
            emit(
                .closed(code: code, reason: reason),
                sessionEvent: .closed(code: code, reason: reason)
            )
        default:
            emit(.failed(mapped.localizedDescription), sessionEvent: .failed)
        }
    }

    private func rejectSentRequests(with error: RPCClientError) {
        let requestIDs = pending.compactMap { id, entry in entry.sent ? id : nil }
        for requestID in requestIDs {
            guard let entry = removePending(requestID) else { continue }
            entry.continuation.resume(throwing: error)
        }
    }

    private func removePending(_ requestID: Int64) -> PendingRPCRequest? {
        guard let entry = pending.removeValue(forKey: requestID) else { return nil }
        entry.timeoutTask?.cancel()
        return entry
    }

    private func emit(_ event: RPCConnectionEvent, sessionEvent: SessionConnectionEvent) {
        connectionContinuation.yield(event)
        sessionEventHandler?(sessionEvent)
    }

    private static func connectionError(from error: any Error) -> RPCClientError {
        if let error = error as? RPCClientError {
            return error
        }
        if case let WebSocketTransportError.closed(code, reason) = error {
            return .connectionClosed(code: code, reason: reason)
        }
        if let error = error as? WebSocketTransportError {
            return .connectionFailed(error.localizedDescription)
        }
        return .connectionFailed(error.localizedDescription)
    }
}

private extension JSONValue {
    static func decodeEncoded(_ value: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    var int64Value: Int64? {
        switch self {
        case let .integer(value):
            value
        case let .number(value) where value.rounded() == value:
            Int64(exactly: value)
        default:
            nil
        }
    }

    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }
}
