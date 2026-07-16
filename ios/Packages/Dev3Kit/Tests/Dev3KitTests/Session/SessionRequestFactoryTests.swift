@testable import Dev3Kit
import Foundation
import Testing

@Suite("Session request factory")
struct SessionRequestFactoryTests {
    @Test("Authenticated requests attach the session cookie manually")
    func manualCookieHeader() async throws {
        let server = try testServer(token: "header.payload.signature")
        let factory = SessionRequestFactory(server: server)

        let request = try await factory.authenticatedRequest(
            path: "/pty",
            queryItems: [URLQueryItem(name: "session", value: "task-1")]
        )

        #expect(request.url?.absoluteString == "http://127.0.0.1:4242/pty?session=task-1")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "dev3_session=header.payload.signature")
    }

    @Test("Token and origin rotate atomically")
    func tokenRotation() async throws {
        let factory = try SessionRequestFactory(server: testServer(token: "old"))
        let replacement = try PairedServer(
            origin: #require(URL(string: "https://remote.example.com")),
            sessionToken: "new",
            name: "Remote",
            instanceId: "instance-1"
        )

        await factory.update(server: replacement)
        let request = try await factory.authenticatedRequest(path: "/health")

        #expect(request.url?.absoluteString == "https://remote.example.com/health")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "dev3_session=new")
    }

    @Test("Header injection and invalid paths are rejected")
    func rejectsUnsafeValues() throws {
        #expect(throws: SessionRequestError.invalidCredential) {
            try PairedServer(
                origin: #require(URL(string: "https://example.com")),
                sessionToken: "token; injected=value",
                name: "Unsafe",
                instanceId: "instance-1"
            )
        }
        #expect(throws: SessionRequestError.invalidPath) {
            try SessionRequestFactory.request(
                origin: #require(URL(string: "https://example.com")),
                path: "//attacker.example/path"
            )
        }
    }

    private func testServer(token: String) throws -> PairedServer {
        try PairedServer(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            sessionToken: token,
            name: "Local dev3",
            instanceId: "instance-1"
        )
    }
}
