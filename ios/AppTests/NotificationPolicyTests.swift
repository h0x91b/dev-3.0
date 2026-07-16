@testable import dev3
import Dev3Kit
import Foundation
import Testing

@Suite("Native notification policy")
struct NotificationPolicyTests {
    @Test("Stable identifiers, visibility, authorization, and category gates project purely")
    func deliveryProjection() {
        let taskID = "task-a"
        let preferences = NativeNotificationPreferences()
        let foreground = NativeNotificationForeground(isActive: true, visibleTaskID: taskID)

        #expect(
            NativeNotificationPolicy.identifier(
                serverID: "server-a",
                category: .web,
                taskID: taskID
            ) == "dev3.ios.server-a.web.task-a"
        )
        #expect(NativeNotificationPolicy.identifiers(serverID: "server-a", taskID: taskID).count == 3)
        #expect(!NativeNotificationPolicy.shouldDeliver(
            category: .web,
            taskID: taskID,
            preferences: preferences,
            authorization: .authorized,
            foreground: foreground
        ))
        #expect(!NativeNotificationPolicy.shouldDeliver(
            category: .web,
            taskID: taskID,
            preferences: preferences,
            authorization: .notDetermined,
            foreground: NativeNotificationForeground()
        ))

        var disabled = preferences
        disabled.attentionNotificationsEnabled = false
        #expect(!NativeNotificationPolicy.shouldDeliver(
            category: .attention,
            taskID: taskID,
            preferences: disabled,
            authorization: .authorized,
            foreground: NativeNotificationForeground()
        ))
        #expect(NativeNotificationPolicy.shouldDeliver(
            category: .terminalBell,
            taskID: taskID,
            preferences: disabled,
            authorization: .authorized,
            foreground: NativeNotificationForeground()
        ))
    }

    @Test("Badge counts the distinct union of known needs-you and attention tasks")
    func badgeProjection() throws {
        let needsYou = try notificationTask(id: "task-a", status: "user-questions")
        let waiting = try notificationTask(id: "task-b", status: "in-progress")
        let completed = try notificationTask(id: "task-c", status: "completed")

        #expect(NativeNotificationPolicy.badgeCount(
            tasks: [needsYou, waiting, completed],
            attentionTaskIDs: ["task-a", "task-b", "unknown"]
        ) == 2)
        #expect(NativeNotificationPolicy.badgeCount(
            tasks: [needsYou],
            attentionTaskIDs: ["task-a"]
        ) == 1)
    }

    @Test("Deep links require both trimmed identifiers")
    func deepLinkProjection() {
        #expect(
            NativeNotificationPolicy.deepLink(userInfo: [
                NativeNotificationPolicy.serverIDKey: " server ",
                NativeNotificationPolicy.projectIDKey: " project ",
                NativeNotificationPolicy.taskIDKey: " task "
            ]) == NativeNotificationDeepLink(
                serverID: "server",
                projectID: "project",
                taskID: "task"
            )
        )
        #expect(NativeNotificationPolicy.deepLink(userInfo: [
            NativeNotificationPolicy.taskIDKey: "task"
        ]) == nil)
        #expect(NativeNotificationPolicy.deepLink(userInfo: [
            NativeNotificationPolicy.projectIDKey: "project",
            NativeNotificationPolicy.taskIDKey: "   "
        ]) == nil)
    }

    @Test("UserDefaults state persists preferences and a cold-launch tap")
    func userDefaultsPersistence() throws {
        let suiteName = "NotificationPolicyTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsNotificationStateStore(defaults: defaults)
        var preferences = NativeNotificationPreferences()
        preferences.webNotificationsEnabled = false
        preferences.hapticsEnabled = false
        let deepLink = NativeNotificationDeepLink(
            serverID: "server",
            projectID: "project",
            taskID: "task"
        )

        store.savePreferences(preferences)
        store.savePendingDeepLink(deepLink)

        let restored = UserDefaultsNotificationStateStore(defaults: defaults)
        #expect(restored.loadPreferences() == preferences)
        #expect(restored.loadPendingDeepLink() == deepLink)
        restored.savePendingDeepLink(nil)
        #expect(restored.loadPendingDeepLink() == nil)
    }
}
