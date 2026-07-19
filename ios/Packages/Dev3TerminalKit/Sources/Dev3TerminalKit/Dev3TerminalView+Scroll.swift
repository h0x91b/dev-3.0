#if canImport(UIKit)
    import Dev3Kit
    import SwiftTerm
    import UIKit

    /// Vertical-drag → tmux scrollback. Kept out of Dev3TerminalView.swift so that
    /// file stays under the file-length limit. See `Dev3TerminalWheelScroll` for why
    /// synthesized wheel events are required (tmux `mouse on`, empty local buffer).
    extension Dev3SwiftTermView {
        @objc func handleScrollPan(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                finishScrollBurst()
                scrollAccumulator.reset()
                scrollLastTranslationY = 0
                scrollAxisDecided = false
                scrollIsVertical = false
            case .changed:
                let translation = gesture.translation(in: self)
                if !scrollAxisDecided {
                    let magnitude = max(abs(translation.x), abs(translation.y))
                    guard magnitude >= Self.scrollAxisDecidePoints else { return }
                    scrollAxisDecided = true
                    // Leave horizontal drags to the pane-swipe gesture.
                    scrollIsVertical = abs(translation.y) >= abs(translation.x)
                    scrollLastTranslationY = translation.y
                    DiagnosticsLog.shared.record(
                        category: "terminal",
                        "scroll pan \(scrollIsVertical ? "vertical" : "horizontal")"
                    )
                }
                guard scrollIsVertical else { return }
                let deltaY = translation.y - scrollLastTranslationY
                scrollLastTranslationY = translation.y
                let ticks = scrollAccumulator.consume(deltaY: Double(deltaY))
                guard ticks != 0 else { return }
                if ticks > 0 {
                    scrollBurstUpTicks += ticks
                } else {
                    scrollBurstDownTicks += abs(ticks)
                }
                emitWheel(ticks: ticks, at: gesture.location(in: self))
            case .ended, .cancelled, .failed:
                finishScrollBurst()
                scrollAccumulator.reset()
                scrollAxisDecided = false
            default:
                break
            }
        }

        private func emitWheel(ticks: Int, at point: CGPoint) {
            let cell = scrollCell(at: point)
            // Finger dragged down (positive ticks) reveals older output → wheel up.
            let up = ticks > 0
            var payload: [UInt8] = []
            for _ in 0 ..< abs(ticks) {
                let event = Dev3TerminalWheelScroll.sequence(up: up, col: cell.col, row: cell.row)
                payload.append(contentsOf: event)
            }
            guard !payload.isEmpty else { return }
            terminalDelegate?.send(source: self, data: payload[...])
        }

        private func finishScrollBurst() {
            let totalTicks = scrollBurstUpTicks + scrollBurstDownTicks
            guard totalTicks > 0 else { return }
            let direction = if scrollBurstUpTicks > 0, scrollBurstDownTicks > 0 {
                "mixed"
            } else if scrollBurstUpTicks > 0 {
                "up"
            } else {
                "down"
            }
            DiagnosticsLog.shared.record(
                category: "terminal",
                "scroll burst direction=\(direction) ticks=\(totalTicks)"
            )
            scrollBurstUpTicks = 0
            scrollBurstDownTicks = 0
        }

        private func scrollCell(at point: CGPoint) -> (col: Int, row: Int) {
            let terminal = getTerminal()
            let cols = max(1, terminal.cols)
            let rows = max(1, terminal.rows)
            let cellWidth = bounds.width > 0 ? bounds.width / CGFloat(cols) : 0
            let col = cellWidth > 0 ? min(cols, max(1, Int(point.x / cellWidth) + 1)) : 1
            // Always target the vertical middle of the pane, never the touched
            // row. tmux's default WheelUp/DownStatus bindings hijack a wheel event
            // that lands on the bottom status line (previous-window/next-window),
            // and the touch→row estimate was pinning every event to that row. The
            // exact row within the pane is irrelevant to scrolling it.
            let row = max(1, rows / 2)
            return (col, row)
        }

        /// Let the wheel-synthesis pan run alongside every other recognizer (taps,
        /// long-press selection, pinch, the SwiftUI pane-swipe) so it is never
        /// starved by gesture arbitration — the original recognize-with-pinch-only
        /// rule let SwiftTerm's gestures block the scroll drag.
        public func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            if gestureRecognizer === scrollPanGesture || otherGestureRecognizer === scrollPanGesture {
                return true
            }
            return gestureRecognizer is UIPinchGestureRecognizer
                || otherGestureRecognizer is UIPinchGestureRecognizer
        }
    }
#endif
