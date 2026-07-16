import Foundation
import UserNotifications

@MainActor
final class NotificationTapBridge: NSObject, UNUserNotificationCenterDelegate {
    typealias Handler = @MainActor ([String: String]) -> Void

    nonisolated static let foregroundPresentationOptions: UNNotificationPresentationOptions = []

    private var bufferedUserInfo: [[String: String]] = []
    private var handler: Handler?

    func bind(_ handler: @escaping Handler) {
        self.handler = handler
        let bufferedUserInfo = bufferedUserInfo
        self.bufferedUserInfo.removeAll()
        for userInfo in bufferedUserInfo {
            handler(userInfo)
        }
    }

    func unbind() {
        handler = nil
    }

    func receive(userInfo: [String: String]) {
        if let handler {
            handler(userInfo)
        } else {
            bufferedUserInfo.append(userInfo)
        }
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification
    ) async -> UNNotificationPresentationOptions {
        Self.foregroundPresentationOptions
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = Self.stringUserInfo(response.notification.request.content.userInfo)
        await receive(userInfo: userInfo)
    }

    nonisolated static func stringUserInfo(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: userInfo.compactMap { key, value in
            guard let key = key as? String, let value = value as? String else { return nil }
            return (key, value)
        })
    }
}
