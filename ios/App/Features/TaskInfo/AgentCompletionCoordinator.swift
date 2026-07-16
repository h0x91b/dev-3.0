import Dev3Kit
import Dev3UI
import Foundation
import Observation

private enum AgentCompletionResponseState {
    case ready
    case sending(attemptID: UUID, providerGeneration: UInt)
    case failed(message: String, providerGeneration: UInt)
}

private struct AgentCompletionResponseIntent: Identifiable {
    let id: String
    let approved: Bool
    var state: AgentCompletionResponseState
}

@MainActor
@Observable
final class AgentCompletionCoordinator {
    typealias RouteRemoval = @MainActor (String) -> Void

    private(set) var currentConfirmation: TaskInfoConfirmation?
    private(set) var pendingPromptCount = 0
    private(set) var pendingResponseCount = 0
    private(set) var isResponding = false
    private(set) var lastResponseError: String?

    @ObservationIgnored private var promptQueue: [AgentCompletionRequestedPush] = []
    @ObservationIgnored private var responseQueue: [AgentCompletionResponseIntent] = []
    @ObservationIgnored private var knownRequestIDs = Set<String>()
    @ObservationIgnored private var providerGeneration: UInt = 0
    @ObservationIgnored private var serviceProvider: any AgentCompletionServiceProviding
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private let removeRoute: RouteRemoval

    init(
        serviceProvider: any AgentCompletionServiceProviding,
        removeRoute: @escaping RouteRemoval
    ) {
        self.serviceProvider = serviceProvider
        self.removeRoute = removeRoute
    }

    var currentRequestID: String? {
        promptQueue.first?.requestId
    }

    var hasFailedResponses: Bool {
        responseQueue.contains { intent in
            if case .failed = intent.state {
                return true
            }
            return false
        }
    }

    func receive(_ event: RPCPushEvent) {
        guard case let .agentCompletionRequested(request) = event else { return }
        receive(request)
    }

    func receive(_ request: AgentCompletionRequestedPush) {
        guard knownRequestIDs.insert(request.requestId).inserted else { return }
        if stopped {
            enqueueResponse(requestID: request.requestId, approved: false)
        } else {
            promptQueue.append(request)
            refreshPresentation()
        }
        startDrainIfNeeded()
    }

    func approve(requestID: String) {
        resolvePresentedRequest(requestID: requestID, approved: true)
    }

    func decline(requestID: String) {
        resolvePresentedRequest(requestID: requestID, approved: false)
    }

    func dismiss(requestID: String) {
        resolvePresentedRequest(requestID: requestID, approved: false)
    }

    func retryFailedResponses() {
        prepareFailedResponsesForRetry()
        startDrainIfNeeded()
    }

    func rebindServiceProvider(_ serviceProvider: any AgentCompletionServiceProviding) {
        providerGeneration &+= 1
        self.serviceProvider = serviceProvider
        declineAllPresentedRequests()
        prepareFailedResponsesForRetry()
        startDrainIfNeeded()
    }

    func stop() async {
        stopped = true
        declineAllPresentedRequests()
        prepareFailedResponsesForRetry()
        startDrainIfNeeded()
        while let drainTask {
            await drainTask.value
        }
    }
}

private extension AgentCompletionCoordinator {
    func resolvePresentedRequest(requestID: String, approved: Bool) {
        guard let request = promptQueue.first, request.requestId == requestID else { return }
        promptQueue.removeFirst()
        if approved {
            removeRoute(request.taskId)
        }
        enqueueResponse(requestID: request.requestId, approved: approved)
        refreshPresentation()
        startDrainIfNeeded()
    }

    func declineAllPresentedRequests() {
        for request in promptQueue {
            enqueueResponse(requestID: request.requestId, approved: false)
        }
        promptQueue.removeAll()
        refreshPresentation()
    }

    func enqueueResponse(requestID: String, approved: Bool) {
        guard !responseQueue.contains(where: { $0.id == requestID }) else { return }
        responseQueue.append(
            AgentCompletionResponseIntent(id: requestID, approved: approved, state: .ready)
        )
        refreshResponseState()
    }

    func prepareFailedResponsesForRetry() {
        for index in responseQueue.indices {
            guard case .failed = responseQueue[index].state else { continue }
            responseQueue[index].state = .ready
        }
        lastResponseError = nil
        refreshResponseState()
    }

    func refreshPresentation() {
        currentConfirmation = promptQueue.first.map {
            TaskInfoCompletionPolicy.agentCompletionConfirmation(request: $0)
        }
        pendingPromptCount = promptQueue.count
    }

    func refreshResponseState() {
        pendingResponseCount = responseQueue.count
        isResponding = responseQueue.contains { intent in
            if case .sending = intent.state {
                return true
            }
            return false
        }
        lastResponseError = responseQueue.lazy.compactMap { intent in
            guard case let .failed(message, _) = intent.state else { return nil }
            return message
        }.first
    }

    func startDrainIfNeeded() {
        guard drainTask == nil, responseQueue.contains(where: { intent in
            if case .ready = intent.state {
                return true
            }
            return false
        }) else { return }

        drainTask = Task { [weak self] in
            await self?.drainResponses()
        }
    }

    func drainResponses() async {
        defer {
            drainTask = nil
            refreshResponseState()
        }

        while let index = responseQueue.firstIndex(where: { intent in
            if case .ready = intent.state {
                return true
            }
            return false
        }) {
            let service = serviceProvider.service()
            let attemptID = UUID()
            let attemptGeneration = providerGeneration
            let requestID = responseQueue[index].id
            let approved = responseQueue[index].approved
            responseQueue[index].state = .sending(
                attemptID: attemptID,
                providerGeneration: attemptGeneration
            )
            refreshResponseState()

            do {
                try await service.respond(requestID: requestID, approved: approved)
                guard let currentIndex = matchingResponseIndex(
                    requestID: requestID,
                    attemptID: attemptID,
                    providerGeneration: attemptGeneration
                ) else { continue }
                responseQueue.remove(at: currentIndex)
            } catch {
                guard let currentIndex = matchingResponseIndex(
                    requestID: requestID,
                    attemptID: attemptID,
                    providerGeneration: attemptGeneration
                ) else { continue }
                if providerGeneration != attemptGeneration {
                    responseQueue[currentIndex].state = .ready
                    continue
                }
                let message = error.localizedDescription
                responseQueue[currentIndex].state = .failed(
                    message: message,
                    providerGeneration: attemptGeneration
                )
                refreshResponseState()
                break
            }
            refreshResponseState()
        }
    }

    func matchingResponseIndex(
        requestID: String,
        attemptID: UUID,
        providerGeneration: UInt
    ) -> Int? {
        responseQueue.firstIndex { intent in
            guard intent.id == requestID else { return false }
            guard case let .sending(currentAttemptID, currentGeneration) = intent.state else {
                return false
            }
            return currentAttemptID == attemptID && currentGeneration == providerGeneration
        }
    }
}
