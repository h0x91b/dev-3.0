@testable import Dev3Kit
import Foundation
import Testing

private let integrationOrigin = ProcessInfo.processInfo.environment["DEV3_INTEGRATION_ORIGIN"]
private let integrationCode = ProcessInfo.processInfo.environment["DEV3_INTEGRATION_CODE"]

@Suite(
    "Live session integration",
    .enabled(if: integrationOrigin != nil && integrationCode != nil)
)
struct SessionLiveIntegrationTests {
    @Test("Native exchange and refresh rotate a real remote session")
    func exchangeAndRefresh() async throws {
        let rawOrigin = try #require(integrationOrigin)
        let code = try #require(integrationCode)
        let origin = try #require(URL(string: rawOrigin))
        let client = SessionHTTPClient()
        let instance = try await client.fetchInstance(origin: origin)

        let exchange = try await client.exchange(origin: origin, token: code)
        let sessionToken = try #require(exchange.sessionToken)
        #expect(exchange.isAccepted)

        let server = try PairedServer(
            origin: origin,
            sessionToken: sessionToken,
            name: instance.name,
            instanceId: instance.instanceId
        )
        let factory = SessionRequestFactory(server: server)
        let refresh = try await client.refresh(requestFactory: factory)

        #expect(refresh.isAccepted)
        #expect(refresh.sessionToken != nil)
    }
}
