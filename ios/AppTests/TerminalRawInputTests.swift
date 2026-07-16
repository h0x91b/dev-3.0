@testable import dev3
import Dev3TerminalKit
import Foundation
import SwiftTerm
import Testing
import UIKit

@Suite("Terminal raw input")
@MainActor
struct TerminalRawInputTests {
    @Test("Accessory submit clears SwiftTerm text input storage")
    func accessorySubmitClearsInputStorage() {
        let view = Dev3SwiftTermView(frame: .zero)
        let delegate = RecordingTerminalViewDelegate()
        view.terminalDelegate = delegate
        let prompt = "Reply with exactly IOS_RAW_MODE_OK."

        view.insertText(prompt)
        #expect(view.hasText)

        view.submitRawInput()

        #expect(!view.hasText)
        #expect(delegate.sentData == [Data(prompt.utf8), Data([0x0D])])
    }

    @Test("Raw accessory submit consumes Ctrl without duplicating the service send")
    func accessorySubmitConsumesControlLatch() async {
        let service = RecordingTerminalLifecycleService()
        let store = TerminalTaskStore(service: service)
        store.inputMode = .raw

        #expect(!store.sendAccessory(.control))
        #expect(store.isControlLatched)
        #expect(store.sendAccessory(.enter))
        #expect(!store.isControlLatched)
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().sentData.isEmpty)

        store.inputMode = .compose
        #expect(!store.sendAccessory(.enter))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(await service.snapshot().sentData == [Data([0x0D])])
    }
}

@MainActor
private final class RecordingTerminalViewDelegate: @preconcurrency TerminalViewDelegate {
    private(set) var sentData: [Data] = []

    func sizeChanged(source _: TerminalView, newCols _: Int, newRows _: Int) {}

    func setTerminalTitle(source _: TerminalView, title _: String) {}

    func hostCurrentDirectoryUpdate(source _: TerminalView, directory _: String?) {}

    func send(source _: TerminalView, data: ArraySlice<UInt8>) {
        sentData.append(Data(data))
    }

    func scrolled(source _: TerminalView, position _: Double) {}

    func requestOpenLink(source _: TerminalView, link _: String, params _: [String: String]) {}

    func bell(source _: TerminalView) {}

    func clipboardCopy(source _: TerminalView, content _: Data) {}

    func clipboardRead(source _: TerminalView) -> Data? {
        nil
    }

    func iTermContent(source _: TerminalView, content _: ArraySlice<UInt8>) {}

    func rangeChanged(source _: TerminalView, startY _: Int, endY _: Int) {}
}
