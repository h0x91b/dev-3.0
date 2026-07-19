#if canImport(UIKit)
    import Dev3Kit
    import Dev3UI
    import SwiftTerm
    import SwiftUI
    import UIKit

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
        var scrollBurstUpTicks = 0
        var scrollBurstDownTicks = 0
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

        func setInputMode(_ mode: Dev3TerminalInputMode) {
            guard inputMode != mode else { return }
            inputMode = mode
            if mode.acceptsDirectTerminalInput {
                _ = becomeFirstResponder()
            } else {
                _ = resignFirstResponder()
            }
        }

        func setTerminalFontSize(_ size: Double) {
            let clamped = Dev3TerminalFontPreferenceStore.clamp(size)
            font = UIFont(name: Dev3Glyph.fontName, size: CGFloat(clamped))
                ?? UIFont.monospacedSystemFont(ofSize: CGFloat(clamped), weight: .regular)
        }

        public func submitRawInput() {
            insertText("\n")
        }

        func apply(theme: Dev3ResolvedTerminalTheme) {
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
                (terminalDelegate as? Dev3TerminalView.Coordinator)?.beginPinchResizeDeferral()
                logPinch(phase: "begin", size: pinchStartSize)
            case .changed:
                setTerminalFontSize(pinchStartSize * Double(gesture.scale))
            case .ended, .cancelled, .failed:
                let size = Dev3TerminalFontPreferenceStore.clamp(Double(font.pointSize))
                let coordinator = terminalDelegate as? Dev3TerminalView.Coordinator
                coordinator?.endPinchResizeDeferral()
                coordinator?.persistFontSize(size)
                logPinch(phase: "end", size: size)
            default:
                break
            }
        }

        private func logPinch(phase: String, size: Double) {
            let terminal = getTerminal()
            DiagnosticsLog.shared.record(
                category: "terminal",
                "pinch \(phase) font=\(String(format: "%.1f", size)) grid=\(terminal.cols)x\(terminal.rows)"
            )
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
