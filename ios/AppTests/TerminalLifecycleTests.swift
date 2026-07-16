@testable import dev3
import Dev3Kit
import Dev3TerminalKit
import Foundation
import Testing

@Suite("Terminal lifecycle recovery")
@MainActor
struct TerminalLifecycleTests {
    @Test("Foregrounding an attached terminal kicks PTY once and preserves focus changes")
    func foregroundRecovery() async {
        let service = RecordingTerminalLifecycleService()
        let store = TerminalTaskStore(service: service)

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        await eventually("The terminal should attach and become active") {
            let snapshot = await service.snapshot()
            return snapshot.attachCount == 1
                && snapshot.activeChanges == [true]
                && snapshot.navigationRefreshCount == 2
        }

        store.sceneChanged(isActive: false)
        await eventually("Backgrounding should release terminal focus without kicking PTY") {
            let snapshot = await service.snapshot()
            return snapshot.activeChanges == [true, false] && snapshot.kickCount == 0
        }

        store.sceneChanged(isActive: true)
        await eventually("Foregrounding should restore focus and kick PTY exactly once") {
            let snapshot = await service.snapshot()
            return snapshot.activeChanges == [true, false, true] && snapshot.kickCount == 1
        }

        store.sceneChanged(isActive: true)
        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        try? await Task.sleep(for: .milliseconds(20))
        let snapshot = await service.snapshot()
        #expect(snapshot.attachCount == 1)
        #expect(snapshot.kickCount == 1)

        await store.detach()
    }

    @Test("Reachability recovery kicks only an active attached terminal once per revision")
    func reachabilityRecovery() async {
        let service = RecordingTerminalLifecycleService()
        let store = TerminalTaskStore(service: service)

        store.networkBecameReachable(revision: 1)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().kickCount == 0)

        store.attach(isSceneActive: true, networkRecoveryRevision: 1)
        await eventually("The terminal should finish attaching") {
            let snapshot = await service.snapshot()
            return snapshot.attachCount == 1 && snapshot.navigationRefreshCount == 2
        }

        store.networkBecameReachable(revision: 2)
        store.networkBecameReachable(revision: 2)
        await eventually("One new reachability revision should kick PTY exactly once") {
            await service.snapshot().kickCount == 1
        }

        store.sceneChanged(isActive: false)
        await eventually("The terminal should become inactive") {
            await service.snapshot().activeChanges == [true, false]
        }
        store.networkBecameReachable(revision: 3)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().kickCount == 1)

        await store.detach()
        store.networkBecameReachable(revision: 4)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().kickCount == 1)
    }

    private func eventually(
        _ failureMessage: String,
        condition: @MainActor () async -> Bool
    ) async {
        for _ in 0 ..< 100 {
            if await condition() {
                return
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record(Comment(rawValue: failureMessage))
    }
}

private actor RecordingTerminalLifecycleService: TerminalTaskServicing {
    struct Snapshot: Sendable {
        let attachCount: Int
        let kickCount: Int
        let activeChanges: [Bool]
        let navigationRefreshCount: Int
    }

    nonisolated let taskID = "task-lifecycle"
    nonisolated let serverID = "server-lifecycle"
    nonisolated let endpoint = Dev3TerminalEndpoint(
        identity: "terminal-lifecycle",
        output: .finished,
        send: { _ in },
        resize: { _, _ in }
    )
    nonisolated let terminalInteraction = Dev3TerminalInteraction(sendData: { _ in })
    nonisolated let usesSharedTerminalDimensions = true

    private var attachCount = 0
    private var kickCount = 0
    private var activeChanges: [Bool] = []
    private var navigationRefreshCount = 0

    func snapshot() -> Snapshot {
        Snapshot(
            attachCount: attachCount,
            kickCount: kickCount,
            activeChanges: activeChanges,
            navigationRefreshCount: navigationRefreshCount
        )
    }

    func attach() async throws {
        attachCount += 1
    }

    func detach() async {}

    func kick() async {
        kickCount += 1
    }

    func setTerminalActive(_ active: Bool) async throws {
        activeChanges.append(active)
    }

    func resume() async throws {}

    func restart() async throws {}

    func windowNavigation(
        step _: TerminalPagerStep?,
        index _: Int?
    ) async throws -> Dev3TmuxWindowNavigation {
        navigationRefreshCount += 1
        return try JSONDecoder().decode(
            Dev3TmuxWindowNavigation.self,
            from: Data(#"{"count":1,"activeIndex":0,"labels":["main"]}"#.utf8)
        )
    }

    func paneNavigation(
        step _: TerminalPagerStep?,
        index _: Int?,
        zoom _: Bool
    ) async throws -> Dev3TmuxPaneNavigation {
        navigationRefreshCount += 1
        return try JSONDecoder().decode(
            Dev3TmuxPaneNavigation.self,
            from: Data(#"{"count":1,"activeIndex":0,"zoomed":true,"labels":["main"]}"#.utf8)
        )
    }

    func paneCount() async throws -> Int {
        1
    }

    func perform(_: TerminalPaneAction, force _: Bool) async throws {}

    func submit(_: String) async -> Dev3TerminalSubmitOutcome {
        .submittedImmediately
    }

    func insert(_: String) async throws {}

    func send(_: Data) async throws {}

    func resize(columns _: Int, rows _: Int) async throws {}
}
