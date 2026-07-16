@testable import Dev3TerminalKit
import Testing

@Test("Terminal package exposes the SwiftTerm integration")
func integrationName() {
    #expect(TerminalRuntime.integrationName == "SwiftTerm")
    _ = TerminalRuntime.terminalType
}
