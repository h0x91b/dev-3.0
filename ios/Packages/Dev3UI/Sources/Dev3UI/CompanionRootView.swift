import Dev3Kit
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

public struct CompanionRootView: View {
    @State private var connectionState = ConnectionState.pairing

    public init() {}

    public var body: some View {
        Group {
            switch connectionState {
            case .pairing:
                PairingView {
                    withAnimation(.snappy) {
                        connectionState = .connected
                    }
                }
            case .connected:
                ConnectedShellView {
                    withAnimation(.snappy) {
                        connectionState = .pairing
                    }
                }
            }
        }
        .tint(.accentColor)
    }
}

private struct PairingView: View {
    let onPair: () -> Void

    var body: some View {
        ZStack {
            Color.dev3Background
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 44)
                    BrandMark()

                    VStack(spacing: 12) {
                        Text("Your agents, in your pocket.")
                            .font(.largeTitle.bold())
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)

                        Text("Pair this iPhone with a dev3 server to keep work moving wherever you are.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    VStack(spacing: 12) {
                        Button(action: onPair) {
                            Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("pairing.primaryAction")
                        .accessibilityHint("Opens the connected shell preview in this scaffold")

                        Button("Enter address manually") {}
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("pairing.manualAction")
                            .accessibilityHint("Manual pairing arrives in a later implementation wave")
                    }

                    Text("Session credentials stay on this device")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 24)
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pairing.screen")
    }
}

private struct BrandMark: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 88, height: 88)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .accessibilityHidden(true)

            Text("dev3")
                .font(.custom("JetBrainsMono Nerd Font Mono", size: 28).weight(.bold))
                .accessibilityLabel("dev three")
        }
    }
}

private struct ConnectedShellView: View {
    let onDisconnect: () -> Void

    var body: some View {
        TabView {
            NavigationStack {
                WorkPlaceholder()
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
                SettingsPlaceholder(onDisconnect: onDisconnect)
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

private struct WorkPlaceholder: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    Image(systemName: "link.circle.fill")
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connected to dev3")
                            .font(.headline)
                        Text(CompanionServer.preview.name)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(18)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                ContentUnavailableView(
                    "Ready for the next wave",
                    systemImage: "sparkles",
                    description: Text("Tasks needing attention and waiting agents will appear here.")
                )
                .frame(maxWidth: .infinity, minHeight: 320)
            }
            .padding(20)
        }
        .background(Color.dev3Background)
    }
}

private struct ProjectsPlaceholder: View {
    var body: some View {
        ContentUnavailableView(
            "No projects loaded yet",
            systemImage: "folder.badge.plus",
            description: Text("Project sync is part of the next implementation wave.")
        )
        .background(Color.dev3Background)
    }
}

private struct SettingsPlaceholder: View {
    let onDisconnect: () -> Void

    var body: some View {
        Form {
            Section("Server") {
                LabeledContent("Name", value: CompanionServer.preview.name)
                LabeledContent("Transport", value: "Remote session")
            }

            Section {
                Button("Return to pairing", role: .destructive, action: onDisconnect)
                    .accessibilityIdentifier("connected.disconnectAction")
            }
        }
    }
}

private extension Color {
    static var dev3Background: Color {
        #if canImport(UIKit)
            Color(uiColor: .systemBackground)
        #elseif canImport(AppKit)
            Color(nsColor: .windowBackgroundColor)
        #else
            Color.clear
        #endif
    }
}

#Preview("Pairing") {
    CompanionRootView()
}
