// The serialized suite shares realistic service/state fixtures across notification behaviors.
// swiftlint:disable file_length

@testable import dev3
import Dev3Kit
import Foundation
import Testing

@MainActor
@Suite("Native notification coordinator", .serialized)
struct NotificationCoordinatorTests {
    @Test("Authorization is requested only by the explicit Settings hook")
    func deliberateAuthorizationAndReplacement() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let stateStore = RecordingNotificationStateStore()
        let coordinator = NativeNotificationCoordinator(service: service, stateStore: stateStore)
        let first = try webNotification(title: "First", body: "Old")
        let replacement = try webNotification(title: "Second", body: "Newest")
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [],
            attentionTaskIDs: []
        )

        coordinator.receive(.webNotification(first))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(service.authorizationRequestCount == 0)
        #expect(service.deliveries.isEmpty)

        await coordinator.refreshAuthorizationStatus()
        #expect(service.authorizationRequestCount == 0)
        coordinator.receive(.webNotification(first))
        coordinator.receive(.webNotification(replacement))
        await eventually("Only the latest stable-id notification should deliver") {
            service.deliveries.count == 1
        }

        let identifier = NativeNotificationPolicy.identifier(
            serverID: "server-a",
            category: .web,
            taskID: first.taskId
        )
        #expect(service.deliveries[identifier]?.title == "Second")
        #expect(service.deliveries[identifier]?.body == "Newest")
        #expect(service.deliveryAttempts.map(\.identifier) == [identifier])
        #expect(service.deliveries[identifier]?.userInfo == [
            NativeNotificationPolicy.serverIDKey: "server-a",
            NativeNotificationPolicy.projectIDKey: "project",
            NativeNotificationPolicy.taskIDKey: "task-a"
        ])

        let granted = try await coordinator.requestAuthorizationFromSettings()
        #expect(granted)
        #expect(service.authorizationRequestCount == 1)

        var disabled = coordinator.preferences
        disabled.webNotificationsEnabled = false
        coordinator.updatePreferences(disabled)
        await eventually("Disabling a category should remove its delivered requests") {
            service.removedIdentifiers.contains(identifier)
        }
        #expect(stateStore.preferences == disabled)
        coordinator.receive(.webNotification(replacement))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(service.deliveryAttempts.count == 1)
    }

    @Test("Attention and terminal bells dedupe badges, foreground work, and haptics")
    func attentionBadgeForegroundAndHaptics() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let coordinator = NativeNotificationCoordinator(
            service: service,
            stateStore: RecordingNotificationStateStore()
        )
        let needsYou = try notificationTask(id: "task-a", status: "user-questions")
        let waiting = try notificationTask(id: "task-b", status: "in-progress")
        await coordinator.refreshAuthorizationStatus()
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [needsYou, waiting],
            attentionTaskIDs: []
        )
        await eventually("Needs-you state should set the badge") {
            service.badgeValues.last == 1
        }

        try coordinator.receive(attention(taskID: needsYou.id, reason: "Review this"))
        try coordinator.receive(terminalBell(taskID: waiting.id))
        await eventually("Distinct attention should add one badge task and two categories") {
            service.badgeValues.last == 2 && service.deliveries.count == 2
        }
        #expect(coordinator.badgeCount == 2)
        #expect(service.hapticCount == 1)

        coordinator.setForeground(isActive: true, visibleTaskID: waiting.id)
        await eventually("Visible work should clear its attention and notifications") {
            coordinator.badgeCount == 1 &&
                service.removedIdentifiers.isSuperset(
                    of: NativeNotificationPolicy.identifiers(
                        serverID: "server-a",
                        taskID: waiting.id
                    )
                )
        }
        try coordinator.receive(terminalBell(taskID: waiting.id))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(service.hapticCount == 1)
        #expect(coordinator.badgeCount == 1)

        try await verifyDisabledHapticsAndBells(
            coordinator: coordinator,
            service: service,
            taskID: waiting.id
        )
    }

    @Test("Unknown attention survives until its task update without replaying a notification")
    func unknownAttentionProjection() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let coordinator = NativeNotificationCoordinator(
            service: service,
            stateStore: RecordingNotificationStateStore()
        )
        await coordinator.refreshAuthorizationStatus()
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [],
            attentionTaskIDs: []
        )
        try coordinator.receive(attention(taskID: "late-task", reason: "Look"))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(coordinator.badgeCount == 0)
        #expect(service.deliveries.isEmpty)

        let lateTask = try notificationTask(id: "late-task", status: "in-progress")
        try coordinator.receive(taskUpdated(lateTask))
        await eventually("Retained attention should project when the task becomes known") {
            coordinator.badgeCount == 1
        }
        #expect(service.deliveries.isEmpty)
    }

    @Test("A notification tap survives cold launch and reconnect but validates task identity")
    func tapQueueAcrossColdLaunchAndReconnect() async throws {
        let stateStore = RecordingNotificationStateStore()
        let userInfo = notificationUserInfo(taskID: "task-a")
        var coordinator: NativeNotificationCoordinator? = NativeNotificationCoordinator(
            service: RecordingNotificationService(),
            stateStore: stateStore
        )
        coordinator?.handleNotificationTap(userInfo: userInfo)
        #expect(stateStore.pendingDeepLink != nil)
        await coordinator?.stop()
        coordinator = nil

        let restored = NativeNotificationCoordinator(
            service: RecordingNotificationService(),
            stateStore: stateStore
        )
        restored.setConnectionReady(true)
        #expect(restored.deepLinkRequest == nil)
        let task = try notificationTask(id: "task-a", status: "in-progress")
        restored.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [task],
            attentionTaskIDs: []
        )
        #expect(
            restored.deepLinkRequest ==
                NativeNotificationDeepLink(
                    serverID: "server-a",
                    projectID: "project",
                    taskID: "task-a"
                )
        )

        restored.setConnectionReady(false)
        #expect(restored.deepLinkRequest == nil)
        restored.setConnectionReady(true)
        #expect(restored.consumeDeepLinkRequest()?.taskID == "task-a")
        #expect(stateStore.pendingDeepLink == nil)

        restored.handleNotificationTap(userInfo: notificationUserInfo(taskID: "unknown"))
        #expect(restored.deepLinkRequest == nil)
        #expect(stateStore.pendingDeepLink == nil)

        restored.handleNotificationTap(userInfo: userInfo)
        #expect(restored.deepLinkRequest?.taskID == "task-a")
        try restored.receive(taskRemoved(taskID: "task-a"))
        #expect(restored.deepLinkRequest == nil)
        #expect(restored.consumeDeepLinkRequest() == nil)
    }

    @Test("Stop retains interrupted delivery and rebind resumes without push replay")
    func stopAndRebind() async throws {
        let slowService = RecordingNotificationService(
            authorization: .authorized,
            suspendDeliveries: true
        )
        let reboundService = RecordingNotificationService(authorization: .authorized)
        let coordinator = NativeNotificationCoordinator(
            service: slowService,
            stateStore: RecordingNotificationStateStore()
        )
        await coordinator.refreshAuthorizationStatus()
        try coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [notificationTask(id: "task-a", status: "user-questions")],
            attentionTaskIDs: []
        )
        try coordinator.receive(.webNotification(webNotification(title: "Ready", body: "Open")))
        await eventually("The old service should begin delivery") {
            slowService.deliveryAttempts.count == 1
        }

        await coordinator.stop()
        coordinator.rebindService(reboundService)
        await eventually("The rebound service should receive retained badge and notification state") {
            reboundService.deliveryAttempts.count == 1 && reboundService.badgeValues.last == 1
        }
        #expect(
            reboundService.deliveryAttempts.first?.identifier ==
                slowService.deliveryAttempts.first?.identifier
        )
        #expect(reboundService.deliveries.count == 1)
    }
}

extension NotificationCoordinatorTests {
    @Test("Clearing the active server retires its state but retains a cold tap for identity")
    func clearActiveServerRetainsColdTap() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let stateStore = RecordingNotificationStateStore()
        let coordinator = NativeNotificationCoordinator(service: service, stateStore: stateStore)
        let task = try notificationTask(id: "task-a", status: "user-questions")
        await coordinator.refreshAuthorizationStatus()
        coordinator.setConnectionReady(true)
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [task],
            attentionTaskIDs: []
        )
        coordinator.handleNotificationTap(userInfo: notificationUserInfo(taskID: task.id))
        #expect(coordinator.deepLinkRequest?.taskID == task.id)

        coordinator.clearActiveServer()
        await eventually("Clearing a server should retire its task notifications and badge") {
            coordinator.badgeCount == 0 && service.removedIdentifiers.isSuperset(
                of: NativeNotificationPolicy.identifiers(serverID: "server-a", taskID: task.id)
            )
        }
        #expect(coordinator.deepLinkRequest == nil)
        #expect(stateStore.pendingDeepLink?.serverID == "server-a")

        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [task],
            attentionTaskIDs: []
        )
        #expect(coordinator.deepLinkRequest?.taskID == task.id)
    }

    @Test("Authoritative snapshots remove absent task notifications while reconnect retains state")
    func authoritativeSnapshotReconciliation() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let coordinator = NativeNotificationCoordinator(
            service: service,
            stateStore: RecordingNotificationStateStore()
        )
        let first = try notificationTask(id: "task-a", status: "in-progress")
        let removed = try notificationTask(id: "task-b", status: "in-progress")
        await coordinator.refreshAuthorizationStatus()
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [first, removed],
            attentionTaskIDs: [removed.id]
        )
        try coordinator.receive(attention(taskID: removed.id, reason: "Review"))
        await eventually("The removed task notification should first be delivered") {
            service.deliveries.count == 1 && coordinator.badgeCount == 1
        }

        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [first],
            attentionTaskIDs: []
        )
        await eventually("The authoritative snapshot should remove absent task state") {
            coordinator.badgeCount == 0 && service.removedIdentifiers.isSuperset(
                of: NativeNotificationPolicy.identifiers(serverID: "server-a", taskID: removed.id)
            )
        }

        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: nil,
            tasks: [],
            attentionTaskIDs: []
        )
        try coordinator.receive(attention(taskID: first.id, reason: "Still retained"))
        await eventually("A same-server reconnect should retain the authoritative task") {
            coordinator.badgeCount == 1 && service.deliveries.values.contains {
                $0.taskID == first.id && $0.category == .attention
            }
        }
    }

    @Test("Server switching namespaces notifications and rejects an old-server tap")
    func serverSwitchIdentity() async throws {
        let service = RecordingNotificationService(authorization: .authorized)
        let stateStore = RecordingNotificationStateStore()
        let coordinator = NativeNotificationCoordinator(service: service, stateStore: stateStore)
        let task = try notificationTask(id: "task-a", status: "in-progress")
        await coordinator.refreshAuthorizationStatus()
        coordinator.setConnectionReady(true)
        coordinator.synchronize(
            serverID: "server-a",
            snapshotServerID: "server-a",
            tasks: [task],
            attentionTaskIDs: []
        )
        coordinator.handleNotificationTap(userInfo: notificationUserInfo(taskID: task.id))
        #expect(coordinator.deepLinkRequest?.serverID == "server-a")

        coordinator.synchronize(
            serverID: "server-b",
            snapshotServerID: "server-b",
            tasks: [task],
            attentionTaskIDs: []
        )
        #expect(coordinator.deepLinkRequest == nil)
        #expect(stateStore.pendingDeepLink == nil)
        coordinator.handleNotificationTap(userInfo: notificationUserInfo(taskID: task.id))
        #expect(coordinator.deepLinkRequest == nil)
        #expect(stateStore.pendingDeepLink == nil)

        try coordinator.receive(.webNotification(webNotification(title: "B", body: "Current")))
        await eventually("The new server should receive its own stable identifier") {
            service.deliveryAttempts.contains {
                $0.identifier == "dev3.ios.server-b.web.task-a"
            }
        }
        #expect(service.removedIdentifiers.isSuperset(
            of: NativeNotificationPolicy.identifiers(serverID: "server-a", taskID: task.id)
        ))
    }

    private func eventually(
        _ failureMessage: String,
        condition: @MainActor () -> Bool
    ) async {
        for _ in 0 ..< 100 {
            if condition() {
                return
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record(Comment(rawValue: failureMessage))
    }

    private func verifyDisabledHapticsAndBells(
        coordinator: NativeNotificationCoordinator,
        service: RecordingNotificationService,
        taskID: String
    ) async throws {
        coordinator.setForeground(isActive: false, visibleTaskID: nil)
        var noHaptics = coordinator.preferences
        noHaptics.hapticsEnabled = false
        coordinator.updatePreferences(noHaptics)
        try coordinator.receive(terminalBell(taskID: taskID))
        await eventually("A nonvisible bell should restore task attention") {
            coordinator.badgeCount == 2
        }
        #expect(service.hapticCount == 1)

        var bellsDisabled = coordinator.preferences
        bellsDisabled.hapticsEnabled = true
        bellsDisabled.terminalBellNotificationsEnabled = false
        coordinator.updatePreferences(bellsDisabled)
        coordinator.setForeground(isActive: true, visibleTaskID: taskID)
        coordinator.setForeground(isActive: false, visibleTaskID: nil)
        let attemptsBeforeDisabledBell = service.deliveryAttempts.count
        try coordinator.receive(terminalBell(taskID: taskID))
        try? await Task.sleep(for: .milliseconds(20))
        #expect(service.hapticCount == 1)
        #expect(service.deliveryAttempts.count == attemptsBeforeDisabledBell)
    }

    private func webNotification(title: String, body: String) throws -> WebNotificationPush {
        try decodeNotificationFixture(#"""
        {
          "taskId":"task-a","projectId":"project","title":"\#(title)","body":"\#(body)",
          "level":"info","taskSeq":1,"taskTitle":"Task A","projectName":"Project"
        }
        """#, as: WebNotificationPush.self)
    }

    private func attention(taskID: String, reason: String) throws -> RPCPushEvent {
        try .cliAttention(decodeNotificationFixture(#"""
        {"taskId":"\#(taskID)","reason":"\#(reason)"}
        """#, as: CLIAttentionPush.self))
    }

    private func terminalBell(taskID: String) throws -> RPCPushEvent {
        try .terminalBell(decodeNotificationFixture(#"""
        {"taskId":"\#(taskID)"}
        """#, as: TaskIdentifierPush.self))
    }

    private func taskUpdated(_ task: Dev3Task) throws -> RPCPushEvent {
        let taskData = try JSONEncoder().encode(task)
        let taskJSON = try #require(String(data: taskData, encoding: .utf8))
        return try .taskUpdated(decodeNotificationFixture(#"""
        {"projectId":"project","task":\#(taskJSON)}
        """#, as: TaskUpdatedPush.self))
    }

    private func taskRemoved(taskID: String) throws -> RPCPushEvent {
        try .taskRemoved(decodeNotificationFixture(#"""
        {"projectId":"project","taskId":"\#(taskID)"}
        """#, as: TaskRemovedPush.self))
    }
}

@MainActor
private final class RecordingNotificationService: NativeNotificationServicing {
    var authorization: NativeNotificationAuthorization
    private(set) var authorizationStatusCount = 0
    private(set) var authorizationRequestCount = 0
    private(set) var deliveries: [String: NativeNotificationRequest] = [:]
    private(set) var deliveryAttempts: [NativeNotificationRequest] = []
    private(set) var removedIdentifiers = Set<String>()
    private(set) var badgeValues: [Int] = []
    private(set) var hapticCount = 0
    private let suspendDeliveries: Bool

    init(
        authorization: NativeNotificationAuthorization = .notDetermined,
        suspendDeliveries: Bool = false
    ) {
        self.authorization = authorization
        self.suspendDeliveries = suspendDeliveries
    }

    func authorizationStatus() async -> NativeNotificationAuthorization {
        authorizationStatusCount += 1
        return authorization
    }

    func requestAuthorizationFromSettings() async throws -> Bool {
        authorizationRequestCount += 1
        authorization = .authorized
        return true
    }

    func deliverReplacing(_ request: NativeNotificationRequest) async throws {
        deliveryAttempts.append(request)
        if suspendDeliveries {
            try await Task.sleep(for: .seconds(60))
        }
        deliveries[request.identifier] = request
    }

    func removeNotifications(identifiers: Set<String>) async {
        removedIdentifiers.formUnion(identifiers)
        for identifier in identifiers {
            deliveries[identifier] = nil
        }
    }

    func setBadgeCount(_ count: Int) async throws {
        badgeValues.append(count)
    }

    func playTerminalBellHaptic() {
        hapticCount += 1
    }
}

private final class RecordingNotificationStateStore: NativeNotificationStateStoring {
    var preferences = NativeNotificationPreferences()
    var pendingDeepLink: NativeNotificationDeepLink?

    func loadPreferences() -> NativeNotificationPreferences {
        preferences
    }

    func savePreferences(_ preferences: NativeNotificationPreferences) {
        self.preferences = preferences
    }

    func loadPendingDeepLink() -> NativeNotificationDeepLink? {
        pendingDeepLink
    }

    func savePendingDeepLink(_ deepLink: NativeNotificationDeepLink?) {
        pendingDeepLink = deepLink
    }
}

func notificationTask(id: String, status: String) throws -> Dev3Task {
    try decodeNotificationFixture(#"""
    {
      "id":"\#(id)","seq":1,"projectId":"project","title":"\#(id)","description":"",
      "status":"\#(status)","baseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
      "updatedAt":"2026-07-16T10:00:00Z"
    }
    """#, as: Dev3Task.self)
}

func notificationUserInfo(taskID: String, serverID: String = "server-a") -> [String: String] {
    [
        NativeNotificationPolicy.serverIDKey: serverID,
        NativeNotificationPolicy.projectIDKey: "project",
        NativeNotificationPolicy.taskIDKey: taskID
    ]
}

func decodeNotificationFixture<Value: Decodable>(
    _ json: String,
    as type: Value.Type
) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}
