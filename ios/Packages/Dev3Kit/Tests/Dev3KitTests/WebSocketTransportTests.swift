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

    @Test("Every native transport raises Foundation's receive ceiling to the bounded RPC limit")
    func configuredReceiveLimit() throws {
        let factory = URLSessionWebSocketTransportFactory()
        let request = try URLRequest(url: #require(URL(string: "https://dev3.test/rpc")))
        let observedDiffFrameBytes = 9_443_718

        let first = try #require(
            factory.makeTransport(for: request) as? URLSessionWebSocketTransport
        )
        let replacement = try #require(
            factory.makeTransport(for: request) as? URLSessionWebSocketTransport
        )

        #expect(first.configuredMaximumMessageSize == Dev3WebSocketReceivePolicy.maximumMessageBytes)
        #expect(replacement.configuredMaximumMessageSize == Dev3WebSocketReceivePolicy.maximumMessageBytes)
        #expect(first.configuredMaximumMessageSize > observedDiffFrameBytes)
        #expect(Dev3WebSocketReceivePolicy.maximumMessageBytes == 192 * 1024 * 1024)
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
            closeReason: nil
        )

        #expect(mapped == .messageTooLarge(
            maximumBytes: Dev3WebSocketReceivePolicy.maximumMessageBytes
        ))
        #expect(mapped.localizedDescription.contains("192 MB receive limit"))
    }
}
