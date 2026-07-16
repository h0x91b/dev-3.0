@testable import dev3
import Dev3Kit
import Dev3UI
import Foundation
import Testing

@MainActor
@Suite("Agent completion coordinator", .serialized)
struct AgentCompletionCoordinatorTests {
    @Test("Queued requests present in order and every user callback resolves exactly once")
    func queuedRequestsAndUserCallbacks() async throws {
        let events = LockedCompletionEvents()
        let service = RecordingCompletionService(events: events)
        let coordinator = makeCoordinator(service: service, events: events)
        let first = try request(id: "request-a", taskID: "task-a", title: "First")
        let second = try request(id: "request-b", taskID: "task-b", title: "Second")

        coordinator.receive(.agentCompletionRequested(first))
        coordinator.receive(.agentCompletionRequested(second))
        coordinator.receive(.agentCompletionRequested(first))

        #expect(coordinator.pendingPromptCount == 2)
        #expect(
            coordinator.currentConfirmation ==
                TaskInfoCompletionPolicy.agentCompletionConfirmation(request: first)
        )

        coordinator.approve(requestID: first.requestId)
        #expect(coordinator.currentRequestID == second.requestId)
        coordinator.dismiss(requestID: first.requestId)
        coordinator.decline(requestID: second.requestId)
        coordinator.approve(requestID: second.requestId)

        await eventually("Both decisions should reach the service") {
            await service.calls.count == 2 && coordinator.pendingResponseCount == 0
        }

        #expect(
            await service.calls == [
                CompletionCall(requestID: first.requestId, approved: true),
                CompletionCall(requestID: second.requestId, approved: false)
            ]
        )
        #expect(events.values.first == "route:task-a")
        #expect(events.values.filter { $0 == "route:task-a" }.count == 1)
        #expect(coordinator.currentConfirmation == nil)
        #expect(coordinator.pendingPromptCount == 0)
    }

    @Test("Interactive dismissal, stop, and pushes after stop decline every request")
    func dismissalAndStop() async throws {
        let service = RecordingCompletionService()
        let coordinator = makeCoordinator(service: service)
        let first = try request(id: "request-a", taskID: "task-a")
        let second = try request(id: "request-b", taskID: "task-b")
        let third = try request(id: "request-c", taskID: "task-c")

        coordinator.receive(first)
        coordinator.receive(second)
        coordinator.dismiss(requestID: first.requestId)
        await coordinator.stop()
        coordinator.receive(third)

        await eventually("All stopped requests should be declined") {
            await service.calls.count == 3 && coordinator.pendingResponseCount == 0
        }
        #expect(
            await service.calls == [
                CompletionCall(requestID: first.requestId, approved: false),
                CompletionCall(requestID: second.requestId, approved: false),
                CompletionCall(requestID: third.requestId, approved: false)
            ]
        )
        #expect(coordinator.currentConfirmation == nil)
    }

    @Test("RPC replacement declines retained prompts through only the rebound client")
    func replacementDeclinesPrompts() async throws {
        let oldService = RecordingCompletionService()
        let newService = RecordingCompletionService()
        let coordinator = makeCoordinator(service: oldService)
        let first = try request(id: "request-a", taskID: "task-a")
        let second = try request(id: "request-b", taskID: "task-b")

        coordinator.receive(first)
        coordinator.receive(second)
        coordinator.rebindServiceProvider(TestCompletionProvider(service: newService))

        await eventually("The rebound client should decline the retained queue") {
            await newService.calls.count == 2 && coordinator.pendingResponseCount == 0
        }
        #expect(await oldService.calls.isEmpty)
        #expect(
            await newService.calls == [
                CompletionCall(requestID: first.requestId, approved: false),
                CompletionCall(requestID: second.requestId, approved: false)
            ]
        )

        coordinator.receive(first)
        coordinator.rebindServiceProvider(TestCompletionProvider(service: oldService))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await oldService.calls.isEmpty)
        #expect(await newService.calls.count == 2)
    }

    @Test("A failed approval retries through a rebound client without repeating route removal")
    func failedApprovalRetriesAfterRebind() async throws {
        let events = LockedCompletionEvents()
        let oldService = RecordingCompletionService(failuresRemaining: 1, events: events)
        let newService = RecordingCompletionService(events: events)
        let coordinator = makeCoordinator(service: oldService, events: events)
        let completion = try request(id: "request-a", taskID: "task-a")

        coordinator.receive(completion)
        coordinator.approve(requestID: completion.requestId)
        await eventually("The failed response should remain in the outbox") {
            coordinator.hasFailedResponses && coordinator.pendingResponseCount == 1
        }

        coordinator.dismiss(requestID: completion.requestId)
        coordinator.rebindServiceProvider(TestCompletionProvider(service: newService))
        await eventually("The rebound client should settle the original approval") {
            await newService.calls.count == 1 && coordinator.pendingResponseCount == 0
        }

        #expect(
            await oldService.calls == [CompletionCall(requestID: completion.requestId, approved: true)]
        )
        #expect(
            await newService.calls == [CompletionCall(requestID: completion.requestId, approved: true)]
        )
        #expect(events.values.filter { $0 == "route:task-a" }.count == 1)
        #expect(coordinator.lastResponseError == nil)

        coordinator.retryFailedResponses()
        coordinator.rebindServiceProvider(TestCompletionProvider(service: oldService))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await oldService.calls.count == 1)
        #expect(await newService.calls.count == 1)
    }

    @Test("Replacement during an old attempt retries safely and rejects the newer prompt")
    func replacementDuringInflightResponse() async throws {
        let oldService = SuspendedCompletionService()
        let newService = RecordingCompletionService()
        let coordinator = makeCoordinator(service: oldService)
        let first = try request(id: "request-a", taskID: "task-a")
        let second = try request(id: "request-b", taskID: "task-b")

        coordinator.receive(first)
        coordinator.receive(second)
        coordinator.approve(requestID: first.requestId)
        await eventually("The old response should be in flight") {
            await oldService.calls.count == 1
        }

        coordinator.rebindServiceProvider(TestCompletionProvider(service: newService))
        await oldService.fail()
        await eventually("The new client should settle both preserved intents") {
            await newService.calls.count == 2 && coordinator.pendingResponseCount == 0
        }

        #expect(
            await newService.calls == [
                CompletionCall(requestID: first.requestId, approved: true),
                CompletionCall(requestID: second.requestId, approved: false)
            ]
        )
        coordinator.decline(requestID: second.requestId)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await newService.calls.count == 2)
    }

    @Test("A response that fails during stop remains durable until a new client binds")
    func stopFailureSurvivesForRebind() async throws {
        let failingService = RecordingCompletionService(failuresRemaining: 1)
        let reboundService = RecordingCompletionService()
        let coordinator = makeCoordinator(service: failingService)
        let completion = try request(id: "request-a", taskID: "task-a")

        coordinator.receive(completion)
        await coordinator.stop()

        #expect(coordinator.hasFailedResponses)
        #expect(coordinator.pendingResponseCount == 1)
        coordinator.rebindServiceProvider(TestCompletionProvider(service: reboundService))
        await eventually("A rebound client should finish the stopped coordinator outbox") {
            await reboundService.calls.count == 1 && coordinator.pendingResponseCount == 0
        }
        #expect(
            await reboundService.calls == [
                CompletionCall(requestID: completion.requestId, approved: false)
            ]
        )
    }

    private func makeCoordinator(
        service: some AgentCompletionServicing,
        events: LockedCompletionEvents = LockedCompletionEvents()
    ) -> AgentCompletionCoordinator {
        AgentCompletionCoordinator(
            serviceProvider: TestCompletionProvider(service: service),
            removeRoute: { events.append("route:\($0)") }
        )
    }

    private func request(
        id: String,
        taskID: String,
        title: String = "Task"
    ) throws -> AgentCompletionRequestedPush {
        let json = #"""
        {
          "requestId":"\#(id)","taskId":"\#(taskID)","projectId":"project",
          "taskTitle":"\#(title)","taskOverview":"Done and verified"
        }
        """#
        return try JSONDecoder().decode(
            AgentCompletionRequestedPush.self,
            from: Data(json.utf8)
        )
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

private struct CompletionCall: Equatable, Sendable {
    let requestID: String
    let approved: Bool
}

private struct TestCompletionProvider<Service: AgentCompletionServicing>: AgentCompletionServiceProviding {
    let serviceValue: Service

    init(service: Service) {
        serviceValue = service
    }

    func service() -> any AgentCompletionServicing {
        serviceValue
    }
}

private actor RecordingCompletionService: AgentCompletionServicing {
    private(set) var calls: [CompletionCall] = []
    private var failuresRemaining: Int
    private let events: LockedCompletionEvents?

    init(
        failuresRemaining: Int = 0,
        events: LockedCompletionEvents? = nil
    ) {
        self.failuresRemaining = failuresRemaining
        self.events = events
    }

    func respond(requestID: String, approved: Bool) async throws {
        let call = CompletionCall(requestID: requestID, approved: approved)
        calls.append(call)
        events?.append("response:\(requestID):\(approved)")
        if failuresRemaining > 0 {
            failuresRemaining -= 1
            throw CompletionTestError.unavailable
        }
    }
}

private actor SuspendedCompletionService: AgentCompletionServicing {
    private(set) var calls: [CompletionCall] = []
    private var continuation: CheckedContinuation<Void, any Error>?

    func respond(requestID: String, approved: Bool) async throws {
        calls.append(CompletionCall(requestID: requestID, approved: approved))
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func fail() {
        continuation?.resume(throwing: CompletionTestError.unavailable)
        continuation = nil
    }
}

private final class LockedCompletionEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] {
        lock.withLock { storage }
    }

    func append(_ value: String) {
        lock.withLock {
            storage.append(value)
        }
    }
}

private enum CompletionTestError: Error {
    case unavailable
}
