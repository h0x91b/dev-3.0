import Dev3Kit
import Dev3TerminalKit
import Foundation

enum CompanionConnectionLeaseError: LocalizedError, Equatable, Sendable {
    case replaced

    var errorDescription: String? {
        "The dev3 connection was replaced. Reopen this task and try again."
    }
}

struct CompanionConnectionLeaseGate: Sendable {
    private let connectionIsCurrent: @MainActor @Sendable () -> Bool

    init(connectionIsCurrent: @escaping @MainActor @Sendable () -> Bool) {
        self.connectionIsCurrent = connectionIsCurrent
    }

    func isCurrent() async -> Bool {
        await connectionIsCurrent()
    }

    func requireCurrent() async throws {
        guard await isCurrent() else {
            throw CompanionConnectionLeaseError.replaced
        }
    }

    func perform<Result: Sendable>(
        _ operation: @Sendable () async throws -> Result
    ) async throws -> Result {
        try await requireCurrent()
        let result = try await operation()
        try await requireCurrent()
        return result
    }
}

enum CompanionTerminalConnectionIO {
    static func interaction(
        connectionGate: CompanionConnectionLeaseGate,
        sendData: @escaping @Sendable (Data) async throws -> Void
    ) -> Dev3TerminalInteraction {
        Dev3TerminalInteraction { data in
            try await connectionGate.perform {
                try await sendData(data)
            }
        }
    }
}

actor CompanionTerminalConnectionLifecycle {
    private let focusLifecycle: Dev3TerminalFocusLifecycle
    private let disconnectPTY: @Sendable () async -> Void

    init(
        connectionGate: CompanionConnectionLeaseGate,
        setTerminalFocus: @escaping @Sendable (Bool) async throws -> Void,
        disconnectPTY: @escaping @Sendable () async -> Void
    ) {
        focusLifecycle = Dev3TerminalFocusLifecycle { active in
            guard await connectionGate.isCurrent() else { return }
            try await setTerminalFocus(active)
        }
        self.disconnectPTY = disconnectPTY
    }

    func connected() async throws {
        try await focusLifecycle.connected()
    }

    func setActive(_ active: Bool) async throws {
        try await focusLifecycle.setActive(active)
    }

    func disconnecting() async {
        await focusLifecycle.disconnecting()
        await disconnectPTY()
    }

    func forceDisconnectPTY() async {
        await disconnectPTY()
    }
}

enum TerminalPagerStep: Sendable {
    case next
    case previous

    var navigationStep: Dev3NavigationStep {
        switch self {
        case .next:
            .next
        case .previous:
            .previous
        }
    }
}

enum TerminalPaneAction: String, CaseIterable, Identifiable, Sendable {
    case splitHorizontal
    case splitVertical
    case newWindow
    case closePane

    var id: String {
        rawValue
    }

    var tmuxAction: Dev3TmuxAction {
        switch self {
        case .splitHorizontal:
            .splitH
        case .splitVertical:
            .splitV
        case .newWindow:
            .newWindow
        case .closePane:
            .killPane
        }
    }
}

protocol TerminalTaskServicing: Sendable {
    var taskID: String { get }
    var serverID: String { get }
    var endpoint: Dev3TerminalEndpoint { get }
    var terminalInteraction: Dev3TerminalInteraction { get }
    var usesSharedTerminalDimensions: Bool { get }

    func attach() async throws
    func detach() async
    func kick() async
    func setTerminalActive(_ active: Bool) async throws
    func resume() async throws
    func restart() async throws

    func windowNavigation(step: TerminalPagerStep?, index: Int?) async throws -> Dev3TmuxWindowNavigation
    func paneNavigation(
        step: TerminalPagerStep?,
        index: Int?,
        zoom: Bool
    ) async throws -> Dev3TmuxPaneNavigation
    func paneCount() async throws -> Int
    func perform(_ action: TerminalPaneAction, force: Bool) async throws

    func submit(_ text: String) async -> Dev3TerminalSubmitOutcome
    func insert(_ text: String) async throws
    func send(_ data: Data) async throws
    func resize(columns: Int, rows: Int) async throws
}

actor RPCTerminalTaskService: TerminalTaskServicing {
    nonisolated let taskID: String
    nonisolated let serverID: String
    nonisolated let endpoint: Dev3TerminalEndpoint
    nonisolated let terminalInteraction: Dev3TerminalInteraction
    nonisolated let usesSharedTerminalDimensions: Bool

    private let rpcClient: RPCClient
    private let ptyClient: PTYClient
    private let connectionGate: CompanionConnectionLeaseGate
    private let connectionLifecycle: CompanionTerminalConnectionLifecycle

    init(
        taskID: String,
        serverID: String,
        rpcClient: RPCClient,
        ptyClient: PTYClient,
        clipboardText: AsyncStream<String>,
        connectionIsCurrent: @escaping @MainActor @Sendable () -> Bool = { true },
        setTerminalFocus: (@Sendable (Bool) async throws -> Void)? = nil,
        usesSharedTerminalDimensions: Bool = true
    ) {
        self.taskID = taskID
        self.serverID = serverID
        self.rpcClient = rpcClient
        self.ptyClient = ptyClient
        self.usesSharedTerminalDimensions = usesSharedTerminalDimensions
        let connectionGate = CompanionConnectionLeaseGate(
            connectionIsCurrent: connectionIsCurrent
        )
        self.connectionGate = connectionGate
        let terminalEndpoint = Dev3TerminalEndpoint(
            identity: "task:\(taskID)",
            ptyClient: ptyClient,
            clipboardText: clipboardText
        )
        endpoint = terminalEndpoint
        terminalInteraction = CompanionTerminalConnectionIO.interaction(
            connectionGate: connectionGate,
            sendData: { data in try await terminalEndpoint.send(data) }
        )
        connectionLifecycle = CompanionTerminalConnectionLifecycle(
            connectionGate: connectionGate,
            setTerminalFocus: setTerminalFocus ?? { active in
                try await rpcClient.setTerminalFocus(active)
            },
            disconnectPTY: { await ptyClient.disconnect() }
        )
    }

    func attach() async throws {
        try await connectionGate.requireCurrent()
        let resolution = try await rpcClient.getPtyUrl(taskId: taskID)
        try await connectionGate.requireCurrent()
        try await ptyClient.connect(to: .task(taskID), resolution: resolution)
        try await acquireFocusOrDisconnect()
    }

    func detach() async {
        await connectionLifecycle.disconnecting()
    }

    func kick() async {
        guard await connectionGate.isCurrent() else { return }
        await ptyClient.kick()
    }

    func setTerminalActive(_ active: Bool) async throws {
        try await connectionGate.requireCurrent()
        try await connectionLifecycle.setActive(active)
    }

    func resume() async throws {
        try await connectionGate.requireCurrent()
        _ = try await rpcClient.resumeTask(taskId: taskID)
        try await connectionGate.requireCurrent()
        try await ptyClient.connect(to: .task(taskID))
        try await acquireFocusOrDisconnect()
    }

    func restart() async throws {
        try await connectionGate.requireCurrent()
        _ = try await rpcClient.restartTask(taskId: taskID)
        try await connectionGate.requireCurrent()
        try await ptyClient.connect(to: .task(taskID))
        try await acquireFocusOrDisconnect()
    }

    func windowNavigation(
        step: TerminalPagerStep?,
        index: Int?
    ) async throws -> Dev3TmuxWindowNavigation {
        try await connectionGate.requireCurrent()
        let result = try await rpcClient.tmuxWindowNavigate(
            taskId: taskID,
            step: step?.navigationStep,
            index: index
        )
        try await connectionGate.requireCurrent()
        return result
    }

    func paneNavigation(
        step: TerminalPagerStep?,
        index: Int?,
        zoom: Bool
    ) async throws -> Dev3TmuxPaneNavigation {
        try await connectionGate.requireCurrent()
        let result = try await rpcClient.tmuxPaneNavigate(
            taskId: taskID,
            step: step?.navigationStep,
            index: index,
            zoom: zoom
        )
        try await connectionGate.requireCurrent()
        return result
    }

    func paneCount() async throws -> Int {
        try await connectionGate.requireCurrent()
        let count = try await rpcClient.tmuxPaneCount(taskId: taskID).count
        try await connectionGate.requireCurrent()
        return count
    }

    func perform(_ action: TerminalPaneAction, force: Bool) async throws {
        try await connectionGate.requireCurrent()
        try await rpcClient.tmuxAction(
            taskId: taskID,
            action: action.tmuxAction,
            force: force ? true : nil
        )
        try await connectionGate.requireCurrent()
    }

    func submit(_ text: String) async -> Dev3TerminalSubmitOutcome {
        guard await connectionGate.isCurrent() else { return .settleCancelled }
        return await Dev3TerminalSubmit.pastedText(text, transport: terminalInteraction)
    }

    func insert(_ text: String) async throws {
        try await connectionGate.requireCurrent()
        try await terminalInteraction.paste(text)
    }

    func send(_ data: Data) async throws {
        try await terminalInteraction.sendInput(data)
    }

    func resize(columns: Int, rows: Int) async throws {
        try await connectionGate.perform {
            // Pin the tmux copy-mode scroll position before the resize so a
            // pinch-zoom does not snap the view toward the bottom (issue E).
            // Best-effort: never block the resize on it, and it no-ops
            // server-side when no pane is scrolled back.
            try? await rpcClient.anchorCopyModeScroll(taskId: taskID)
            try await endpoint.resize(columns: columns, rows: rows)
        }
    }

    private func acquireFocusOrDisconnect() async throws {
        do {
            try await connectionGate.requireCurrent()
            try await connectionLifecycle.connected()
        } catch {
            await connectionLifecycle.forceDisconnectPTY()
            throw error
        }
    }
}
