import UIKit
import UserNotifications

@MainActor
protocol NativeNotificationServicing: AnyObject {
    func authorizationStatus() async -> NativeNotificationAuthorization
    func requestAuthorizationFromSettings() async throws -> Bool
    func deliverReplacing(_ request: NativeNotificationRequest) async throws
    func removeNotifications(identifiers: Set<String>) async
    func setBadgeCount(_ count: Int) async throws
    func playTerminalBellHaptic()
}

@MainActor
final class UserNotificationService: NativeNotificationServicing {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus() async -> NativeNotificationAuthorization {
        let settings = await center.notificationSettings()
        return switch settings.authorizationStatus {
        case .notDetermined:
            .notDetermined
        case .denied:
            .denied
        case .authorized:
            .authorized
        case .provisional:
            .provisional
        case .ephemeral:
            .ephemeral
        @unknown default:
            .denied
        }
    }

    func requestAuthorizationFromSettings() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .badge, .sound])
    }

    func deliverReplacing(_ request: NativeNotificationRequest) async throws {
        center.removePendingNotificationRequests(withIdentifiers: [request.identifier])
        center.removeDeliveredNotifications(withIdentifiers: [request.identifier])

        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.sound = .default
        content.userInfo = request.userInfo
        content.threadIdentifier = request.taskID
        try await center.add(UNNotificationRequest(
            identifier: request.identifier,
            content: content,
            trigger: nil
        ))
    }

    func removeNotifications(identifiers: Set<String>) async {
        let identifiers = Array(identifiers)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func setBadgeCount(_ count: Int) async throws {
        try await center.setBadgeCount(count)
    }

    func playTerminalBellHaptic() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
