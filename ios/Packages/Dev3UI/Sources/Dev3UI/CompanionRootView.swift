import Dev3Kit
import SwiftUI

@MainActor
public struct CompanionRootView: View {
    private let controller: ConnectionController
    @State private var showsPairing = false

    public init(controller: ConnectionController) {
        self.controller = controller
    }

    public var body: some View {
        Group {
            if shouldShowConnectedShell {
                ConnectedShellView(controller: controller) {
                    showsPairing = true
                }
            } else {
                PairingHomeView(
                    controller: controller,
                    canCancel: controller.activeServer != nil,
                    onCancel: { showsPairing = false }
                )
            }
        }
        .onChange(of: controller.sessionState) { _, state in
            if state == .connected {
                showsPairing = false
            }
        }
    }

    private var shouldShowConnectedShell: Bool {
        controller.activeServer != nil && controller.sessionState != .expired && !showsPairing
    }
}

@MainActor
private struct ConnectedShellView: View {
    let controller: ConnectionController
    let onPairAnother: () -> Void

    var body: some View {
        TabView {
            NavigationStack {
                WorkPlaceholder(controller: controller)
                    .navigationTitle("Work")
            }
            .tabItem {
                Label("Work", systemImage: "rectangle.3.group.fill")
            }
            .accessibilityIdentifier("connected.tab.work")

            NavigationStack {
                ProjectsPlaceholder()
                    .navigationTitle("Projects")
            }
            .tabItem {
                Label("Projects", systemImage: "folder.fill")
            }
            .accessibilityIdentifier("connected.tab.projects")

            NavigationStack {
                ServerSettingsView(controller: controller, onPairAnother: onPairAnother)
                    .navigationTitle("Settings")
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .accessibilityIdentifier("connected.tab.settings")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connected.shell")
    }
}

@MainActor
private struct WorkPlaceholder: View {
    let controller: ConnectionController
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
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
                        Text(controller.activeServer?.name ?? "dev3")
                            .font(.subheadline)
                            .foregroundStyle(palette.textSecondary)
                            .accessibilityIdentifier("connected.serverName")
                    }
                    Spacer()
                }
                .padding(18)
                .background(palette.glassCard, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(palette.glassBorderCard)
                }

                ContentUnavailableView(
                    "Work queue is ready",
                    systemImage: "sparkles",
                    description: Text(
                        "Tasks needing attention and waiting agents arrive in the next implementation slice."
                    )
                )
                .frame(maxWidth: .infinity, minHeight: 320)
            }
            .padding(20)
        }
        .background(palette.surfaceBase)
    }

    private var statusTitle: String {
        switch controller.sessionState {
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
        controller.sessionState == .connected ? "link.circle.fill" : "arrow.triangle.2.circlepath.circle.fill"
    }

    private var statusColor: Color {
        controller.sessionState == .connected ? palette.success : palette.warning
    }
}

@MainActor
private struct ProjectsPlaceholder: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ContentUnavailableView(
            "Projects are next",
            systemImage: "folder.badge.gearshape",
            description: Text("Project navigation remains separate from the cross-project Work queue.")
        )
        .background(Dev3Theme.palette(for: colorScheme).surfaceBase)
    }
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
