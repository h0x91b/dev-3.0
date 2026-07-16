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

        store.detach()
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

        store.detach()
        store.networkBecameReachable(revision: 4)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().kickCount == 1)
    }

    @Test("Returning to the same terminal observes connection states after detaching")
    func reattachPreservesConnectionStateObservation() async {
        let service = RecordingTerminalLifecycleService()
        let store = TerminalTaskStore(service: service)

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        await eventually("The first terminal visit should connect") {
            let snapshot = await service.snapshot()
            return store.phase == .connected && snapshot.attachCount == 1
        }

        store.detach()
        await eventually("Leaving the terminal should finish detaching") {
            let snapshot = await service.snapshot()
            return store.phase == .disconnected && snapshot.detachCompletedCount == 1
        }

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        await eventually("The second terminal visit should observe the connected state") {
            let snapshot = await service.snapshot()
            return store.phase == .connected && snapshot.attachCount == 2
        }

        store.detach()
        await eventually("The second terminal visit should finish detaching") {
            await service.snapshot().detachCompletedCount == 2
        }
    }

    @Test("An immediate reattach waits for the previous detach")
    func immediateReattachWaitsForDetach() async {
        let detachGate = TerminalLifecycleDetachGate()
        let service = RecordingTerminalLifecycleService(detachGate: detachGate)
        let store = TerminalTaskStore(service: service)

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        await eventually("The first terminal visit should connect") {
            let snapshot = await service.snapshot()
            return store.phase == .connected && snapshot.attachCount == 1
        }

        store.detach()
        await eventually("The detach should reach the lifecycle service") {
            await service.snapshot().detachStartedCount == 1
        }

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().attachCount == 1)

        await detachGate.open()
        await eventually("The reattach should start after the detach completes") {
            let snapshot = await service.snapshot()
            return store.phase == .connected
                && snapshot.attachCount == 2
                && snapshot.events == [
                    .attach(1),
                    .detachStarted(1),
                    .detachCompleted(1),
                    .attach(2)
                ]
        }

        store.detach()
        await eventually("The second terminal visit should finish detaching") {
            await service.snapshot().detachCompletedCount == 2
        }
    }

    @Test(
        "Visibility detach waits for in-flight recovery and wins",
        arguments: RecordingTerminalLifecycleService.RecoveryKind.allCases
    )
    func detachWinsAgainstRecovery(
        kind: RecordingTerminalLifecycleService.RecoveryKind
    ) async {
        let recoveryGate = TerminalLifecycleDetachGate()
        let service = RecordingTerminalLifecycleService(recoveryGate: recoveryGate)
        let store = TerminalTaskStore(service: service)

        store.attach(isSceneActive: true, networkRecoveryRevision: 0)
        await eventually("The terminal should finish attaching") {
            let snapshot = await service.snapshot()
            return store.phase == .connected && snapshot.navigationRefreshCount == 2
        }

        switch kind {
        case .resume:
            store.resume()
        case .restart:
            store.restart()
        }
        await eventually("Recovery should reach the lifecycle service") {
            await service.snapshot().events.contains(.recoveryStarted(kind))
        }

        store.detach()
        try? await Task.sleep(for: .milliseconds(20))
        var snapshot = await service.snapshot()
        #expect(snapshot.detachStartedCount == 0)
        #expect(snapshot.navigationRefreshCount == 2)

        await recoveryGate.open()
        await eventually("Detach should run after stale recovery finishes") {
            let snapshot = await service.snapshot()
            return store.phase == .disconnected && snapshot.detachCompletedCount == 1
        }

        snapshot = await service.snapshot()
        #expect(snapshot.navigationRefreshCount == 2)
        #expect(snapshot.events == [
            .attach(1),
            .recoveryStarted(kind),
            .recoveryCompleted(kind),
            .detachStarted(1),
            .detachCompleted(1)
        ])
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

actor RecordingTerminalLifecycleService: TerminalTaskServicing {
    enum RecoveryKind: CaseIterable, Equatable, Sendable {
        case resume
        case restart
    }

    enum Event: Equatable, Sendable {
        case attach(Int)
        case detachStarted(Int)
        case detachCompleted(Int)
        case recoveryStarted(RecoveryKind)
        case recoveryCompleted(RecoveryKind)
    }

    struct Snapshot: Sendable {
        let attachCount: Int
        let detachStartedCount: Int
        let detachCompletedCount: Int
        let kickCount: Int
        let activeChanges: [Bool]
        let navigationRefreshCount: Int
        let sentData: [Data]
        let events: [Event]
    }

    nonisolated let taskID = "task-lifecycle"
    nonisolated let serverID = "server-lifecycle"
    nonisolated let endpoint: Dev3TerminalEndpoint
    nonisolated let terminalInteraction = Dev3TerminalInteraction(sendData: { _ in })
    nonisolated let usesSharedTerminalDimensions = true

    private let stateSource: TerminalLifecycleStateSource
    private let detachGate: TerminalLifecycleDetachGate?
    private let recoveryGate: TerminalLifecycleDetachGate?
    private var attachCount = 0
    private var detachStartedCount = 0
    private var detachCompletedCount = 0
    private var kickCount = 0
    private var activeChanges: [Bool] = []
    private var navigationRefreshCount = 0
    private var sentData: [Data] = []
    private var events: [Event] = []

    init(
        detachGate: TerminalLifecycleDetachGate? = nil,
        recoveryGate: TerminalLifecycleDetachGate? = nil
    ) {
        let stateSource = TerminalLifecycleStateSource()
        self.stateSource = stateSource
        self.detachGate = detachGate
        self.recoveryGate = recoveryGate
        endpoint = Dev3TerminalEndpoint(
            identity: "terminal-lifecycle",
            output: .finished,
            connectionStates: stateSource.stream,
            send: { _ in },
            resize: { _, _ in }
        )
    }

    func snapshot() -> Snapshot {
        Snapshot(
            attachCount: attachCount,
            detachStartedCount: detachStartedCount,
            detachCompletedCount: detachCompletedCount,
            kickCount: kickCount,
            activeChanges: activeChanges,
            navigationRefreshCount: navigationRefreshCount,
            sentData: sentData,
            events: events
        )
    }

    func attach() async throws {
        attachCount += 1
        events.append(.attach(attachCount))
        stateSource.yield(.connecting)
        stateSource.yield(.connected)
    }

    func detach() async {
        detachStartedCount += 1
        events.append(.detachStarted(detachStartedCount))
        await detachGate?.wait()
        detachCompletedCount += 1
        events.append(.detachCompleted(detachCompletedCount))
        stateSource.yield(.disconnected)
    }

    func kick() async {
        kickCount += 1
    }

    func setTerminalActive(_ active: Bool) async throws {
        activeChanges.append(active)
    }

    func resume() async throws {
        await performRecovery(.resume)
    }

    func restart() async throws {
        await performRecovery(.restart)
    }

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

    func send(_ data: Data) async throws {
        sentData.append(data)
    }

    func resize(columns _: Int, rows _: Int) async throws {}

    private func performRecovery(_ kind: RecoveryKind) async {
        events.append(.recoveryStarted(kind))
        await recoveryGate?.wait()
        events.append(.recoveryCompleted(kind))
        stateSource.yield(.connected)
    }
}

private struct TerminalLifecycleStateSource: Sendable {
    let stream: AsyncStream<Dev3TerminalConnectionState>
    private let continuation: AsyncStream<Dev3TerminalConnectionState>.Continuation

    init() {
        let pair = AsyncStream.makeStream(
            of: Dev3TerminalConnectionState.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        stream = pair.stream
        continuation = pair.continuation
    }

    func yield(_ state: Dev3TerminalConnectionState) {
        continuation.yield(state)
    }
}

actor TerminalLifecycleDetachGate {
    private var isOpen = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func open() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}
