import Dev3Kit
import Dev3UI
import Foundation
import Observation

// Notification state, delivery serialization, and identity validation stay in one coordinator.
// swiftlint:disable file_length

@MainActor
@Observable
final class NativeNotificationCoordinator {
    private(set) var preferences: NativeNotificationPreferences
    private(set) var authorization = NativeNotificationAuthorization.notDetermined
    private(set) var badgeCount = 0
    private(set) var deepLinkRequest: NativeNotificationDeepLink?
    private(set) var lastDeliveryError: String?

    @ObservationIgnored private var service: any NativeNotificationServicing
    @ObservationIgnored private let stateStore: any NativeNotificationStateStoring
    @ObservationIgnored private var activeServerID: String?
    @ObservationIgnored private var authoritativeSnapshotServerID: String?
    @ObservationIgnored private var tasksByID: [String: Dev3Task] = [:]
    @ObservationIgnored private var attentionTaskIDs = Set<String>()
    @ObservationIgnored private var notificationTaskIDs = Set<String>()
    @ObservationIgnored private var foreground = NativeNotificationForeground()
    @ObservationIgnored private var pendingDeliveries: [String: NativeNotificationRequest] = [:]
    @ObservationIgnored private var deliveryOrder: [String] = []
    @ObservationIgnored private var pendingRemovals = Set<String>()
    @ObservationIgnored private var badgeDirty = true
    @ObservationIgnored private var hasTaskSnapshot = false
    @ObservationIgnored private var isConnected = false
    @ObservationIgnored private var pendingDeepLink: NativeNotificationDeepLink?
    @ObservationIgnored private var serviceGeneration: UInt = 0
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false

    init(
        service: any NativeNotificationServicing,
        stateStore: any NativeNotificationStateStoring = UserDefaultsNotificationStateStore()
    ) {
        self.service = service
        self.stateStore = stateStore
        preferences = stateStore.loadPreferences()
        pendingDeepLink = stateStore.loadPendingDeepLink()
    }

    func refreshAuthorizationStatus() async {
        let generation = serviceGeneration
        let status = await service.authorizationStatus()
        guard generation == serviceGeneration, !stopped else { return }
        authorization = status
    }

    /// Settings is the sole intended caller. Startup only reads current status.
    @discardableResult
    func requestAuthorizationFromSettings() async throws -> Bool {
        let generation = serviceGeneration
        let granted = try await service.requestAuthorizationFromSettings()
        guard generation == serviceGeneration, !stopped else { return granted }
        authorization = await service.authorizationStatus()
        return granted
    }

    func updatePreferences(_ preferences: NativeNotificationPreferences) {
        let disabledCategories = NativeNotificationCategory.allCases.filter {
            self.preferences.allows($0) && !preferences.allows($0)
        }
        self.preferences = preferences
        stateStore.savePreferences(preferences)

        for category in disabledCategories {
            removePendingDeliveries(category: category)
            if let activeServerID {
                pendingRemovals.formUnion(notificationTaskIDs.map {
                    NativeNotificationPolicy.identifier(
                        serverID: activeServerID,
                        category: category,
                        taskID: $0
                    )
                })
            }
        }
        startDrainIfNeeded()
    }

    func synchronize(
        serverID: String,
        snapshotServerID: String?,
        tasks: [Dev3Task],
        attentionTaskIDs: Set<String>
    ) {
        if activeServerID != serverID {
            switchServer(to: serverID)
        }
        guard snapshotServerID == serverID else {
            refreshBadge()
            projectPendingDeepLink()
            startDrainIfNeeded()
            return
        }

        authoritativeSnapshotServerID = serverID
        hasTaskSnapshot = true
        reconcileSnapshot(
            serverID: serverID,
            tasks: tasks,
            attentionTaskIDs: attentionTaskIDs
        )
        refreshBadge()
        projectPendingDeepLink()
        startDrainIfNeeded()
    }

    /// Retires server-scoped notification state while preserving a cold-launch tap until
    /// the connection controller establishes which server should validate it.
    func clearActiveServer() {
        if let previousServerID = activeServerID {
            for taskID in notificationTaskIDs {
                pendingRemovals.formUnion(NativeNotificationPolicy.identifiers(
                    serverID: previousServerID,
                    taskID: taskID
                ))
            }
            removePendingDeliveries(serverID: previousServerID)
        }
        activeServerID = nil
        authoritativeSnapshotServerID = nil
        hasTaskSnapshot = false
        tasksByID.removeAll()
        attentionTaskIDs.removeAll()
        notificationTaskIDs.removeAll()
        deepLinkRequest = nil
        refreshBadge()
        startDrainIfNeeded()
    }

    func setConnectionReady(_ isConnected: Bool) {
        self.isConnected = isConnected
        if !isConnected {
            deepLinkRequest = nil
        }
        projectPendingDeepLink()
    }

    func setForeground(isActive: Bool, visibleTaskID: String?) {
        foreground = NativeNotificationForeground(
            isActive: isActive,
            visibleTaskID: visibleTaskID
        )
        guard isActive, let visibleTaskID else { return }
        attentionTaskIDs.remove(visibleTaskID)
        if let activeServerID {
            pendingRemovals.formUnion(NativeNotificationPolicy.identifiers(
                serverID: activeServerID,
                taskID: visibleTaskID
            ))
        }
        refreshBadge()
        startDrainIfNeeded()
    }

    func receive(_ event: RPCPushEvent) {
        switch event {
        case let .webNotification(notification):
            receive(notification)
        case let .cliAttention(attention):
            receive(attention)
        case let .terminalBell(bell):
            receiveTerminalBell(taskID: bell.taskId)
        case let .taskUpdated(update):
            receive(update)
        case let .taskRemoved(removal):
            removeTask(removal.taskId, serverID: activeServerID)
        default:
            break
        }
    }

    func handleNotificationTap(userInfo: [String: String]) {
        guard let deepLink = NativeNotificationPolicy.deepLink(userInfo: userInfo) else { return }
        pendingDeepLink = deepLink
        deepLinkRequest = nil
        stateStore.savePendingDeepLink(deepLink)
        projectPendingDeepLink()
    }

    func consumeDeepLinkRequest() -> NativeNotificationDeepLink? {
        guard let deepLinkRequest else { return nil }
        self.deepLinkRequest = nil
        pendingDeepLink = nil
        stateStore.savePendingDeepLink(nil)
        return deepLinkRequest
    }

    func rebindService(_ service: any NativeNotificationServicing) {
        serviceGeneration &+= 1
        self.service = service
        stopped = false
        lastDeliveryError = nil
        badgeDirty = true
        startDrainIfNeeded()
    }

    func stop() async {
        stopped = true
        serviceGeneration &+= 1
        drainTask?.cancel()
        if let drainTask {
            await drainTask.value
        }
    }
}

private extension NativeNotificationCoordinator {
    func receive(_ notification: WebNotificationPush) {
        guard let activeServerID else { return }
        notificationTaskIDs.insert(notification.taskId)
        guard NativeNotificationPolicy.shouldDeliver(
            category: .web,
            taskID: notification.taskId,
            preferences: preferences,
            authorization: authorization,
            foreground: foreground
        ) else { return }
        enqueue(NativeNotificationRequest(
            identifier: NativeNotificationPolicy.identifier(
                serverID: activeServerID,
                category: .web,
                taskID: notification.taskId
            ),
            category: .web,
            title: notification.title,
            body: notification.body,
            serverID: activeServerID,
            projectID: notification.projectId,
            taskID: notification.taskId,
            level: notification.level
        ))
    }

    func receive(_ attention: CLIAttentionPush) {
        let isVisible = NativeNotificationPolicy.isVisible(
            taskID: attention.taskId,
            foreground: foreground
        )
        if !isVisible {
            attentionTaskIDs.insert(attention.taskId)
        }
        refreshBadge()
        guard !isVisible, let task = tasksByID[attention.taskId] else { return }
        enqueueTaskNotification(
            category: .attention,
            task: task,
            body: attention.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Needs your attention."
                : attention.reason,
            level: .info
        )
    }

    func receiveTerminalBell(taskID: String) {
        let isVisible = NativeNotificationPolicy.isVisible(taskID: taskID, foreground: foreground)
        if !isVisible {
            attentionTaskIDs.insert(taskID)
        }
        refreshBadge()
        guard !isVisible, let task = tasksByID[taskID] else { return }
        if preferences.terminalBellNotificationsEnabled, preferences.hapticsEnabled {
            service.playTerminalBellHaptic()
        }
        enqueueTaskNotification(
            category: .terminalBell,
            task: task,
            body: "The terminal is waiting for you.",
            level: .info
        )
    }

    func receive(_ update: TaskUpdatedPush) {
        tasksByID[update.task.id] = update.task
        notificationTaskIDs.insert(update.task.id)
        refreshBadge()
        projectPendingDeepLink()
    }

    func removeTask(_ taskID: String, serverID: String?) {
        tasksByID[taskID] = nil
        attentionTaskIDs.remove(taskID)
        notificationTaskIDs.remove(taskID)
        let identifiers = serverID.map {
            NativeNotificationPolicy.identifiers(serverID: $0, taskID: taskID)
        } ?? []
        pendingRemovals.formUnion(identifiers)
        for identifier in identifiers {
            pendingDeliveries[identifier] = nil
            deliveryOrder.removeAll { $0 == identifier }
        }
        if pendingDeepLink?.taskID == taskID || deepLinkRequest?.taskID == taskID {
            pendingDeepLink = nil
            deepLinkRequest = nil
            stateStore.savePendingDeepLink(nil)
        }
        refreshBadge()
        startDrainIfNeeded()
    }

    func enqueueTaskNotification(
        category: NativeNotificationCategory,
        task: Dev3Task,
        body: String,
        level: Dev3NotificationLevel
    ) {
        guard NativeNotificationPolicy.shouldDeliver(
            category: category,
            taskID: task.id,
            preferences: preferences,
            authorization: authorization,
            foreground: foreground
        ) else { return }
        guard let activeServerID else { return }
        notificationTaskIDs.insert(task.id)
        enqueue(NativeNotificationRequest(
            identifier: NativeNotificationPolicy.identifier(
                serverID: activeServerID,
                category: category,
                taskID: task.id
            ),
            category: category,
            title: task.displayTitle,
            body: body,
            serverID: activeServerID,
            projectID: task.projectId,
            taskID: task.id,
            level: level
        ))
    }

    func enqueue(_ request: NativeNotificationRequest) {
        if pendingDeliveries[request.identifier] == nil {
            deliveryOrder.append(request.identifier)
        }
        pendingDeliveries[request.identifier] = request
        startDrainIfNeeded()
    }

    func removePendingDeliveries(category: NativeNotificationCategory) {
        let matchingRequests = pendingDeliveries.values.filter {
            $0.category == category
        }
        let identifiers = Set(matchingRequests.map(\.identifier))
        pendingDeliveries = pendingDeliveries.filter { !identifiers.contains($0.key) }
        deliveryOrder.removeAll { identifiers.contains($0) }
    }

    func removePendingDeliveries(serverID: String) {
        let matchingRequests = pendingDeliveries.values.filter {
            $0.serverID == serverID
        }
        let identifiers = Set(matchingRequests.map(\.identifier))
        pendingDeliveries = pendingDeliveries.filter { !identifiers.contains($0.key) }
        deliveryOrder.removeAll { identifiers.contains($0) }
    }

    func refreshBadge() {
        let count = NativeNotificationPolicy.badgeCount(
            tasks: tasksByID.values,
            attentionTaskIDs: attentionTaskIDs
        )
        guard count != badgeCount || badgeDirty else { return }
        badgeCount = count
        badgeDirty = true
        startDrainIfNeeded()
    }

    func projectPendingDeepLink() {
        guard let pendingDeepLink else { return }
        if let activeServerID, pendingDeepLink.serverID != activeServerID {
            clearPendingDeepLink()
            return
        }
        guard isConnected,
              hasTaskSnapshot,
              authoritativeSnapshotServerID == activeServerID else { return }
        guard let task = tasksByID[pendingDeepLink.taskID],
              task.projectId == pendingDeepLink.projectID
        else {
            clearPendingDeepLink()
            return
        }
        deepLinkRequest = pendingDeepLink
    }

    func switchServer(to serverID: String) {
        if let previousServerID = activeServerID {
            for taskID in notificationTaskIDs {
                pendingRemovals.formUnion(NativeNotificationPolicy.identifiers(
                    serverID: previousServerID,
                    taskID: taskID
                ))
            }
            removePendingDeliveries(serverID: previousServerID)
        }
        activeServerID = serverID
        authoritativeSnapshotServerID = nil
        hasTaskSnapshot = false
        tasksByID.removeAll()
        attentionTaskIDs.removeAll()
        notificationTaskIDs.removeAll()
        deepLinkRequest = nil
        projectPendingDeepLink()
    }

    func reconcileSnapshot(
        serverID: String,
        tasks: [Dev3Task],
        attentionTaskIDs: Set<String>
    ) {
        let newTasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        let removedTaskIDs = notificationTaskIDs.subtracting(newTasksByID.keys)
        for taskID in removedTaskIDs {
            removeTask(taskID, serverID: serverID)
        }
        tasksByID = newTasksByID
        self.attentionTaskIDs = attentionTaskIDs
        notificationTaskIDs = Set(newTasksByID.keys)
    }

    func clearPendingDeepLink() {
        pendingDeepLink = nil
        deepLinkRequest = nil
        stateStore.savePendingDeepLink(nil)
    }
}

private extension NativeNotificationCoordinator {
    var hasPendingOperations: Bool {
        !pendingRemovals.isEmpty || badgeDirty || !deliveryOrder.isEmpty
    }

    func startDrainIfNeeded() {
        guard !stopped, drainTask == nil, lastDeliveryError == nil, hasPendingOperations else {
            return
        }
        drainTask = Task { [weak self] in
            await self?.drainOperations()
        }
    }

    func drainOperations() async {
        defer {
            drainTask = nil
            startDrainIfNeeded()
        }

        while !stopped {
            guard await drainNextOperation() else { return }
        }
    }

    func drainNextOperation() async -> Bool {
        let generation = serviceGeneration
        let currentService = service
        if !pendingRemovals.isEmpty {
            let identifiers = pendingRemovals
            await currentService.removeNotifications(identifiers: identifiers)
            guard !stopped else { return false }
            if generation == serviceGeneration {
                pendingRemovals.subtract(identifiers)
            }
            return true
        }
        if badgeDirty {
            return await drainBadge(service: currentService, generation: generation)
        }
        return await drainDelivery(service: currentService, generation: generation)
    }

    func drainBadge(
        service: any NativeNotificationServicing,
        generation: UInt
    ) async -> Bool {
        let requestedCount = badgeCount
        do {
            try await service.setBadgeCount(requestedCount)
            guard !stopped else { return false }
            if generation == serviceGeneration, requestedCount == badgeCount {
                badgeDirty = false
            }
            return true
        } catch {
            guard !stopped else { return false }
            guard generation == serviceGeneration else { return true }
            lastDeliveryError = error.localizedDescription
            return false
        }
    }

    func drainDelivery(
        service: any NativeNotificationServicing,
        generation: UInt
    ) async -> Bool {
        guard let identifier = deliveryOrder.first,
              let request = pendingDeliveries[identifier]
        else {
            deliveryOrder.removeAll()
            return false
        }
        do {
            try await service.deliverReplacing(request)
            guard !stopped else { return false }
            let isCurrentRequest = generation == serviceGeneration &&
                pendingDeliveries[identifier] == request
            if isCurrentRequest {
                pendingDeliveries[identifier] = nil
                deliveryOrder.removeAll { $0 == identifier }
            }
            return true
        } catch {
            guard !stopped else { return false }
            guard generation == serviceGeneration else { return true }
            lastDeliveryError = error.localizedDescription
            return false
        }
    }
}

// swiftlint:enable file_length
