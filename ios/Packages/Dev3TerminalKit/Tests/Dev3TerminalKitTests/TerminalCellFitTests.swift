@testable import Dev3TerminalKit
import Testing

@Test("Cell fit subtracts all viewport insets")
func terminalCellFit() {
    let viewport = Dev3TerminalViewport(
        width: 390,
        height: 844,
        insetTop: 47,
        insetLeading: 12,
        insetBottom: 34,
        insetTrailing: 12
    )

    #expect(
        Dev3TerminalCellFit.grid(
            viewport: viewport,
            cell: Dev3TerminalCellSize(width: 7, height: 14)
        ) == Dev3TerminalGridSize(columns: 52, rows: 54)
    )
}

@Test("Zoom scales cells before fitting the terminal grid")
func terminalZoomFit() throws {
    let baseCell = Dev3TerminalCellSize(width: 7, height: 14)
    let viewport = Dev3TerminalViewport(width: 350, height: 700)
    let doubled = try #require(baseCell.scaled(from: 14, to: 28))

    #expect(doubled == Dev3TerminalCellSize(width: 14, height: 28))
    #expect(
        Dev3TerminalCellFit.grid(viewport: viewport, cell: doubled)
            == Dev3TerminalGridSize(columns: 25, rows: 25)
    )
}

@Test("Cell fit preserves protocol minimum dimensions")
func terminalMinimumFit() {
    let tiny = Dev3TerminalViewport(width: 1, height: 1)
    let hugeCell = Dev3TerminalCellSize(width: 20, height: 40)

    #expect(
        Dev3TerminalCellFit.grid(viewport: tiny, cell: hugeCell)
            == Dev3TerminalGridSize(columns: 2, rows: 1)
    )
}

@Test("Cell fit drops a partial bottom row after a zoom resize")
func terminalPartialRowFit() {
    #expect(
        Dev3TerminalCellFit.grid(
            viewport: Dev3TerminalViewport(width: 320, height: 100.9),
            cell: Dev3TerminalCellSize(width: 8, height: 20)
        ) == Dev3TerminalGridSize(columns: 40, rows: 5)
    )
}

@Test("Cell fit rejects invalid metrics and exhausted viewports")
func terminalInvalidFit() {
    let viewport = Dev3TerminalViewport(width: 320, height: 480)
    #expect(Dev3TerminalCellFit.grid(viewport: viewport, cell: .init(width: 0, height: 14)) == nil)
    #expect(Dev3TerminalCellFit.grid(viewport: viewport, cell: .init(width: .nan, height: 14)) == nil)
    #expect(
        Dev3TerminalCellFit.grid(
            viewport: .init(width: 20, height: 20, insetLeading: 10, insetTrailing: 10),
            cell: .init(width: 7, height: 14)
        ) == nil
    )
    #expect(Dev3TerminalCellSize(width: 7, height: 14).scaled(from: 0, to: 14) == nil)
}
