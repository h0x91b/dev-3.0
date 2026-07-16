@testable import dev3
import Foundation
import Testing

@MainActor
@Suite("Notification tap bridge")
struct NotificationTapBridgeTests {
    @Test("Cold-launch taps buffer until the coordinator binds and drain once")
    func buffersColdLaunchTap() {
        let bridge = NotificationTapBridge()
        var received: [[String: String]] = []
        let first = ["task": "first"]
        let second = ["task": "second"]

        bridge.receive(userInfo: first)
        bridge.bind { received.append($0) }
        #expect(received == [first])

        bridge.receive(userInfo: second)
        #expect(received == [first, second])

        bridge.unbind()
        bridge.receive(userInfo: first)
        bridge.bind { received.append($0) }
        #expect(received == [first, second, first])
    }

    @Test("Only string notification metadata crosses into deep-link handling")
    func filtersUserInfo() {
        let userInfo = NotificationTapBridge.stringUserInfo([
            "server": "server-a",
            "count": 3,
            7: "ignored"
        ])

        #expect(userInfo == ["server": "server-a"])
        #expect(NotificationTapBridge.foregroundPresentationOptions.isEmpty)
    }
}
