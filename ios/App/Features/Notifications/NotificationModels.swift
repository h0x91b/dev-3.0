import Dev3Kit
import Dev3UI
import Foundation

enum NativeNotificationCategory: String, Codable, CaseIterable, Sendable {
    case web
    case attention
    case terminalBell
}

struct NativeNotificationPreferences: Codable, Equatable, Sendable {
    var webNotificationsEnabled = true
    var attentionNotificationsEnabled = true
    var terminalBellNotificationsEnabled = true
    var hapticsEnabled = true

    func allows(_ category: NativeNotificationCategory) -> Bool {
        switch category {
        case .web:
            webNotificationsEnabled
        case .attention:
            attentionNotificationsEnabled
        case .terminalBell:
            terminalBellNotificationsEnabled
        }
    }
}

enum NativeNotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral

    var allowsDelivery: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral:
            true
        case .notDetermined, .denied:
            false
        }
    }
}

struct NativeNotificationRequest: Equatable, Sendable {
    let identifier: String
    let category: NativeNotificationCategory
    let title: String
    let body: String
    let serverID: String
    let projectID: String
    let taskID: String
    let level: Dev3NotificationLevel

    var userInfo: [String: String] {
        [
            NativeNotificationPolicy.serverIDKey: serverID,
            NativeNotificationPolicy.projectIDKey: projectID,
            NativeNotificationPolicy.taskIDKey: taskID
        ]
    }
}

struct NativeNotificationDeepLink: Codable, Equatable, Sendable {
    let serverID: String
    let projectID: String
    let taskID: String
}

struct NativeNotificationForeground: Equatable, Sendable {
    var isActive = false
    var visibleTaskID: String?
}

enum NativeNotificationPolicy {
    static let serverIDKey = "dev3ServerID"
    static let projectIDKey = "dev3ProjectID"
    static let taskIDKey = "dev3TaskID"

    static let backgroundDeliveryLimitation =
        "Notifications need a live dev3 connection. iOS may pause them while the app is suspended."

    static func identifier(
        serverID: String,
        category: NativeNotificationCategory,
        taskID: String
    ) -> String {
        "dev3.ios.\(serverID).\(category.rawValue).\(taskID)"
    }

    static func identifiers(serverID: String, taskID: String) -> Set<String> {
        Set(NativeNotificationCategory.allCases.map {
            identifier(serverID: serverID, category: $0, taskID: taskID)
        })
    }

    static func isVisible(
        taskID: String,
        foreground: NativeNotificationForeground
    ) -> Bool {
        foreground.isActive && foreground.visibleTaskID == taskID
    }

    static func shouldDeliver(
        category: NativeNotificationCategory,
        taskID: String,
        preferences: NativeNotificationPreferences,
        authorization: NativeNotificationAuthorization,
        foreground: NativeNotificationForeground
    ) -> Bool {
        preferences.allows(category) &&
            authorization.allowsDelivery &&
            !isVisible(taskID: taskID, foreground: foreground)
    }

    static func badgeCount(
        tasks: some Sequence<Dev3Task>,
        attentionTaskIDs: Set<String>
    ) -> Int {
        let knownTasks = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        var badgeTaskIDs = Set(knownTasks.values.filter(TaskReadiness.needsUser).map(\.id))
        badgeTaskIDs.formUnion(attentionTaskIDs.filter { knownTasks[$0] != nil })
        return badgeTaskIDs.count
    }

    static func deepLink(userInfo: [String: String]) -> NativeNotificationDeepLink? {
        guard let serverID = nonempty(userInfo[serverIDKey]),
              let projectID = nonempty(userInfo[projectIDKey]),
              let taskID = nonempty(userInfo[taskIDKey]) else { return nil }
        return NativeNotificationDeepLink(
            serverID: serverID,
            projectID: projectID,
            taskID: taskID
        )
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

protocol NativeNotificationStateStoring: AnyObject {
    func loadPreferences() -> NativeNotificationPreferences
    func savePreferences(_ preferences: NativeNotificationPreferences)
    func loadPendingDeepLink() -> NativeNotificationDeepLink?
    func savePendingDeepLink(_ deepLink: NativeNotificationDeepLink?)
}

final class UserDefaultsNotificationStateStore: NativeNotificationStateStoring {
    private enum Key {
        static let preferences = "ios.notifications.preferences.v1"
        static let pendingDeepLink = "ios.notifications.pending-deep-link.v1"
    }

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadPreferences() -> NativeNotificationPreferences {
        guard let data = defaults.data(forKey: Key.preferences),
              let preferences = try? decoder.decode(NativeNotificationPreferences.self, from: data)
        else { return NativeNotificationPreferences() }
        return preferences
    }

    func savePreferences(_ preferences: NativeNotificationPreferences) {
        guard let data = try? encoder.encode(preferences) else { return }
        defaults.set(data, forKey: Key.preferences)
    }

    func loadPendingDeepLink() -> NativeNotificationDeepLink? {
        guard let data = defaults.data(forKey: Key.pendingDeepLink) else { return nil }
        return try? decoder.decode(NativeNotificationDeepLink.self, from: data)
    }

    func savePendingDeepLink(_ deepLink: NativeNotificationDeepLink?) {
        guard let deepLink else {
            defaults.removeObject(forKey: Key.pendingDeepLink)
            return
        }
        guard let data = try? encoder.encode(deepLink) else { return }
        defaults.set(data, forKey: Key.pendingDeepLink)
    }
}
