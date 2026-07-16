import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

public enum WebSocketFrame: Equatable, Sendable {
    case data(Data)
    case text(String)
}

public enum WebSocketTransportError: Error, Equatable, LocalizedError, Sendable {
    case invalidURL
    case failed(String)
    case closed(code: Int, reason: String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            "The WebSocket URL is invalid."
        case let .failed(message):
            message
        case let .closed(code, reason):
            reason.isEmpty ? "WebSocket closed with code \(code)." : reason
        }
    }
}

public protocol WebSocketTransport: Sendable {
    func connect() async throws
    func send(_ frame: WebSocketFrame) async throws
    func receive() async throws -> WebSocketFrame
    func disconnect(code: Int, reason: String) async
}

public protocol WebSocketTransportCreating: Sendable {
    func makeTransport(for request: URLRequest) throws -> any WebSocketTransport
}

public struct URLSessionWebSocketTransportFactory: WebSocketTransportCreating, Sendable {
    public init() {}

    public func makeTransport(for request: URLRequest) throws -> any WebSocketTransport {
        try URLSessionWebSocketTransport(request: request)
    }
}

final class WebSocketOpenDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private enum State {
        case idle
        case waiting(CheckedContinuation<Void, any Error>)
        case opened
        case failed(WebSocketTransportError)
    }

    private let lock = NSLock()
    private var state = State.idle

    func waitUntilOpen() async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock {
                switch state {
                case .idle:
                    state = .waiting(continuation)
                case .opened:
                    continuation.resume()
                case let .failed(error):
                    continuation.resume(throwing: error)
                case .waiting:
                    continuation.resume(
                        throwing: WebSocketTransportError.failed("WebSocket open already pending.")
                    )
                }
            }
        }
    }

    func urlSession(
        _: URLSession,
        webSocketTask _: URLSessionWebSocketTask,
        didOpenWithProtocol _: String?
    ) {
        completeOpen()
    }

    func urlSession(
        _: URLSession,
        webSocketTask _: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        failOpenIfPending(.closed(code: Int(closeCode.rawValue), reason: text))
    }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        guard let error else { return }
        failOpenIfPending(.failed(error.localizedDescription))
    }

    func completeOpen() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, any Error>? in
            switch state {
            case let .waiting(continuation):
                state = .opened
                return continuation
            case .idle:
                state = .opened
                return nil
            case .opened, .failed:
                return nil
            }
        }
        continuation?.resume()
    }

    func failOpenIfPending(_ error: WebSocketTransportError) {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, any Error>? in
            switch state {
            case let .waiting(continuation):
                state = .failed(error)
                return continuation
            case .idle:
                state = .failed(error)
                return nil
            case .opened, .failed:
                return nil
            }
        }
        continuation?.resume(throwing: error)
    }
}

enum WebSocketRequestNormalizer {
    static func normalize(_ request: URLRequest) throws -> URLRequest {
        guard let url = request.url,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            throw WebSocketTransportError.invalidURL
        }
        switch components.scheme?.lowercased() {
        case "http":
            components.scheme = "ws"
        case "https":
            components.scheme = "wss"
        case "ws", "wss":
            break
        default:
            throw WebSocketTransportError.invalidURL
        }
        guard let webSocketURL = components.url else {
            throw WebSocketTransportError.invalidURL
        }

        var result = request
        result.url = webSocketURL
        return result
    }
}

private final class URLSessionWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    private let delegate: WebSocketOpenDelegate
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(request: URLRequest) throws {
        let webSocketRequest = try WebSocketRequestNormalizer.normalize(request)
        let delegate = WebSocketOpenDelegate()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        self.delegate = delegate
        self.session = session
        task = session.webSocketTask(with: webSocketRequest)
    }

    func connect() async throws {
        task.resume()
        try await delegate.waitUntilOpen()
    }

    func send(_ frame: WebSocketFrame) async throws {
        switch frame {
        case let .data(data):
            try await task.send(.data(data))
        case let .text(text):
            try await task.send(.string(text))
        }
    }

    func receive() async throws -> WebSocketFrame {
        do {
            switch try await task.receive() {
            case let .data(data):
                return .data(data)
            case let .string(text):
                return .text(text)
            @unknown default:
                throw WebSocketTransportError.failed("Unsupported WebSocket frame type.")
            }
        } catch {
            let code = Int(task.closeCode.rawValue)
            if code != Int(URLSessionWebSocketTask.CloseCode.invalid.rawValue) {
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                throw WebSocketTransportError.closed(code: code, reason: reason)
            }
            throw WebSocketTransportError.failed(error.localizedDescription)
        }
    }

    func disconnect(code: Int, reason: String) async {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task.cancel(with: closeCode, reason: reason.data(using: .utf8))
        session.finishTasksAndInvalidate()
    }
}
