import Dev3Kit
import Dev3TerminalKit
import Foundation
import Observation

// swiftlint:disable file_length

enum TerminalTaskPhase: Equatable, Sendable {
    case idle
    case connecting
    case connected
    case reconnecting(attempt: Int, delay: Duration)
    case needsResume
    case failed(String)
    case disconnected
}

enum TerminalSharedSizeNotice {
    static let message = "Terminal dimensions are shared across connected viewers."
    static let leaveHint = "Detaches on back"

    static func isVisible(phase: TerminalTaskPhase, usesSharedTerminalDimensions: Bool) -> Bool {
        phase == .connected && usesSharedTerminalDimensions
    }
}

struct TerminalPagerState: Equatable, Sendable {
    var total = 0
    var activeIndex = 0
    var labels: [String] = []

    var boundedActiveIndex: Int {
        guard total != 0 else { return 0 }
        return min(max(activeIndex, 0), total - 1)
    }

    func label(at index: Int, fallback: String) -> String {
        guard labels.indices.contains(index) else { return fallback }
        let candidate = labels[index].trimmingCharacters(in: .whitespacesAndNewlines)
        return candidate.isEmpty ? fallback : candidate
    }
}

@MainActor
@Observable
final class TerminalTaskStore {
    let service: any TerminalTaskServicing

    var phase = TerminalTaskPhase.idle
    var inputMode = Dev3TerminalInputMode.compose
    var draft: String {
        didSet { UserDefaults.standard.set(draft, forKey: draftKey) }
    }

    var isComposerExpanded = false
    var isControlLatched = false
    var windows = TerminalPagerState()
    var panes = TerminalPagerState()
    var isPaneSheetPresented = false
    var confirmsLastPaneClose = false
    var isBusy = false
    var transientError: String?

    private let draftKey: String
    private var attachTask: Task<Void, Never>?
    private var detachTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var navigationTask: Task<Void, Never>?
    private var navigationRefresh = Dev3TerminalNavigationRefresh()
    private(set) var terminalRefreshRevision: UInt64 = 0
    private var isAttached = false
    private var isAttachmentDesired = false
    private var isSceneActive = false
    private var networkRecoveryRevision: UInt64 = 0
    private var lifecycleGeneration: UInt64 = 0

    init(service: any TerminalTaskServicing) {
        self.service = service
        draftKey = "dev3.terminal.draft.\(service.serverID).\(service.taskID)"
        draft = UserDefaults.standard.string(forKey: draftKey) ?? ""
    }

    isolated deinit {
        attachTask?.cancel()
        recoveryTask?.cancel()
        stateTask?.cancel()
        pollTask?.cancel()
        navigationTask?.cancel()
    }

    var endpoint: Dev3TerminalEndpoint {
        service.endpoint
    }

    var showsSharedTerminalSizeNotice: Bool {
        TerminalSharedSizeNotice.isVisible(
            phase: phase,
            usesSharedTerminalDimensions: service.usesSharedTerminalDimensions
        )
    }

    func resume() {
        runRecovery { [service] in try await service.resume() }
    }

    func restart() {
        runRecovery { [service] in try await service.restart() }
    }

    func refreshNavigation() async {
        do {
            let window = try await service.windowNavigation(step: nil, index: nil)
            apply(window)
        } catch {
            transientError = error.localizedDescription
        }
        do {
            let pane = try await service.paneNavigation(step: nil, index: nil, zoom: true)
            apply(pane)
        } catch {
            transientError = error.localizedDescription
        }
    }

    func performPaneAction(_ action: TerminalPaneAction) {
        DiagnosticsLog.shared.record(
            category: "terminal",
            "pane action request action=\(action.rawValue)"
        )
        isPaneSheetPresented = false
        let previousNavigation = navigationTask
        let generation = lifecycleGeneration
        navigationTask = Task { [weak self] in
            await previousNavigation?.value
            guard let self, ownsLifecycle(generation) else { return }
            do {
                if action == .closePane, try await service.paneCount() <= 1 {
                    confirmsLastPaneClose = true
                } else {
                    try await runPaneAction(action, force: false)
                }
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func closeLastPane() {
        let previousNavigation = navigationTask
        let generation = lifecycleGeneration
        navigationTask = Task { [weak self] in
            await previousNavigation?.value
            guard let self, ownsLifecycle(generation) else { return }
            do {
                try await runPaneAction(.closePane, force: true)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func submitDraft() {
        guard !draft.isEmpty, !isBusy else { return }
        let text = draft
        isBusy = true
        Task { [weak self] in
            guard let self else { return }
            let outcome = await service.submit(text)
            switch outcome {
            case .submittedImmediately, .submittedAfterSettle:
                draft = ""
            case .pasteFailed:
                transientError = "The text could not be pasted into the terminal."
            case .settleCancelled:
                break
            case .submitFailed:
                transientError = "The terminal did not accept the submit key."
            }
            isBusy = false
        }
    }

    func insertDraft() {
        guard !draft.isEmpty, !isBusy else { return }
        let text = draft
        isBusy = true
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.insert(text)
                draft = ""
            } catch {
                transientError = error.localizedDescription
            }
            isBusy = false
        }
    }

    @discardableResult
    func sendAccessory(_ key: Dev3TerminalAccessoryKey) -> Bool {
        if key == .control {
            isControlLatched.toggle()
            return false
        }
        if Dev3TerminalAccessoryRouting.usesTerminalTextInput(
            key: key,
            inputMode: inputMode
        ) {
            isControlLatched = false
            return true
        }
        guard let bytes = key.bytes(control: isControlLatched) else { return false }
        isControlLatched = false
        send(bytes)
        return false
    }

    func pasteClipboard(_ text: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.insert(text)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func report(_ message: String) {
        transientError = message
    }

    private func observeConnectionStates() {
        guard stateTask == nil else { return }
        stateTask = Task { [weak self, endpoint] in
            for await state in endpoint.connectionStates {
                guard !Task.isCancelled else { break }
                self?.apply(state)
            }
        }
    }

    private func apply(_ state: Dev3TerminalConnectionState) {
        switch state {
        case .disconnected:
            phase = .disconnected
        case .connecting:
            phase = .connecting
        case .connected:
            phase = .connected
        case let .reconnecting(attempt, delay):
            phase = .reconnecting(attempt: attempt, delay: delay)
        case .needsResume:
            phase = .needsResume
        case let .failed(message):
            phase = .failed(message)
        }
    }

    private func apply(_ navigation: Dev3TmuxWindowNavigation) {
        windows = TerminalPagerState(
            total: navigation.count,
            activeIndex: navigation.activeIndex,
            labels: navigation.labels
        )
    }

    private func apply(_ navigation: Dev3TmuxPaneNavigation) {
        panes = TerminalPagerState(
            total: navigation.count,
            activeIndex: navigation.activeIndex,
            labels: navigation.labels
        )
    }

    private func beginPollingNavigation() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { break }
                await self?.refreshNavigation()
            }
        }
    }

    private func runRecovery(_ operation: @escaping @Sendable () async throws -> Void) {
        guard isAttachmentDesired, !isBusy else { return }
        let generation = lifecycleGeneration
        isBusy = true
        phase = .connecting
        recoveryTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await operation()
                guard ownsLifecycle(generation) else { return }
                await refreshNavigation()
                guard ownsLifecycle(generation) else { return }
                beginPollingNavigation()
            } catch {
                guard ownsLifecycle(generation) else { return }
                phase = .failed(error.localizedDescription)
            }
            if ownsLifecycle(generation) {
                isBusy = false
                recoveryTask = nil
            }
        }
    }

    private func ownsLifecycle(_ generation: UInt64) -> Bool {
        !Task.isCancelled
            && lifecycleGeneration == generation
            && isAttachmentDesired
    }

    private func send(_ data: Data) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.send(data)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }
}

extension TerminalTaskStore {
    func navigateWindow(step: TerminalPagerStep? = nil, index: Int? = nil) {
        DiagnosticsLog.shared.record(
            category: "terminal",
            "window switch request target=\(navigationTarget(step: step, index: index))"
        )
        let previousNavigation = navigationTask
        let generation = lifecycleGeneration
        navigationTask = Task { [weak self] in
            await previousNavigation?.value
            guard let self, ownsLifecycle(generation) else { return }
            do {
                try await apply(service.windowNavigation(step: step, index: index))
                guard ownsLifecycle(generation) else { return }
                try await apply(service.paneNavigation(step: nil, index: nil, zoom: true))
                guard ownsLifecycle(generation) else { return }
                refreshTerminalAfterNavigation(.windowSelection)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func navigatePane(step: TerminalPagerStep? = nil, index: Int? = nil) {
        DiagnosticsLog.shared.record(
            category: "terminal",
            "pane switch request target=\(navigationTarget(step: step, index: index))"
        )
        let previousNavigation = navigationTask
        let generation = lifecycleGeneration
        navigationTask = Task { [weak self] in
            await previousNavigation?.value
            guard let self, ownsLifecycle(generation) else { return }
            do {
                try await apply(service.paneNavigation(step: step, index: index, zoom: true))
                guard ownsLifecycle(generation) else { return }
                refreshTerminalAfterNavigation(.paneSelection)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func handlePaneSwipe(horizontal: Double, vertical: Double) {
        switch Dev3TerminalPaneSwipeDecision.decide(
            horizontal: horizontal,
            vertical: vertical,
            paneCount: panes.total
        ) {
        case .previous:
            navigatePane(step: .previous)
        case .next:
            navigatePane(step: .next)
        case .ignore:
            break
        }
    }

    private func refreshTerminalAfterNavigation(_ intent: Dev3TerminalNavigationIntent) {
        guard let revision = navigationRefresh.record(intent) else { return }
        terminalRefreshRevision = revision
    }

    private func navigationTarget(step: TerminalPagerStep?, index: Int?) -> String {
        if let index {
            return "index:\(index)"
        }
        switch step {
        case .next:
            return "next"
        case .previous:
            return "previous"
        case nil:
            return "current"
        }
    }

    private func runPaneAction(_ action: TerminalPaneAction, force: Bool) async throws {
        do {
            try await service.perform(action, force: force)
            try await apply(service.paneNavigation(step: nil, index: nil, zoom: true))
            if action == .newWindow {
                try await apply(service.windowNavigation(step: nil, index: nil))
            }
            if action != .closePane {
                refreshTerminalAfterNavigation(.paneSelection)
            }
        } catch {
            transientError = error.localizedDescription
            throw error
        }
    }
}

extension TerminalTaskStore {
    func attach(isSceneActive: Bool, networkRecoveryRevision: UInt64) {
        guard !isAttachmentDesired else { return }
        isAttachmentDesired = true
        self.isSceneActive = isSceneActive
        self.networkRecoveryRevision = networkRecoveryRevision
        lifecycleGeneration &+= 1
        let generation = lifecycleGeneration
        let pendingDetach = detachTask
        phase = .connecting
        observeConnectionStates()
        attachTask = Task { [weak self] in
            guard let self else { return }
            await pendingDetach?.value
            guard !Task.isCancelled,
                  lifecycleGeneration == generation,
                  isAttachmentDesired
            else { return }
            detachTask = nil
            do {
                try await service.setTerminalActive(self.isSceneActive)
                try await service.attach()
                guard !Task.isCancelled,
                      lifecycleGeneration == generation,
                      isAttachmentDesired
                else { return }
                isAttached = true
                await refreshNavigation()
                guard !Task.isCancelled,
                      lifecycleGeneration == generation,
                      isAttachmentDesired
                else { return }
                beginPollingNavigation()
            } catch {
                guard !Task.isCancelled,
                      lifecycleGeneration == generation,
                      isAttachmentDesired
                else { return }
                phase = .failed(error.localizedDescription)
            }
            if lifecycleGeneration == generation {
                attachTask = nil
            }
        }
    }

    func sceneChanged(isActive: Bool) {
        let shouldRecover = isAttached && !isSceneActive && isActive
        isSceneActive = isActive
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.setTerminalActive(isActive)
            } catch {
                transientError = error.localizedDescription
            }
            guard shouldRecover, isAttached, isSceneActive else { return }
            await service.kick()
        }
    }

    func networkBecameReachable(revision: UInt64) {
        guard revision != networkRecoveryRevision else { return }
        networkRecoveryRevision = revision
        guard isAttached, isSceneActive else { return }
        Task { [weak self] in
            guard let self, isAttached, isSceneActive else { return }
            await service.kick()
        }
    }

    func detach() {
        guard isAttachmentDesired else { return }
        isAttachmentDesired = false
        lifecycleGeneration &+= 1
        let generation = lifecycleGeneration
        isAttached = false
        let pendingAttach = attachTask
        let pendingDetach = detachTask
        let pendingRecovery = recoveryTask
        pendingAttach?.cancel()
        pendingRecovery?.cancel()
        pollTask?.cancel()
        navigationTask?.cancel()
        attachTask = nil
        recoveryTask = nil
        pollTask = nil
        navigationTask = nil
        isBusy = false
        detachTask = Task { [weak self, service] in
            await pendingAttach?.value
            await pendingRecovery?.value
            await pendingDetach?.value
            await service.detach()
            guard let self, lifecycleGeneration == generation else { return }
            detachTask = nil
            phase = .disconnected
        }
    }
}

// swiftlint:enable file_length
