#if canImport(UIKit)
    import Dev3UI
    import Foundation
    import os
    import SwiftTerm
    import SwiftUI
    import UIKit

    // swiftlint:disable type_body_length
    public struct Dev3TerminalView: UIViewRepresentable {
        @Environment(\.colorScheme) private var colorScheme

        private let endpoint: Dev3TerminalEndpoint
        private let interaction: Dev3TerminalInteraction?
        private let resize: (@Sendable (Int, Int) async throws -> Void)?
        private let serverID: String
        private let inputMode: Dev3TerminalInputMode
        private let rawSubmitRevision: UInt64
        private let terminalRefreshRevision: UInt64
        private let instanceResolvedTheme: Dev3ResolvedThemeMode?
        private let fallbackFontSize: Double
        private let onError: @MainActor @Sendable (String) -> Void

        fileprivate struct Configuration {
            let endpoint: Dev3TerminalEndpoint
            let interaction: Dev3TerminalInteraction?
            let resize: (@Sendable (Int, Int) async throws -> Void)?
            let serverID: String
            let inputMode: Dev3TerminalInputMode
            let rawSubmitRevision: UInt64
            let terminalRefreshRevision: UInt64
            let theme: Dev3TerminalThemeConfiguration
            let fallbackFontSize: Double
            let onError: @MainActor @Sendable (String) -> Void
        }

        public init(
            endpoint: Dev3TerminalEndpoint,
            interaction: Dev3TerminalInteraction? = nil,
            resize: (@Sendable (Int, Int) async throws -> Void)? = nil,
            serverID: String,
            inputMode: Dev3TerminalInputMode,
            rawSubmitRevision: UInt64 = 0,
            terminalRefreshRevision: UInt64 = 0,
            instanceResolvedTheme: Dev3ResolvedThemeMode? = nil,
            fallbackFontSize: Double = Dev3TerminalFontPreferenceStore.defaultSize,
            onError: @escaping @MainActor @Sendable (String) -> Void = { _ in }
        ) {
            self.endpoint = endpoint
            self.interaction = interaction
            self.resize = resize
            self.serverID = serverID
            self.inputMode = inputMode
            self.rawSubmitRevision = rawSubmitRevision
            self.terminalRefreshRevision = terminalRefreshRevision
            self.instanceResolvedTheme = instanceResolvedTheme
            self.fallbackFontSize = fallbackFontSize
            self.onError = onError
        }

        public func makeUIView(context: Context) -> Dev3SwiftTermView {
            let view = Dev3SwiftTermView(frame: .zero)
            context.coordinator.attach(view)
            context.coordinator.configure(configuration)
            return view
        }

        public func updateUIView(_: Dev3SwiftTermView, context: Context) {
            context.coordinator.configure(configuration)
        }

        private var configuration: Configuration {
            Configuration(
                endpoint: endpoint,
                interaction: interaction,
                resize: resize,
                serverID: serverID,
                inputMode: inputMode,
                rawSubmitRevision: rawSubmitRevision,
                terminalRefreshRevision: terminalRefreshRevision,
                theme: Dev3TerminalThemeConfiguration(
                    instanceResolvedTheme: instanceResolvedTheme,
                    deviceColorScheme: colorScheme
                ),
                fallbackFontSize: fallbackFontSize,
                onError: onError
            )
        }

        public static func dismantleUIView(_ view: Dev3SwiftTermView, coordinator: Coordinator) {
            coordinator.detach()
            view.updateUiClosed()
        }

        public func makeCoordinator() -> Coordinator {
            Coordinator()
        }

        @MainActor
        public final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
            private static let performanceLog = OSLog(
                subsystem: "com.ittaiz.dev3",
                category: "TerminalRendering"
            )

            private weak var terminalView: Dev3SwiftTermView?
            private var frameBuffer = Dev3TerminalFrameBuffer()
            private let fontPreferences = Dev3TerminalFontPreferenceStore()
            private var endpoint: Dev3TerminalEndpoint?
            private var interaction: Dev3TerminalInteraction?
            private var resize: (@Sendable (Int, Int) async throws -> Void)?
            private var endpointIdentity: String?
            private var serverID: String?
            private var rawSubmitState = Dev3TerminalRawSubmitState()
            private var themeApplication = Dev3TerminalThemeApplicationState()
            private var outputTask: Task<Void, Never>?
            private var clipboardTask: Task<Void, Never>?
            private var resizeTask: Task<Void, Never>?
            private var resizeAccumulator = Dev3TerminalResizeAccumulator()
            private var resizeGate = Dev3TerminalResizeGate()
            private var pendingPinchFinalSize: Dev3TerminalGridSize?
            private var hasAppliedRefreshRevision = false
            private var appliedRefreshRevision: UInt64 = 0
            // swiftformat:disable:next modifierOrder
            nonisolated(unsafe) private var displayLink: CADisplayLink?
            private var displayLinkProxy: Dev3DisplayLinkProxy?
            private var isFlushing = false
            private var onError: @MainActor @Sendable (String) -> Void = { _ in }

            override public init() {
                super.init()
                let proxy = Dev3DisplayLinkProxy()
                proxy.owner = self
                let link = CADisplayLink(target: proxy, selector: #selector(Dev3DisplayLinkProxy.tick))
                link.add(to: .main, forMode: .common)
                displayLinkProxy = proxy
                displayLink = link
            }

            deinit {
                outputTask?.cancel()
                clipboardTask?.cancel()
                resizeTask?.cancel()
                displayLink?.invalidate()
            }

            fileprivate func attach(_ view: Dev3SwiftTermView) {
                terminalView = view
                view.terminalDelegate = self
            }

            fileprivate func configure(_ configuration: Configuration) {
                onError = configuration.onError
                endpoint = configuration.endpoint
                interaction = configuration.interaction
                resize = configuration.resize

                if endpointIdentity != configuration.endpoint.identity {
                    endpointIdentity = configuration.endpoint.identity
                    startStreams(configuration.endpoint)
                }

                if serverID != configuration.serverID {
                    serverID = configuration.serverID
                    let size = fontPreferences.size(
                        for: configuration.serverID,
                        fallback: configuration.fallbackFontSize
                    )
                    terminalView?.setTerminalFontSize(size)
                }

                if themeApplication.shouldApply(configuration.theme) {
                    terminalView?.apply(theme: configuration.theme.resolvedTheme)
                }

                if hasAppliedRefreshRevision {
                    if appliedRefreshRevision != configuration.terminalRefreshRevision {
                        appliedRefreshRevision = configuration.terminalRefreshRevision
                        requestRemoteRedraw()
                    }
                } else {
                    appliedRefreshRevision = configuration.terminalRefreshRevision
                    hasAppliedRefreshRevision = true
                }

                terminalView?.setInputMode(configuration.inputMode)
                let submitCount = rawSubmitState.consume(configuration.rawSubmitRevision)
                for _ in 0 ..< submitCount {
                    terminalView?.submitRawInput()
                }
            }

            fileprivate func detach() {
                outputTask?.cancel()
                clipboardTask?.cancel()
                resizeTask?.cancel()
                outputTask = nil
                clipboardTask = nil
                resizeTask = nil
                resizeAccumulator = Dev3TerminalResizeAccumulator()
                resizeGate = Dev3TerminalResizeGate()
                pendingPinchFinalSize = nil
                hasAppliedRefreshRevision = false
                displayLink?.invalidate()
                displayLink = nil
                terminalView?.terminalDelegate = nil
                terminalView = nil
                endpoint = nil
                interaction = nil
            }

            fileprivate func displayFrame() {
                guard !isFlushing else { return }
                isFlushing = true
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    defer { isFlushing = false }
                    guard let data = await frameBuffer.drainFrame(), let terminalView else { return }

                    os_signpost(
                        .event,
                        log: Self.performanceLog,
                        name: "Coalesced PTY frame",
                        "bytes=%{public}d",
                        data.count
                    )
                    let bytes = [UInt8](data)
                    terminalView.feed(byteArray: bytes[...])
                    interaction?.updateBracketedPaste(
                        terminalView.getTerminal().bracketedPasteMode
                    )
                }
            }

            private func startStreams(_ endpoint: Dev3TerminalEndpoint) {
                outputTask?.cancel()
                clipboardTask?.cancel()
                let currentFrameBuffer = Dev3TerminalFrameBuffer()
                frameBuffer = currentFrameBuffer

                outputTask = Task {
                    for await event in endpoint.output {
                        guard !Task.isCancelled else { break }
                        switch event {
                        case let .data(data):
                            guard await currentFrameBuffer.append(data) else { return }
                        case .reset:
                            await currentFrameBuffer.discardPending()
                            terminalView?.getTerminal().resetToInitialState()
                            interaction?.updateBracketedPaste(false)
                        }
                    }
                }

                clipboardTask = Task { @MainActor in
                    for await text in endpoint.clipboardText {
                        guard !Task.isCancelled else { break }
                        UIPasteboard.general.string = text
                    }
                }
            }

            public func sizeChanged(source _: TerminalView, newCols: Int, newRows: Int) {
                guard let requested = resizeGate.request(columns: newCols, rows: newRows) else {
                    return
                }
                if let pendingPinchFinalSize {
                    guard requested == pendingPinchFinalSize else { return }
                    self.pendingPinchFinalSize = nil
                }
                guard let size = resizeAccumulator.update(
                    columns: requested.columns,
                    rows: requested.rows
                ) else { return }
                scheduleResize(size)
            }

            private func scheduleResize(_ size: Dev3TerminalGridSize) {
                let resize = resize
                resizeTask?.cancel()
                resizeTask = Task { [weak self] in
                    do {
                        try await Task.sleep(for: .milliseconds(50))
                    } catch {
                        return
                    }
                    guard let self else { return }
                    do {
                        if let resize {
                            try await resize(size.columns, size.rows)
                        } else {
                            guard let endpoint else { return }
                            try await endpoint.resize(columns: size.columns, rows: size.rows)
                        }
                    } catch {
                        report(error)
                    }
                }
            }

            public func setTerminalTitle(source _: TerminalView, title _: String) {}

            public func hostCurrentDirectoryUpdate(source _: TerminalView, directory _: String?) {}

            public func send(source _: TerminalView, data: ArraySlice<UInt8>) {
                guard let endpoint else { return }
                let payload = Data(data)
                let interaction = interaction
                Task {
                    do {
                        if let interaction {
                            try await interaction.sendInput(payload)
                        } else {
                            try await endpoint.send(payload)
                        }
                    } catch {
                        report(error)
                    }
                }
            }

            public func scrolled(source _: TerminalView, position _: Double) {}

            public func requestOpenLink(source _: TerminalView, link: String, params _: [String: String]) {
                guard let url = URL(string: link),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https"].contains(scheme) else { return }
                UIApplication.shared.open(url)
            }

            public func bell(source _: TerminalView) {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            }

            public func clipboardCopy(source _: TerminalView, content: Data) {
                guard let text = String(data: content, encoding: .utf8) else { return }
                UIPasteboard.general.string = text
            }

            public func clipboardRead(source _: TerminalView) -> Data? {
                nil
            }

            public func iTermContent(source _: TerminalView, content _: ArraySlice<UInt8>) {}

            public func rangeChanged(source _: TerminalView, startY _: Int, endY _: Int) {}

            func persistFontSize(_ size: Double) {
                guard let serverID else { return }
                fontPreferences.setSize(size, for: serverID)
            }

            func beginPinchResizeDeferral() {
                resizeGate.beginGesture()
                pendingPinchFinalSize = nil
            }

            func endPinchResizeDeferral() {
                guard let terminalView else { return }
                let terminal = terminalView.getTerminal()
                guard let finalSize = resizeGate.endGesture(
                    columns: terminal.cols,
                    rows: terminal.rows
                ) else { return }
                pendingPinchFinalSize = finalSize
                resizeAccumulator = Dev3TerminalResizeAccumulator()
                guard let size = resizeAccumulator.update(
                    columns: finalSize.columns,
                    rows: finalSize.rows
                ) else { return }
                scheduleResize(size)
            }

            func requestRemoteRedraw() {
                // A pane/window switch triggers a server-side full repaint
                // (see forceSessionRedraw in pty-server). Locally we only drop
                // frames buffered *before* the switch so stale pre-switch bytes
                // aren't fed on top of the incoming repaint. We must NOT reset
                // the terminal here — a local wipe races the repaint and left the
                // pane blank (the build-8 regression).
                let currentFrameBuffer = frameBuffer
                Task { @MainActor [weak self] in
                    await currentFrameBuffer.discardPending()
                    guard let self, let terminalView else { return }
                    terminalView.setNeedsDisplay(terminalView.bounds)
                }
            }

            private func report(_ error: Error) {
                onError(String(describing: error))
            }
        }
    }

    // swiftlint:enable type_body_length

    @MainActor
    private final class Dev3DisplayLinkProxy: NSObject {
        weak var owner: Dev3TerminalView.Coordinator?

        @objc func tick() {
            owner?.displayFrame()
        }
    }

#endif
