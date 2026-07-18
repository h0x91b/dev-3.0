#if canImport(UIKit)
    import SwiftTerm
    import UIKit

    /// Vertical-drag → tmux scrollback. Kept out of Dev3TerminalView.swift so that
    /// file stays under the file-length limit. See `Dev3TerminalWheelScroll` for why
    /// synthesized wheel events are required (tmux `mouse on`, empty local buffer).
    extension Dev3SwiftTermView {
        @objc func handleScrollPan(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
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
                }
                guard scrollIsVertical else { return }
                let deltaY = translation.y - scrollLastTranslationY
                scrollLastTranslationY = translation.y
                let ticks = scrollAccumulator.consume(deltaY: Double(deltaY))
                guard ticks != 0 else { return }
                emitWheel(ticks: ticks, at: gesture.location(in: self))
            default:
                scrollAccumulator.reset()
                scrollAxisDecided = false
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

        private func scrollCell(at point: CGPoint) -> (col: Int, row: Int) {
            let terminal = getTerminal()
            let cols = max(1, terminal.cols)
            let rows = max(1, terminal.rows)
            let cellWidth = bounds.width > 0 ? bounds.width / CGFloat(cols) : 0
            let cellHeight = bounds.height > 0 ? bounds.height / CGFloat(rows) : 0
            let col = cellWidth > 0 ? min(cols, max(1, Int(point.x / cellWidth) + 1)) : 1
            let row = cellHeight > 0 ? min(rows, max(1, Int(point.y / cellHeight) + 1)) : 1
            return (col, row)
        }
    }
#endif
