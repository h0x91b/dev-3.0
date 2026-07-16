import Foundation

public final class Dev3TerminalInteraction: Dev3TerminalSubmitTransport, @unchecked Sendable {
    public static let bracketedPasteStart = Data("\u{1B}[200~".utf8)
    public static let bracketedPasteEnd = Data("\u{1B}[201~".utf8)

    private let sendData: @Sendable (Data) async throws -> Void
    private let modeLock = NSLock()
    private var bracketedPaste = false

    public convenience init(endpoint: Dev3TerminalEndpoint) {
        self.init { data in
            try await endpoint.send(data)
        }
    }

    public init(sendData: @escaping @Sendable (Data) async throws -> Void) {
        self.sendData = sendData
    }

    public func updateBracketedPaste(_ enabled: Bool) {
        modeLock.lock()
        bracketedPaste = enabled
        modeLock.unlock()
    }

    public func hasBracketedPaste() async throws -> Bool {
        bracketedPasteEnabled()
    }

    public func paste(_ text: String) async throws {
        let isBracketed = bracketedPasteEnabled()
        var payload = Data()
        if isBracketed {
            payload.append(Self.bracketedPasteStart)
        }
        payload.append(Data(text.utf8))
        if isBracketed {
            payload.append(Self.bracketedPasteEnd)
        }
        try await sendData(payload)
    }

    public func sendInput(_ data: Data) async throws {
        try await sendData(data)
    }

    private func bracketedPasteEnabled() -> Bool {
        modeLock.lock()
        defer { modeLock.unlock() }
        return bracketedPaste
    }
}

public actor Dev3TerminalFocusLifecycle {
    private let setFocus: @Sendable (Bool) async throws -> Void
    private var isConnected = false
    private var wantsFocus = false
    private var isFocused = false

    public init(setFocus: @escaping @Sendable (Bool) async throws -> Void) {
        self.setFocus = setFocus
    }

    public func connected() async throws {
        isConnected = true
        do {
            try await reconcile()
        } catch {
            isConnected = false
            throw error
        }
    }

    public func setActive(_ active: Bool) async throws {
        wantsFocus = active
        try await reconcile()
    }

    public func disconnecting() async {
        isConnected = false
        do {
            try await reconcile()
        } catch {
            isFocused = false
        }
    }

    private func reconcile() async throws {
        let target = isConnected && wantsFocus
        guard target != isFocused else { return }
        try await setFocus(target)
        isFocused = target
    }
}
