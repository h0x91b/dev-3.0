import Dev3Kit
import SwiftUI

@MainActor
public struct CompanionRootView: View {
    @Bindable private var store: AppStore
    @State private var showsPairing = false

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        Group {
            if shouldShowConnectedShell {
                ConnectedShellView(store: store) {
                    showsPairing = true
                }
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
    let onPairAnother: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TabView(selection: $store.selectedTab) {
            NavigationStack(path: $store.workPath) {
                WorkOverview(store: store)
                    .navigationTitle("Work")
            }
            .tabItem {
                Label("Work", systemImage: "rectangle.3.group.fill")
            }
            .tag(AppTab.work)
            .accessibilityIdentifier("connected.tab.work")

            NavigationStack(path: $store.projectsPath) {
                ProjectsOverview(store: store)
                    .navigationTitle("Projects")
            }
            .tabItem {
                Label("Projects", systemImage: "folder.fill")
            }
            .tag(AppTab.projects)
            .accessibilityIdentifier("connected.tab.projects")

            NavigationStack(path: $store.settingsPath) {
                ServerSettingsView(controller: store.controller, onPairAnother: onPairAnother)
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connected.shell")
    }
}

@MainActor
private struct WorkOverview: View {
    @Bindable var store: AppStore
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    private var attentionTasks: [Dev3Task] {
        store.tasksByProject.values.flatMap(\.self).filter { task in
            task.status == .userQuestions ||
                task.status == .reviewByUser ||
                task.status == .reviewByColleague
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Image(systemName: statusIcon)
                        .foregroundStyle(statusColor)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusTitle)
                            .font(.headline)
                            .accessibilityIdentifier("connected.status")
                        Text(store.controller.activeServer?.name ?? "dev3")
                            .font(.subheadline)
                            .foregroundStyle(palette.textSecondary)
                            .accessibilityIdentifier("connected.serverName")
                    }
                    Spacer()
                }
                .padding(18)
                .background(palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(palette.borderDefault)
                }

                workState
                    .frame(maxWidth: .infinity, minHeight: 320)
            }
            .padding(20)
        }
        .background(palette.surfaceBase)
    }

    @ViewBuilder
    private var workState: some View {
        if store.isInitialLoading {
            ProgressView("Loading work…")
                .accessibilityIdentifier("work.loading")
        } else if attentionTasks.isEmpty {
            ContentUnavailableView(
                "No work needs attention",
                systemImage: "checkmark.circle",
                description: Text("Tasks waiting for you across every project will appear here.")
            )
            .accessibilityIdentifier("work.empty")
        } else {
            ContentUnavailableView(
                "\(attentionTasks.count) task\(attentionTasks.count == 1 ? "" : "s") need attention",
                systemImage: "person.crop.circle.badge.exclamationmark",
                description: Text("The cross-project Work queue is synchronized and ready.")
            )
            .accessibilityIdentifier("work.ready")
        }
    }

    private var statusTitle: String {
        switch store.controller.sessionState {
        case .connected:
            "Connected to dev3"
        case .authenticating, .connecting:
            "Connecting to dev3"
        case .reconnecting:
            "Reconnecting to dev3"
        case .idle, .expired:
            "dev3 is offline"
        }
    }

    private var statusIcon: String {
        store.controller.sessionState == .connected ?
            "link.circle.fill" : "arrow.triangle.2.circlepath.circle.fill"
    }

    private var statusColor: Color {
        store.controller.sessionState == .connected ? palette.success : palette.warning
    }
}

@MainActor
private struct ProjectsOverview: View {
    @Bindable var store: AppStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if store.isInitialLoading {
                ProgressView("Loading projects…")
                    .accessibilityIdentifier("projects.loading")
            } else if store.projects.isEmpty {
                ContentUnavailableView(
                    "No projects",
                    systemImage: "folder",
                    description: Text("Projects added to the connected dev3 instance will appear here.")
                )
                .accessibilityIdentifier("projects.empty")
            } else {
                ContentUnavailableView(
                    "\(store.projects.count) project\(store.projects.count == 1 ? "" : "s") synced",
                    systemImage: "folder.badge.checkmark",
                    description: Text("Project boards remain separate from the cross-project Work queue.")
                )
                .accessibilityIdentifier("projects.ready")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Dev3Theme.palette(for: colorScheme).surfaceBase)
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
