@testable import dev3
import Testing

@Suite("Terminal shared-size notice")
struct TerminalSharedSizeNoticeTests {
    @Test("Notice states the shared invariant without blaming this device")
    func honestCopy() {
        #expect(TerminalSharedSizeNotice.message == "Terminal dimensions are shared across connected viewers.")
        #expect(!TerminalSharedSizeNotice.message.localizedCaseInsensitiveContains("limiting"))
        #expect(TerminalSharedSizeNotice.leaveHint == "Detaches on back")
    }

    @Test("Notice appears only for a connected shared-dimensions terminal")
    func visibility() {
        #expect(
            TerminalSharedSizeNotice.isVisible(
                phase: .connected,
                usesSharedTerminalDimensions: true
            )
        )
        #expect(
            !TerminalSharedSizeNotice.isVisible(
                phase: .connecting,
                usesSharedTerminalDimensions: true
            )
        )
        #expect(
            !TerminalSharedSizeNotice.isVisible(
                phase: .connected,
                usesSharedTerminalDimensions: false
            )
        )
    }
}
