import SwiftTerm

public enum TerminalRuntime: Sendable {
    public static let integrationName = "SwiftTerm"

    public static var terminalType: Terminal.Type {
        Terminal.self
    }
}
