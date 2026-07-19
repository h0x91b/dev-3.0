@testable import Dev3Kit
import Foundation
import Testing

@Suite("Pairing failure copy classifies each scenario accurately")
@MainActor
struct SessionClientMessagesTests {
    @Test("A 404 blames the desktop version and points at /instance")
    func missingInstanceEndpoint() {
        let message = SessionClient.pairingInstanceFailureMessage(for: SessionHTTPError.httpStatus(404))
        #expect(message.contains("too old"))
        #expect(message.contains("/instance"))
    }

    @Test(
        "A non-404 HTTP status says the desktop is reachable but errored, never 'too old'",
        arguments: [500, 502, 503, 400, 418]
    )
    func serverSideError(status: Int) {
        let message = SessionClient.pairingInstanceFailureMessage(
            for: SessionHTTPError.httpStatus(status)
        )
        #expect(message.contains("reachable"))
        #expect(message.contains("HTTP \(status)"))
        #expect(!message.contains("too old"))
    }

    @Test("A malformed /instance reply says reachable-but-unreadable, never 'too old'")
    func malformedResponse() {
        let message = SessionClient.pairingInstanceFailureMessage(for: SessionHTTPError.invalidResponse)
        #expect(message.contains("reachable"))
        #expect(!message.contains("too old"))
    }

    @Test("A protocol mismatch names the version and asks to update, not to blame reachability")
    func protocolMismatch() {
        let message = SessionClient.pairingInstanceFailureMessage(
            for: SessionHTTPError.unsupportedProtocol(2)
        )
        #expect(message.contains("v2"))
        #expect(!message.contains("too old"))
    }

    @Test("A network error while fetching /instance falls back to the reachability message")
    func networkErrorFetchingInstance() {
        let underlying = URLError(.cannotConnectToHost)
        let message = SessionClient.pairingInstanceFailureMessage(for: underlying)
        #expect(message == SessionClient.pairingUnreachableMessage)
    }

    @Test("The reachability message suggests Wi-Fi / VPN checks and never blames the version")
    func unreachableCopyIsActionable() {
        let message = SessionClient.pairingUnreachableMessage
        #expect(message.contains("Wi-Fi"))
        #expect(message.contains("VPN") || message.contains("firewall"))
        #expect(!message.contains("too old"))
    }
}
