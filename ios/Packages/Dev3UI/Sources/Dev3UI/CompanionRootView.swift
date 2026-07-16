import Dev3Kit
import SwiftUI

public typealias TaskDestinationBuilder = @MainActor (_ projectID: String, _ taskID: String) -> AnyView
public typealias TaskInfoAction = @MainActor (_ projectID: String, _ taskID: String) -> Void
public typealias NewTaskAction = @MainActor (_ projectID: String?) -> Void
public typealias RunTodoTaskAction = @MainActor (_ task: Dev3Task) -> Void
public typealias SettingsAccessoryBuilder = @MainActor () -> AnyView

@MainActor
public struct CompanionRootView: View {
    @Bindable private var store: AppStore
    private let taskDestinationBuilder: TaskDestinationBuilder
    private let onOpenTaskInfo: TaskInfoAction
    private let onCreateTask: NewTaskAction
    private let onRunTodoTask: RunTodoTaskAction
    private let settingsAccessoryBuilder: SettingsAccessoryBuilder
    @State private var showsPairing = false

    public init(
        store: AppStore,
        taskDestinationBuilder: @escaping TaskDestinationBuilder = { _, _ in
            AnyView(ContentUnavailableView("Terminal unavailable", systemImage: "terminal"))
        },
        onOpenTaskInfo: @escaping TaskInfoAction = { _, _ in },
        onCreateTask: @escaping NewTaskAction = { _ in },
        onRunTodoTask: @escaping RunTodoTaskAction = { _ in },
        settingsAccessoryBuilder: @escaping SettingsAccessoryBuilder = {
            AnyView(EmptyView())
        }
    ) {
        self.store = store
        self.taskDestinationBuilder = taskDestinationBuilder
        self.onOpenTaskInfo = onOpenTaskInfo
        self.onCreateTask = onCreateTask
        self.onRunTodoTask = onRunTodoTask
        self.settingsAccessoryBuilder = settingsAccessoryBuilder
    }

    public var body: some View {
        Group {
            if shouldShowConnectedShell {
                ConnectedShellView(
                    store: store,
                    taskDestinationBuilder: taskDestinationBuilder,
                    onOpenTaskInfo: onOpenTaskInfo,
                    onCreateTask: onCreateTask,
                    onRunTodoTask: onRunTodoTask,
                    settingsAccessoryBuilder: settingsAccessoryBuilder,
                    onPairAnother: { showsPairing = true }
                )
            } else {
                PairingHomeView(
                    controller: store.controller,
                    canCancel: store.controller.activeServer != nil && !store.shouldShowPairing,
                    onCancel: { showsPairing = false }
                )
            }
        }
        .onChange(of: store.controller.sessionState) { _, state in
            if state == .connected {
                showsPairing = false
            }
        }
    }

    private var shouldShowConnectedShell: Bool {
        !store.shouldShowPairing && !showsPairing
    }
}

@MainActor
private struct ConnectedShellView: View {
    @Bindable var store: AppStore
    let taskDestinationBuilder: TaskDestinationBuilder
    let onOpenTaskInfo: TaskInfoAction
    let onCreateTask: NewTaskAction
    let onRunTodoTask: RunTodoTaskAction
    let settingsAccessoryBuilder: SettingsAccessoryBuilder
    let onPairAnother: () -> Void
    @State private var variantSelection: VariantSelection?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TabView(selection: $store.selectedTab) {
            NavigationStack(path: $store.workPath) {
                WorkOverview(
                    store: store,
                    actions: { task in taskActions(task, origin: .work) },
                    onCreateTask: { onCreateTask(nil) }
                )
                .navigationTitle("Work")
                .navigationDestination(for: AppRoute.self) { route in
                    destination(route, origin: .work)
                }
            }
            .tabItem {
                Label("Work", systemImage: "rectangle.3.group.fill")
            }
            .tag(AppTab.work)
            .accessibilityIdentifier("connected.tab.work")

            NavigationStack(path: $store.projectsPath) {
                ProjectsOverview(store: store)
                    .navigationTitle("Projects")
                    .navigationDestination(for: AppRoute.self) { route in
                        destination(route, origin: .projects)
                    }
            }
            .tabItem {
                Label("Projects", systemImage: "folder.fill")
            }
            .tag(AppTab.projects)
            .accessibilityIdentifier("connected.tab.projects")

            NavigationStack(path: $store.settingsPath) {
                ServerSettingsView(
                    controller: store.controller,
                    settingsAccessoryBuilder: settingsAccessoryBuilder,
                    onPairAnother: onPairAnother
                )
                .navigationTitle("Settings")
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .tag(AppTab.settings)
            .accessibilityIdentifier("connected.tab.settings")
        }
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                if let banner = store.banner {
                    ConnectionBannerView(banner: banner)
                        .accessibilityIdentifier("connected.banner")
                }
                if let toast = store.toast {
                    ToastView(toast: toast) {
                        store.dismissToast()
                    }
                    .accessibilityIdentifier("connected.toast")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .animation(reduceMotion ? nil : .snappy, value: store.banner)
        .animation(reduceMotion ? nil : .snappy, value: store.toast?.id)
        .sheet(item: $variantSelection) { selected in
            TaskVariantPicker(
                selected: selected,
                tasks: store.tasksByProject[selected.projectID] ?? [],
                onOpen: { task in
                    store.openTask(projectId: task.projectId, taskId: task.id, from: store.selectedTab)
                }
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connected.shell")
    }

    @ViewBuilder
    private func destination(_ route: AppRoute, origin: AppTab) -> some View {
        switch route {
        case let .task(projectID, taskID):
            TaskDestinationContext(
                store: store,
                projectID: projectID,
                taskID: taskID,
                destinationBuilder: taskDestinationBuilder
            )
        case let .project(projectID):
            if let project = store.project(id: projectID) {
                ProjectBoardOverview(
                    store: store,
                    project: project,
                    actions: { task in taskActions(task, origin: origin) },
                    onCreateTask: { onCreateTask(project.id) }
                )
            } else {
                ContentUnavailableView("Project unavailable", systemImage: "folder.badge.questionmark")
            }
        }
    }

    private func taskActions(_ task: Dev3Task, origin: AppTab) -> TaskCardActions {
        TaskCardActions(
            open: {
                switch CompanionTaskOpenRoute.resolve(task: task, isConnected: store.isConnected) {
                case .run:
                    onRunTodoTask(task)
                case .terminal:
                    store.openTask(projectId: task.projectId, taskId: task.id, from: origin)
                case .info:
                    onOpenTaskInfo(task.projectId, task.id)
                }
            },
            move: { status in
                Task { await store.moveTask(task, to: status) }
            },
            moveToCustomColumn: { columnID in
                Task { await store.moveTask(task, toCustomColumn: columnID) }
            },
            setPriority: { priority in
                Task { await store.setTaskPriority(task, priority: priority) }
            },
            toggleWatch: {
                Task { await store.toggleTaskWatch(task) }
            },
            openInfo: {
                onOpenTaskInfo(task.projectId, task.id)
            },
            showVariants: {
                variantSelection = VariantSelection(projectID: task.projectId, taskID: task.id)
            },
            run: {
                onRunTodoTask(task)
            }
        )
    }
}

enum CompanionTaskOpenRoute: Equatable, Sendable {
    case run
    case terminal
    case info

    static func resolve(task: Dev3Task, isConnected: Bool) -> CompanionTaskOpenRoute {
        guard isConnected else { return .info }
        if task.status == .todo {
            return .run
        }
        return .terminal
    }
}

@MainActor
private struct ConnectionBannerView: View {
    let banner: ConnectionBanner
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Dev3Theme.palette(for: colorScheme)
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(palette.textPrimary)
            Text(banner.message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(palette.surfaceRaised, in: Capsule())
        .overlay {
            Capsule().stroke(palette.borderDefault)
        }
    }
}

@MainActor
private struct ToastView: View {
    let toast: AppToast
    let onDismiss: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Dev3Theme.palette(for: colorScheme)
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(accent(palette))
                .accessibilityHidden(true)
            Text(toast.message)
                .font(.subheadline)
                .foregroundStyle(palette.textPrimary)
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.textSecondary)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(palette.borderDefault)
        }
    }

    // SwiftFormat's configured compact-case style conflicts with this opt-in lint rule.
    // swiftlint:disable switch_case_on_newline
    private var icon: String {
        switch toast.level {
        case .info: "info.circle.fill"
        case .success: "checkmark.circle.fill"
        case .error: "exclamationmark.triangle.fill"
        }
    }

    private func accent(_ palette: Dev3ThemePalette) -> Color {
        switch toast.level {
        case .info: palette.accent
        case .success: palette.success
        case .error: palette.danger
        }
    }
    // swiftlint:enable switch_case_on_newline
}

@MainActor
private struct ServerSettingsView: View {
    let controller: ConnectionController
    let settingsAccessoryBuilder: SettingsAccessoryBuilder
    let onPairAnother: () -> Void

    var body: some View {
        Form {
            Section("Active instance") {
                LabeledContent("Name", value: controller.activeServer?.name ?? "None")
                LabeledContent("Status", value: controller.sessionState.rawValue.capitalized)
            }

            Section("Saved instances") {
                ForEach(controller.savedServers) { server in
                    ServerSettingsRow(controller: controller, server: server)
                }
            }

            settingsAccessoryBuilder()

            Section {
                Button("Pair another instance", action: onPairAnother)
                    .accessibilityIdentifier("settings.pairAnother")
            }
        }
    }
}

@MainActor
private struct ServerSettingsRow: View {
    let controller: ConnectionController
    let server: PairedServer

    var body: some View {
        HStack {
            Button {
                Task { await controller.connect(to: server) }
            } label: {
                VStack(alignment: .leading) {
                    Text(server.name)
                    Text(server.origin.host ?? server.origin.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.server.\(server.instanceId)")
            Spacer()
            if server.instanceId == controller.activeServer?.instanceId {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Active")
            }
            Button(role: .destructive) {
                Task { await controller.delete(server) }
            } label: {
                Image(systemName: "trash")
            }
            .accessibilityLabel("Delete \(server.name)")
            .accessibilityIdentifier("settings.delete.\(server.instanceId)")
        }
    }
}
