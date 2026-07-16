@testable import Dev3Kit
import Foundation
import Testing

private let liveOrigin = ProcessInfo.processInfo.environment["DEV3_INTEGRATION_ORIGIN"]
private let liveCode = ProcessInfo.processInfo.environment["DEV3_INTEGRATION_CODE"]
private let liveProjectID = ProcessInfo.processInfo.environment["DEV3_INTEGRATION_PROJECT_ID"]

private actor LiveRemoteContext {
    private var cachedFactory: SessionRequestFactory?

    func requestFactory() async throws -> SessionRequestFactory {
        if let cachedFactory {
            return cachedFactory
        }
        let rawOrigin = try #require(liveOrigin)
        let code = try #require(liveCode)
        let origin = try #require(URL(string: rawOrigin))
        let http = SessionHTTPClient()
        let instance = try await http.fetchInstance(origin: origin)
        let exchange = try await http.exchange(origin: origin, token: code)
        let sessionToken = try #require(exchange.sessionToken)
        let server = try PairedServer(
            origin: origin,
            sessionToken: sessionToken,
            name: instance.name,
            instanceId: instance.instanceId
        )
        let factory = SessionRequestFactory(server: server)
        cachedFactory = factory
        return factory
    }
}

private let liveRemoteContext = LiveRemoteContext()

private actor LivePTYOutputProbe {
    private var bytes = Data()

    func append(_ chunk: Data) {
        bytes.append(chunk)
        if bytes.count > 1_000_000 {
            bytes.removeFirst(bytes.count - 500_000)
        }
    }

    func contains(_ marker: String) -> Bool {
        String(data: bytes, encoding: .utf8)?.contains(marker) == true
    }

    func byteCount() -> Int {
        bytes.count
    }
}

private func waitForMarker(
    _ marker: String,
    in probe: LivePTYOutputProbe,
    timeout: Duration = .seconds(10)
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await probe.contains(marker) {
            return true
        }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return false
}

@Suite(
    "Live remote transports",
    .serialized,
    .enabled(if: liveOrigin != nil && liveCode != nil)
)
struct RemoteTransportLiveIntegrationTests {
    @Test("Six read-only RPC methods round-trip against the headless server")
    func readOnlyRPCRoundTrips() async throws {
        let factory = try await liveRemoteContext.requestFactory()
        let rpc = RPCClient(requestBuilder: factory)
        try await rpc.connect()

        let projects = try await rpc.getProjects()
        let projectTasks = try await rpc.getAllProjectTasks()
        let agents = try await rpc.getAgents()
        let settings = try await rpc.getGlobalSettings()
        let version = try await rpc.getAppVersion()
        let ping = try await rpc.ping()

        #expect(projectTasks.allSatisfy { result in
            projects.contains { $0.id == result.projectId }
        })
        #expect(!agents.isEmpty)
        #expect(!settings.defaultAgentId.isEmpty)
        #expect(!version.version.isEmpty)
        #expect(ping.ok)
        #expect(ping.serverTime > 0)
        await rpc.disconnect()
    }

    @Test(
        "An explicitly supplied project terminal carries real PTY input and output",
        .enabled(if: liveProjectID != nil)
    )
    func projectTerminalPTYEcho() async throws {
        let projectID = try #require(liveProjectID)
        let factory = try await liveRemoteContext.requestFactory()
        let rpc = RPCClient(requestBuilder: factory)
        try await rpc.connect()

        _ = try await rpc.getProjectPtyUrl(projectId: projectID)

        let pty = PTYClient(requestBuilder: factory)
        try await pty.connect(to: .project(projectID))
        // The remote proxy upgrade completes before its localhost PTY upstream has
        // an open event. Match real UI pacing so the first resize/input is not dropped.
        try await Task.sleep(for: .milliseconds(500))
        try await pty.resize(columns: 100, rows: 30)

        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let marker = "__DEV3_IOS_\(nonce)__"
        let command = "printf '%s%s\\n' '__DEV3_IOS_' '\(nonce)__'"
        let probe = LivePTYOutputProbe()
        let outputTask = Task {
            for await chunk in pty.output {
                await probe.append(chunk)
            }
        }
        try await pty.send(Data("\(command)\r".utf8))

        let foundMarker = await waitForMarker(marker, in: probe)
        if !foundMarker {
            await Issue.record("PTY marker did not arrive; observed \(probe.byteCount()) bytes")
        }
        outputTask.cancel()
        await pty.disconnect()
        await rpc.disconnect()
    }
}
