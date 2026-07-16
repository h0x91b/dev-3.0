@testable import Dev3Kit
import Foundation
import Testing

@Suite("Session HTTP client")
struct SessionHTTPClientTests {
    @Test("Native exchange sends the iOS marker without browser origin or cookies")
    func nativeExchangeRequest() async throws {
        let loader = QueueHTTPDataLoader(responses: [
            HTTPDataResponse(
                data: Data(#"{"ok":true}"#.utf8),
                statusCode: 200,
                headers: ["Set-Cookie": "dev3_session=native-session; Max-Age=2592000; Path=/; HttpOnly"]
            )
        ])
        let client = SessionHTTPClient(loader: loader)
        let origin = try #require(URL(string: "http://127.0.0.1:4242"))

        let response = try await client.exchange(origin: origin, token: "one-time-code")
        let request = try #require(await loader.requests.first)
        let body = try #require(request.httpBody)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])

        #expect(response == SessionAuthResponse(statusCode: 200, sessionToken: "native-session"))
        #expect(request.url?.absoluteString == "http://127.0.0.1:4242/auth/exchange")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(object == ["token": "one-time-code", "client": "ios"])
    }

    @Test("Refresh sends the manual cookie and rotates from Set-Cookie")
    func refreshRequest() async throws {
        let loader = QueueHTTPDataLoader(responses: [
            HTTPDataResponse(
                data: Data(#"{"ok":true}"#.utf8),
                statusCode: 200,
                headers: ["set-cookie": "dev3_session=rotated; Max-Age=2592000; Path=/"]
            )
        ])
        let client = SessionHTTPClient(loader: loader)
        let factory = try SessionRequestFactory(server: server(token: "current"))

        let response = try await client.refresh(requestFactory: factory)
        let request = try #require(await loader.requests.first)

        #expect(response.sessionToken == "rotated")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "dev3_session=current")
        #expect(request.httpMethod == "POST")
    }

    @Test("Instance metadata enforces protocol compatibility")
    func instanceCompatibility() async throws {
        let supported = RemoteInstanceInfo(
            instanceId: "instance-1",
            name: "Development Mac",
            appVersion: "1.36.0",
            protocolVersion: 1
        )
        let loader = try QueueHTTPDataLoader(responses: [
            HTTPDataResponse(data: JSONEncoder().encode(supported), statusCode: 200, headers: [:]),
            HTTPDataResponse(
                data: JSONEncoder().encode(
                    RemoteInstanceInfo(
                        instanceId: "future",
                        name: "Future",
                        appVersion: "2.0.0",
                        protocolVersion: 2
                    )
                ),
                statusCode: 200,
                headers: [:]
            )
        ])
        let client = SessionHTTPClient(loader: loader)
        let origin = try #require(URL(string: "https://example.com"))

        #expect(try await client.fetchInstance(origin: origin) == supported)
        await #expect(throws: SessionHTTPError.unsupportedProtocol(2)) {
            try await client.fetchInstance(origin: origin)
        }
    }

    @Test(
        "Set-Cookie parsing accepts only a nonempty dev3 session",
        arguments: [
            ("dev3_session=abc.def; Path=/", "abc.def"),
            (" dev3_session = value ; HttpOnly", "value"),
            ("other=value; Path=/", nil),
            ("dev3_session=; Max-Age=0", nil),
            ("malformed", nil)
        ]
    )
    func cookieParsing(header: String, expected: String?) {
        #expect(SessionHTTPClient.sessionToken(fromSetCookie: header) == expected)
    }

    private func server(token: String) throws -> PairedServer {
        try PairedServer(
            origin: #require(URL(string: "http://127.0.0.1:4242")),
            sessionToken: token,
            name: "Local dev3",
            instanceId: "instance-1"
        )
    }
}

private actor QueueHTTPDataLoader: HTTPDataLoading {
    private var queuedResponses: [HTTPDataResponse]
    private(set) var requests: [URLRequest] = []

    init(responses: [HTTPDataResponse]) {
        queuedResponses = responses
    }

    func data(for request: URLRequest) async throws -> HTTPDataResponse {
        requests.append(request)
        guard !queuedResponses.isEmpty else { throw QueueHTTPError.empty }
        return queuedResponses.removeFirst()
    }
}

private enum QueueHTTPError: Error {
    case empty
}
