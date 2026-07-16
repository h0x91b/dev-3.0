import Dev3Kit
import Dev3TerminalKit
import Foundation
import Observation

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
    private var stateTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(service: any TerminalTaskServicing) {
        self.service = service
        draftKey = "dev3.terminal.draft.\(service.serverID).\(service.taskID)"
        draft = UserDefaults.standard.string(forKey: draftKey) ?? ""
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

    func attach(isSceneActive: Bool) {
        guard attachTask == nil else { return }
        phase = .connecting
        observeConnectionStates()
        attachTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await service.setTerminalActive(isSceneActive)
                try await service.attach()
                await refreshNavigation()
                beginPollingNavigation()
            } catch {
                phase = .failed(error.localizedDescription)
            }
            attachTask = nil
        }
    }

    func setTerminalActive(_ active: Bool) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await service.setTerminalActive(active)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func detach() async {
        attachTask?.cancel()
        stateTask?.cancel()
        pollTask?.cancel()
        attachTask = nil
        stateTask = nil
        pollTask = nil
        await service.detach()
        phase = .disconnected
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

    func navigateWindow(step: TerminalPagerStep? = nil, index: Int? = nil) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await apply(service.windowNavigation(step: step, index: index))
                try await apply(service.paneNavigation(step: nil, index: nil, zoom: true))
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func navigatePane(step: TerminalPagerStep? = nil, index: Int? = nil) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await apply(service.paneNavigation(step: step, index: index, zoom: true))
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

    func performPaneAction(_ action: TerminalPaneAction) {
        isPaneSheetPresented = false
        if action == .closePane {
            Task { [weak self] in
                guard let self else { return }
                do {
                    if try await service.paneCount() <= 1 {
                        confirmsLastPaneClose = true
                    } else {
                        try await runPaneAction(action, force: false)
                    }
                } catch {
                    transientError = error.localizedDescription
                }
            }
            return
        }
        Task { [weak self] in
            try await self?.runPaneAction(action, force: false)
        }
    }

    func closeLastPane() {
        Task { [weak self] in
            try await self?.runPaneAction(.closePane, force: true)
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

    func sendAccessory(_ key: Dev3TerminalAccessoryKey) {
        if key == .control {
            isControlLatched.toggle()
            return
        }
        guard let bytes = key.bytes(control: isControlLatched) else { return }
        isControlLatched = false
        send(bytes)
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
        stateTask?.cancel()
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
        guard !isBusy else { return }
        isBusy = true
        phase = .connecting
        Task { [weak self] in
            guard let self else { return }
            do {
                try await operation()
                await refreshNavigation()
                beginPollingNavigation()
            } catch {
                phase = .failed(error.localizedDescription)
            }
            isBusy = false
        }
    }

    private func runPaneAction(_ action: TerminalPaneAction, force: Bool) async throws {
        do {
            try await service.perform(action, force: force)
            try await apply(service.paneNavigation(step: nil, index: nil, zoom: true))
            if action == .newWindow {
                try await apply(service.windowNavigation(step: nil, index: nil))
            }
        } catch {
            transientError = error.localizedDescription
            throw error
        }
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
