import Dev3Kit
import Dev3TerminalKit
import Foundation

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
    var warnsAboutSharedTerminalSize: Bool { get }

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
}

actor RPCTerminalTaskService: TerminalTaskServicing {
    nonisolated let taskID: String
    nonisolated let serverID: String
    nonisolated let endpoint: Dev3TerminalEndpoint
    nonisolated let terminalInteraction: Dev3TerminalInteraction
    nonisolated let warnsAboutSharedTerminalSize: Bool

    private let rpcClient: RPCClient
    private let ptyClient: PTYClient
    private let focusLifecycle: Dev3TerminalFocusLifecycle

    init(
        taskID: String,
        serverID: String,
        rpcClient: RPCClient,
        ptyClient: PTYClient,
        clipboardText: AsyncStream<String>,
        warnsAboutSharedTerminalSize: Bool = true
    ) {
        self.taskID = taskID
        self.serverID = serverID
        self.rpcClient = rpcClient
        self.ptyClient = ptyClient
        self.warnsAboutSharedTerminalSize = warnsAboutSharedTerminalSize
        let terminalEndpoint = Dev3TerminalEndpoint(
            identity: "task:\(taskID)",
            ptyClient: ptyClient,
            clipboardText: clipboardText
        )
        endpoint = terminalEndpoint
        terminalInteraction = Dev3TerminalInteraction(endpoint: terminalEndpoint)
        focusLifecycle = Dev3TerminalFocusLifecycle { active in
            try await rpcClient.setTerminalFocus(active)
        }
    }

    func attach() async throws {
        let resolution = try await rpcClient.getPtyUrl(taskId: taskID)
        try await ptyClient.connect(to: .task(taskID), resolution: resolution)
        try await acquireFocusOrDisconnect()
    }

    func detach() async {
        await focusLifecycle.disconnecting()
        await ptyClient.disconnect()
    }

    func kick() async {
        await ptyClient.kick()
    }

    func setTerminalActive(_ active: Bool) async throws {
        try await focusLifecycle.setActive(active)
    }

    func resume() async throws {
        _ = try await rpcClient.resumeTask(taskId: taskID)
        try await ptyClient.connect(to: .task(taskID))
        try await acquireFocusOrDisconnect()
    }

    func restart() async throws {
        _ = try await rpcClient.restartTask(taskId: taskID)
        try await ptyClient.connect(to: .task(taskID))
        try await acquireFocusOrDisconnect()
    }

    func windowNavigation(
        step: TerminalPagerStep?,
        index: Int?
    ) async throws -> Dev3TmuxWindowNavigation {
        try await rpcClient.tmuxWindowNavigate(
            taskId: taskID,
            step: step?.navigationStep,
            index: index
        )
    }

    func paneNavigation(
        step: TerminalPagerStep?,
        index: Int?,
        zoom: Bool
    ) async throws -> Dev3TmuxPaneNavigation {
        try await rpcClient.tmuxPaneNavigate(
            taskId: taskID,
            step: step?.navigationStep,
            index: index,
            zoom: zoom
        )
    }

    func paneCount() async throws -> Int {
        try await rpcClient.tmuxPaneCount(taskId: taskID).count
    }

    func perform(_ action: TerminalPaneAction, force: Bool) async throws {
        try await rpcClient.tmuxAction(
            taskId: taskID,
            action: action.tmuxAction,
            force: force ? true : nil
        )
    }

    func submit(_ text: String) async -> Dev3TerminalSubmitOutcome {
        await Dev3TerminalSubmit.pastedText(text, transport: terminalInteraction)
    }

    func insert(_ text: String) async throws {
        try await terminalInteraction.paste(text)
    }

    func send(_ data: Data) async throws {
        try await endpoint.send(data)
    }

    private func acquireFocusOrDisconnect() async throws {
        do {
            try await focusLifecycle.connected()
        } catch {
            await ptyClient.disconnect()
            throw error
        }
    }
}
