import Dev3Kit
import SwiftUI

public struct ProjectsDashboardView: View {
    private let items: [ProjectDashboardItem]
    private let pullStates: [String: ProjectPullState]
    private let mutationsEnabled: Bool
    private let onOpenProject: (String) -> Void
    private let onPullMain: (String) -> Void
    private let onRefresh: () async -> Void

    @Environment(\.colorScheme) private var colorScheme

    public init(
        items: [ProjectDashboardItem],
        pullStates: [String: ProjectPullState] = [:],
        mutationsEnabled: Bool = true,
        onOpenProject: @escaping (String) -> Void,
        onPullMain: @escaping (String) -> Void,
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.items = items
        self.pullStates = pullStates
        self.mutationsEnabled = mutationsEnabled
        self.onOpenProject = onOpenProject
        self.onPullMain = onPullMain
        self.onRefresh = onRefresh
    }

    public var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if items.isEmpty {
                    emptyState
                } else {
                    ForEach(items) { item in
                        projectRow(item)
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await onRefresh() }
        .background(palette.surfaceBase)
        .navigationTitle("Projects")
        .accessibilityIdentifier("projects-dashboard")
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No projects",
            systemImage: "folder",
            description: Text("Pair with a dev3 server that has at least one project.")
        )
        .foregroundStyle(palette.textSecondary)
        .accessibilityIdentifier("projects-dashboard-empty")
    }

    private func projectRow(_ item: ProjectDashboardItem) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    onOpenProject(item.id)
                } label: {
                    projectIdentity(item)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if item.supportsGitActions {
                    pullButton(item)
                }
            }
            .padding(14)

            if let result = pullResult(item) {
                Divider().overlay(palette.borderDefault)
                Text(result.message)
                    .font(.caption)
                    .foregroundStyle(result.isError ? palette.danger : palette.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .accessibilityIdentifier("project-pull-result-\(item.id)")
            }
        }
        .background(palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(palette.borderDefault)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-row-\(item.id)")
    }

    private func projectIdentity(_ item: ProjectDashboardItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.project.kind == .virtual ? "terminal" : "folder")
                .font(.headline)
                .foregroundStyle(palette.accent)
                .frame(width: 36, height: 36)
                .background(palette.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(item.project.name)
                        .font(.headline)
                        .foregroundStyle(palette.textPrimary)
                        .lineLimit(1)
                    if item.project.kind == .virtual {
                        Text(item.project.builtin == true ? "SYSTEM" : "OPS")
                            .font(.caption2.bold())
                            .foregroundStyle(palette.textTertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(palette.surfaceElevated, in: Capsule())
                    }
                }
                projectSummary(item)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(projectAccessibilityLabel(item))
        .accessibilityHint("Opens the project board")
    }

    private func projectSummary(_ item: ProjectDashboardItem) -> some View {
        HStack(spacing: 8) {
            Label("\(item.activeTaskCount) active", systemImage: "bolt.fill")
            if item.attentionTaskCount > 0 {
                Label("\(item.attentionTaskCount) need you", systemImage: "bell.fill")
                    .foregroundStyle(palette.accent)
            }
            if let lastActivity = item.lastActivity {
                Text(lastActivity, format: .relative(presentation: .named))
            }
        }
        .font(.caption)
        .foregroundStyle(palette.textTertiary)
        .lineLimit(1)
    }

    private func pullButton(_ item: ProjectDashboardItem) -> some View {
        let isPulling = pullStates[item.id] == .pulling
        return Button {
            onPullMain(item.id)
        } label: {
            Group {
                if isPulling {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.down.circle")
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(palette.accent)
        .background(palette.surfaceElevated, in: RoundedRectangle(cornerRadius: 12))
        .disabled(isPulling || !mutationsEnabled)
        .accessibilityLabel(pullAccessibilityLabel(isPulling: isPulling))
        .accessibilityIdentifier("project-pull-main-\(item.id)")
    }

    private func pullResult(_ item: ProjectDashboardItem) -> (message: String, isError: Bool)? {
        switch pullStates[item.id] ?? .idle {
        case .idle, .pulling:
            nil
        case let .succeeded(message):
            (message, false)
        case let .failed(message):
            (message, true)
        }
    }

    private func projectAccessibilityLabel(_ item: ProjectDashboardItem) -> String {
        var parts = [item.project.name, "\(item.activeTaskCount) active tasks"]
        if item.attentionTaskCount > 0 {
            parts.append("\(item.attentionTaskCount) need you")
        }
        return parts.joined(separator: ", ")
    }

    private func pullAccessibilityLabel(isPulling: Bool) -> String {
        if isPulling {
            return "Pulling main"
        }
        return mutationsEnabled ? "Pull main" : "Pull main unavailable while disconnected"
    }
}
