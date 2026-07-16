import Foundation

public struct Dev3TerminalCellSize: Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }

    public func scaled(from baseFontSize: Double, to fontSize: Double) -> Dev3TerminalCellSize? {
        guard baseFontSize.isFinite, baseFontSize > 0,
              fontSize.isFinite, fontSize > 0 else { return nil }
        let scale = fontSize / baseFontSize
        return Dev3TerminalCellSize(width: width * scale, height: height * scale)
    }
}

public struct Dev3TerminalViewport: Equatable, Sendable {
    public let width: Double
    public let height: Double
    public let insetTop: Double
    public let insetLeading: Double
    public let insetBottom: Double
    public let insetTrailing: Double

    public init(
        width: Double,
        height: Double,
        insetTop: Double = 0,
        insetLeading: Double = 0,
        insetBottom: Double = 0,
        insetTrailing: Double = 0
    ) {
        self.width = width
        self.height = height
        self.insetTop = insetTop
        self.insetLeading = insetLeading
        self.insetBottom = insetBottom
        self.insetTrailing = insetTrailing
    }
}

public struct Dev3TerminalGridSize: Equatable, Sendable {
    public let columns: Int
    public let rows: Int

    public init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
    }
}

public enum Dev3TerminalCellFit {
    public static func grid(
        viewport: Dev3TerminalViewport,
        cell: Dev3TerminalCellSize
    ) -> Dev3TerminalGridSize? {
        let values = [
            viewport.width,
            viewport.height,
            viewport.insetTop,
            viewport.insetLeading,
            viewport.insetBottom,
            viewport.insetTrailing,
            cell.width,
            cell.height
        ]
        guard values.allSatisfy(\.isFinite),
              values.allSatisfy({ $0 >= 0 }),
              cell.width > 0,
              cell.height > 0 else { return nil }

        let availableWidth = viewport.width - viewport.insetLeading - viewport.insetTrailing
        let availableHeight = viewport.height - viewport.insetTop - viewport.insetBottom
        guard availableWidth > 0, availableHeight > 0 else { return nil }

        return Dev3TerminalGridSize(
            columns: max(2, Int((availableWidth / cell.width).rounded(.down))),
            rows: max(1, Int((availableHeight / cell.height).rounded(.down)))
        )
    }
}
