@testable import Dev3Kit
import Foundation
import Testing

@Suite("URLSession WebSocket transport")
struct WebSocketTransportTests {
    @Test("HTTP origins normalize to WebSocket URLs without losing native credentials")
    func requestNormalization() throws {
        var request = try URLRequest(url: #require(URL(string: "https://dev3.test:4242/rpc?x=1")))
        request.setValue("dev3_session=secret", forHTTPHeaderField: "Cookie")

        let normalized = try WebSocketRequestNormalizer.normalize(request)

        #expect(normalized.url?.absoluteString == "wss://dev3.test:4242/rpc?x=1")
        #expect(normalized.value(forHTTPHeaderField: "Cookie") == "dev3_session=secret")

        let plain = try WebSocketRequestNormalizer.normalize(
            URLRequest(url: #require(URL(string: "http://dev3.test/rpc")))
        )
        #expect(plain.url?.scheme == "ws")
    }

    @Test("Unsupported WebSocket origins fail before URLSession starts")
    func invalidOrigin() throws {
        #expect(throws: WebSocketTransportError.invalidURL) {
            try WebSocketRequestNormalizer.normalize(
                URLRequest(url: #require(URL(string: "ftp://dev3.test/rpc")))
            )
        }
    }

    @Test("Duplicate opens and late closes resume the open continuation exactly once")
    func duplicateAndLateDelegateCallbacks() async throws {
        let delegate = WebSocketOpenDelegate()
        let opened = Task { try await delegate.waitUntilOpen() }
        await Task.yield()

        delegate.completeOpen()
        delegate.completeOpen()
        delegate.failOpenIfPending(.closed(code: 4002, reason: "late"))

        try await opened.value
        try await delegate.waitUntilOpen()
    }

    @Test("A close before open is retained for a late waiter")
    func closeBeforeOpen() async {
        let delegate = WebSocketOpenDelegate()
        delegate.failOpenIfPending(.closed(code: 4001, reason: "Unknown session"))

        await #expect(
            throws: WebSocketTransportError.closed(code: 4001, reason: "Unknown session")
        ) {
            try await delegate.waitUntilOpen()
        }
    }

    @Test("Initial and replacement RPC and PTY transports keep endpoint-specific receive bounds")
    func configuredReceiveLimit() throws {
        let rpcRequest = try URLRequest(url: #require(URL(string: "https://dev3.test/rpc")))
        let ptyRequest = try URLRequest(
            url: #require(URL(string: "https://dev3.test/pty?session=task-1"))
        )
        let observedDiffFrameBytes = 9_443_718

        let firstRPC = try configuredTransport(factory: .rpc, request: rpcRequest)
        let replacementRPC = try configuredTransport(factory: .rpc, request: rpcRequest)
        let firstPTY = try configuredTransport(factory: .pty, request: ptyRequest)
        let replacementPTY = try configuredTransport(factory: .pty, request: ptyRequest)

        #expect(URLSessionWebSocketTransportFactory.rpc.configuredMaximumMessageSize == 192 * 1024 * 1024)
        #expect(firstRPC.configuredMaximumMessageSize == 192 * 1024 * 1024)
        #expect(replacementRPC.configuredMaximumMessageSize == firstRPC.configuredMaximumMessageSize)
        #expect(firstRPC.configuredMaximumMessageSize > observedDiffFrameBytes)

        #expect(URLSessionWebSocketTransportFactory.pty.configuredMaximumMessageSize == 1024 * 1024)
        #expect(firstPTY.configuredMaximumMessageSize == 1024 * 1024)
        #expect(replacementPTY.configuredMaximumMessageSize == firstPTY.configuredMaximumMessageSize)
    }

    @Test("CFNetwork oversized-message failures retain a stable bounded error")
    func oversizedReceiveError() {
        let posix = NSError(
            domain: NSPOSIXErrorDomain,
            code: 40,
            userInfo: [NSLocalizedDescriptionKey: "Message too long"]
        )
        let wrapped = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorNetworkConnectionLost,
            userInfo: [NSUnderlyingErrorKey: posix]
        )

        let mapped = WebSocketReceiveErrorMapper.map(
            wrapped,
            closeCode: .invalid,
            closeReason: nil,
            maximumMessageBytes: Dev3WebSocketReceivePolicy.rpc.maximumMessageBytes
        )

        #expect(mapped == .messageTooLarge(
            maximumBytes: Dev3WebSocketReceivePolicy.rpc.maximumMessageBytes
        ))
        #expect(mapped.localizedDescription.contains("192 MB receive limit"))
    }

    @Test("Receive error traversal stops at indirect cycles and its depth limit")
    func boundedReceiveErrorTraversal() {
        let first = MutableUnderlyingNSError(code: 1, message: "cycle root")
        let second = MutableUnderlyingNSError(code: 2, message: "cycle child")
        first.underlyingError = second
        second.underlyingError = first

        let cycle = WebSocketReceiveErrorMapper.map(
            first,
            closeCode: .invalid,
            closeReason: nil,
            maximumMessageBytes: Dev3WebSocketReceivePolicy.rpc.maximumMessageBytes
        )
        #expect(cycle == .failed("cycle root"))

        var deep = NSError(
            domain: NSPOSIXErrorDomain,
            code: 40,
            userInfo: [NSLocalizedDescriptionKey: "Message too long"]
        )
        for depth in 0 ..< 40 {
            deep = NSError(
                domain: "dev3.deep",
                code: depth,
                userInfo: [
                    NSLocalizedDescriptionKey: "outer \(depth)",
                    NSUnderlyingErrorKey: deep
                ]
            )
        }
        let depthLimited = WebSocketReceiveErrorMapper.map(
            deep,
            closeCode: .invalid,
            closeReason: nil,
            maximumMessageBytes: Dev3WebSocketReceivePolicy.rpc.maximumMessageBytes
        )
        #expect(depthLimited == .failed("outer 39"))
    }

    @Test("A WebSocket close wins and unknown receive errors retain localized fallback text")
    func receiveErrorPrecedence() {
        let messageTooLarge = NSError(
            domain: NSPOSIXErrorDomain,
            code: 40,
            userInfo: [NSLocalizedDescriptionKey: "Message too long"]
        )

        let closeWins = WebSocketReceiveErrorMapper.map(
            messageTooLarge,
            closeCode: .internalServerError,
            closeReason: Data("server closed".utf8),
            maximumMessageBytes: Dev3WebSocketReceivePolicy.rpc.maximumMessageBytes
        )
        #expect(closeWins == .closed(code: 1011, reason: "server closed"))

        let localized = NSError(
            domain: "dev3.transport",
            code: 7,
            userInfo: [NSLocalizedDescriptionKey: "localized socket failure"]
        )
        let fallback = WebSocketReceiveErrorMapper.map(
            localized,
            closeCode: .invalid,
            closeReason: nil,
            maximumMessageBytes: Dev3WebSocketReceivePolicy.pty.maximumMessageBytes
        )
        #expect(fallback == .failed("localized socket failure"))
    }

    private func configuredTransport(
        factory: URLSessionWebSocketTransportFactory,
        request: URLRequest
    ) throws -> URLSessionWebSocketTransport {
        try #require(factory.makeTransport(for: request) as? URLSessionWebSocketTransport)
    }
}

private final class MutableUnderlyingNSError: NSError, @unchecked Sendable {
    var underlyingError: NSError?

    override var userInfo: [String: Any] {
        var info = super.userInfo
        info[NSUnderlyingErrorKey] = underlyingError
        return info
    }

    init(code: Int, message: String) {
        super.init(
            domain: "dev3.cycle",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    required init?(coder _: NSCoder) {
        nil
    }
}
