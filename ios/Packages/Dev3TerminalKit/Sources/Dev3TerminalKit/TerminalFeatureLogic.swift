import Foundation

public enum Dev3TerminalPaneSwipeDecision: Equatable, Sendable {
    case previous
    case next
    case ignore

    public static func decide(horizontal: Double, vertical: Double, paneCount: Int) -> Self {
        guard paneCount > 1,
              abs(horizontal) >= 54,
              abs(horizontal) > abs(vertical) * 1.4 else { return .ignore }
        return horizontal < 0 ? .next : .previous
    }
}

/// Translates a vertical drag into tmux scrollback ticks.
///
/// dev3 always runs the PTY inside tmux with `mouse on`, so SwiftTerm's own
/// (alternate-screen) scrollback is empty — dragging scrolls nothing. tmux
/// instead scrolls its history when the outer terminal forwards SGR mouse-wheel
/// events, which is what these helpers synthesize. Wheel-up (finger dragged
/// down, revealing older output) is button 64; wheel-down is 65.
public enum Dev3TerminalWheelScroll {
    public static let wheelUpButton = 64
    public static let wheelDownButton = 65

    /// One SGR 1006 wheel event tmux (mouse on) reads as a scroll tick.
    public static func sequence(up: Bool, col: Int, row: Int) -> [UInt8] {
        let button = up ? wheelUpButton : wheelDownButton
        let clampedCol = max(1, col)
        let clampedRow = max(1, row)
        return Array("\u{1b}[<\(button);\(clampedCol);\(clampedRow)M".utf8)
    }
}

/// Accumulates fractional drag distance and emits whole wheel ticks. Positive
/// ticks are wheel-up (scroll back into history); negative are wheel-down.
public struct Dev3TerminalScrollAccumulator {
    /// Points of vertical drag per wheel tick. ~24pt keeps a phone-sized flick
    /// to a handful of ticks rather than flooding tmux.
    public static let defaultStepPoints: Double = 24

    private let step: Double
    private var residue: Double = 0

    public init(step: Double = Dev3TerminalScrollAccumulator.defaultStepPoints) {
        self.step = max(1, step)
    }

    public mutating func consume(deltaY: Double) -> Int {
        residue += deltaY
        var ticks = 0
        while residue >= step {
            ticks += 1
            residue -= step
        }
        while residue <= -step {
            ticks -= 1
            residue += step
        }
        return ticks
    }

    public mutating func reset() {
        residue = 0
    }
}

public enum Dev3TerminalAccessoryKey: String, CaseIterable, Identifiable, Sendable {
    case escape = "Esc"
    case control = "Ctrl"
    case tab = "Tab"
    case left = "←"
    case down = "↓"
    case up = "↑"
    case right = "→"
    case enter = "Enter"
    case pipe = "|"
    case tilde = "~"
    case dash = "-"
    case slash = "/"
    case backslash = "\\"

    public var id: String {
        rawValue
    }

    public func bytes(control: Bool) -> Data? {
        (control ? Self.controlBytes : Self.standardBytes)[self]
    }

    private static let standardBytes: [Self: Data] = [
        .escape: Data([0x1B]),
        .tab: Data([0x09]),
        .left: Data("\u{1B}[D".utf8),
        .down: Data("\u{1B}[B".utf8),
        .up: Data("\u{1B}[A".utf8),
        .right: Data("\u{1B}[C".utf8),
        .enter: Data([0x0D]),
        .pipe: Data("|".utf8),
        .tilde: Data("~".utf8),
        .dash: Data("-".utf8),
        .slash: Data("/".utf8),
        .backslash: Data("\\".utf8)
    ]

    private static let controlBytes: [Self: Data] = [
        .escape: Data([0x1B]),
        .tab: Data([0x09]),
        .left: Data("\u{1B}[1;5D".utf8),
        .down: Data("\u{1B}[1;5B".utf8),
        .up: Data("\u{1B}[1;5A".utf8),
        .right: Data("\u{1B}[1;5C".utf8),
        .enter: Data([0x0D]),
        .pipe: Data([0x1C]),
        .backslash: Data([0x1C]),
        .dash: Data([0x1F]),
        .slash: Data([0x1F]),
        .tilde: Data([0x1E])
    ]
}

public enum Dev3TerminalAccessoryRouting {
    public static func usesTerminalTextInput(
        key: Dev3TerminalAccessoryKey,
        inputMode: Dev3TerminalInputMode
    ) -> Bool {
        key == .enter && inputMode == .raw
    }
}

struct Dev3TerminalRawSubmitState {
    private var previousRevision: UInt64?

    mutating func consume(_ revision: UInt64) -> UInt64 {
        guard let previousRevision else {
            previousRevision = revision
            return 0
        }
        guard previousRevision != revision else { return 0 }
        self.previousRevision = revision
        return revision > previousRevision ? revision - previousRevision : 1
    }
}
