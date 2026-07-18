#if canImport(UIKit)
    import Dev3UI
    import Foundation
    import os
    import SwiftTerm
    import SwiftUI
    import UIKit

    public struct Dev3TerminalView: UIViewRepresentable {
        @Environment(\.colorScheme) private var colorScheme

        private let endpoint: Dev3TerminalEndpoint
        private let interaction: Dev3TerminalInteraction?
        private let resize: (@Sendable (Int, Int) async throws -> Void)?
        private let serverID: String
        private let inputMode: Dev3TerminalInputMode
        private let rawSubmitRevision: UInt64
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

                terminalView?.setInputMode(configuration.inputMode)
                let submitCount = rawSubmitState.consume(configuration.rawSubmitRevision)
                for _ in 0 ..< submitCount {
                    terminalView?.submitRawInput()
                }
            }

            fileprivate func detach() {
                outputTask?.cancel()
                clipboardTask?.cancel()
                outputTask = nil
                clipboardTask = nil
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
                guard newCols > 0, newRows > 0, let endpoint else { return }
                let resize = resize
                Task {
                    do {
                        if let resize {
                            try await resize(newCols, newRows)
                        } else {
                            try await endpoint.resize(columns: newCols, rows: newRows)
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

            fileprivate func persistFontSize(_ size: Double) {
                guard let serverID else { return }
                fontPreferences.setSize(size, for: serverID)
            }

            private func report(_ error: Error) {
                onError(String(describing: error))
            }
        }
    }

    @MainActor
    private final class Dev3DisplayLinkProxy: NSObject {
        weak var owner: Dev3TerminalView.Coordinator?

        @objc func tick() {
            owner?.displayFrame()
        }
    }

    @MainActor
    public final class Dev3SwiftTermView: TerminalView, UIGestureRecognizerDelegate {
        private static let keyCommandInputs: [String: Dev3TerminalFunctionalKey] = [
            "\t": .tab,
            "\r": .enter,
            UIKeyCommand.inputHome: .home,
            UIKeyCommand.inputEnd: .end,
            UIKeyCommand.inputDelete: .delete,
            UIKeyCommand.inputPageUp: .pageUp,
            UIKeyCommand.inputPageDown: .pageDown,
            UIKeyCommand.f1: .f1,
            UIKeyCommand.f2: .f2,
            UIKeyCommand.f3: .f3,
            UIKeyCommand.f4: .f4,
            UIKeyCommand.f5: .f5,
            UIKeyCommand.f6: .f6,
            UIKeyCommand.f7: .f7,
            UIKeyCommand.f8: .f8,
            UIKeyCommand.f9: .f9,
            UIKeyCommand.f10: .f10,
            UIKeyCommand.f11: .f11,
            UIKeyCommand.f12: .f12
        ]

        private var inputMode = Dev3TerminalInputMode.compose
        private var pinchStartSize = Dev3TerminalFontPreferenceStore.defaultSize
        var scrollAccumulator = Dev3TerminalScrollAccumulator()
        var scrollLastTranslationY: CGFloat = 0
        var scrollAxisDecided = false
        var scrollIsVertical = false
        weak var scrollPanGesture: UIPanGestureRecognizer?
        static let scrollAxisDecidePoints: CGFloat = 8

        override public init(frame: CGRect) {
            super.init(frame: frame)
            configureInteractions()
        }

        public required init?(coder: NSCoder) {
            super.init(coder: coder)
            configureInteractions()
        }

        override public var canBecomeFirstResponder: Bool {
            inputMode.acceptsDirectTerminalInput
        }

        override public var canBecomeFocused: Bool {
            inputMode.acceptsDirectTerminalInput
        }

        override public var keyCommands: [UIKeyCommand]? {
            guard inputMode.acceptsDirectTerminalInput else {
                return super.keyCommands
            }
            let shiftCommands = Self.keyCommandInputs.keys.map { input in
                let command = UIKeyCommand(
                    input: input,
                    modifierFlags: .shift,
                    action: #selector(handleShiftKeyCommand)
                )
                command.wantsPriorityOverSystemBehavior = true
                return command
            }
            return (super.keyCommands ?? []) + shiftCommands
        }

        fileprivate func setInputMode(_ mode: Dev3TerminalInputMode) {
            guard inputMode != mode else { return }
            inputMode = mode
            if mode.acceptsDirectTerminalInput {
                _ = becomeFirstResponder()
            } else {
                _ = resignFirstResponder()
            }
        }

        fileprivate func setTerminalFontSize(_ size: Double) {
            let clamped = Dev3TerminalFontPreferenceStore.clamp(size)
            font = UIFont(name: Dev3Glyph.fontName, size: CGFloat(clamped))
                ?? UIFont.monospacedSystemFont(ofSize: CGFloat(clamped), weight: .regular)
        }

        public func submitRawInput() {
            insertText("\n")
        }

        fileprivate func apply(theme: Dev3ResolvedTerminalTheme) {
            nativeBackgroundColor = UIColor(theme.background)
            layer.backgroundColor = UIColor(theme.background).cgColor
            nativeForegroundColor = UIColor(theme.foreground)
            caretColor = UIColor(theme.cursor)
            selectedTextBackgroundColor = UIColor(theme.selectionBackground)
            selectionHandleColor = UIColor(theme.cursor)
            installColors(theme.ansi.map(SwiftTerm.Color.init))
        }

        private func configureInteractions() {
            allowMouseReporting = false
            useBrightColors = true
            accessibilityIdentifier = "dev3.terminal"

            // dev3 always runs inside tmux, so SwiftTerm's own scrollback is empty
            // — disable native drag-scroll and forward vertical drags to tmux as
            // SGR wheel events instead (see Dev3TerminalView+Scroll.swift).
            isScrollEnabled = false

            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch))
            pinch.delegate = self
            addGestureRecognizer(pinch)

            let reset = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap))
            reset.numberOfTapsRequired = 2
            addGestureRecognizer(reset)

            let scroll = UIPanGestureRecognizer(target: self, action: #selector(handleScrollPan))
            scroll.delegate = self
            scroll.cancelsTouchesInView = false
            scroll.maximumNumberOfTouches = 1
            addGestureRecognizer(scroll)
            scrollPanGesture = scroll
            // Kill the built-in UIScrollView pan outright so it can't win the drag
            // over our wheel-synthesis pan (isScrollEnabled alone proved unreliable).
            panGestureRecognizer.isEnabled = false
        }

        @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began:
                pinchStartSize = Double(font.pointSize)
            case .changed:
                setTerminalFontSize(pinchStartSize * Double(gesture.scale))
            case .ended:
                let size = Dev3TerminalFontPreferenceStore.clamp(Double(font.pointSize))
                (terminalDelegate as? Dev3TerminalView.Coordinator)?.persistFontSize(size)
            default:
                break
            }
        }

        @objc private func handleDoubleTap() {
            let size = Dev3TerminalFontPreferenceStore.defaultSize
            setTerminalFontSize(size)
            (terminalDelegate as? Dev3TerminalView.Coordinator)?.persistFontSize(size)
        }

        @objc private func handleShiftKeyCommand(_ command: UIKeyCommand) {
            guard inputMode.acceptsDirectTerminalInput,
                  let input = command.input,
                  let key = Self.keyCommandInputs[input],
                  let sequence = Dev3TerminalInputEncoder.shiftSequence(for: key) else { return }
            let bytes = [UInt8](sequence)
            terminalDelegate?.send(source: self, data: bytes[...])
        }
    }

    private extension UIColor {
        convenience init(_ color: Dev3RGBA) {
            self.init(
                red: CGFloat(color.red) / 255,
                green: CGFloat(color.green) / 255,
                blue: CGFloat(color.blue) / 255,
                alpha: CGFloat(color.opacity)
            )
        }
    }

    private extension SwiftTerm.Color {
        convenience init(_ color: Dev3RGBA) {
            self.init(
                red: UInt16(color.red) * 257,
                green: UInt16(color.green) * 257,
                blue: UInt16(color.blue) * 257
            )
        }
    }
#endif
