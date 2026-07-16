import Dev3Kit
import SwiftUI

public struct WorkQueueView: View {
    private let projects: [Dev3Project]
    private let tasks: [Dev3Task]
    private let prStatusByTask: [String: TaskPRStatusPush]
    private let mutationsEnabled: Bool
    private let actions: (Dev3Task) -> TaskCardActions
    private let onRefresh: () async -> Void

    @Environment(\.colorScheme) private var colorScheme

    public init(
        projects: [Dev3Project],
        tasks: [Dev3Task],
        prStatusByTask: [String: TaskPRStatusPush] = [:],
        mutationsEnabled: Bool = true,
        actions: @escaping (Dev3Task) -> TaskCardActions,
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.projects = projects
        self.tasks = tasks
        self.prStatusByTask = prStatusByTask
        self.mutationsEnabled = mutationsEnabled
        self.actions = actions
        self.onRefresh = onRefresh
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if tiers.isEmpty {
                    emptyState
                } else {
                    ForEach(tiers) { tier in
                        readinessSection(tier)
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await onRefresh() }
        .background(palette.surfaceBase)
        .navigationTitle("Work")
        .accessibilityIdentifier("work-readiness-queue")
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    private var tiers: [ReadinessTier] {
        TaskReadiness.tiers(tasks: tasks, projects: projects)
    }

    private var projectsByID: [String: Dev3Project] {
        Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "Nothing active",
            systemImage: "checkmark.circle",
            description: Text("Tasks that need you or are waiting on agents will appear here.")
        )
        .foregroundStyle(palette.textSecondary)
        .accessibilityIdentifier("work-readiness-empty")
    }

    private func readinessSection(_ tier: ReadinessTier) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Circle()
                    .fill(tierColor(tier))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(tier.title.uppercased())
                    .font(.caption.bold())
                    .tracking(0.7)
                    .foregroundStyle(palette.textSecondary)
                Text("\(tier.tasks.count)")
                    .font(.caption2.bold().monospacedDigit())
                    .foregroundStyle(palette.textTertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(palette.surfaceElevated, in: Capsule())
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(tier.title), \(tier.tasks.count) tasks")
            .accessibilityIdentifier("work-tier-\(tier.id)")

            ForEach(tier.tasks) { task in
                NativeTaskCard(
                    task: task,
                    labels: labels(for: task),
                    customColumns: projectsByID[task.projectId]?.customColumns ?? [],
                    variantSummary: TaskVariantSummary.resolve(task: task, among: tasks),
                    prStatus: prStatusByTask[task.id],
                    surface: .solid,
                    mutationsEnabled: mutationsEnabled,
                    actions: actions(task)
                )
            }
        }
    }

    private func labels(for task: Dev3Task) -> [Dev3Label] {
        guard let project = projectsByID[task.projectId] else { return [] }
        let labelsByID = Dictionary(uniqueKeysWithValues: (project.labels ?? []).map { ($0.id, $0) })
        return (task.labelIds ?? []).compactMap { labelsByID[$0] }
    }

    private func tierColor(_ tier: ReadinessTier) -> Color {
        if let color = tier.color, let resolved = Color(dev3Hex: color) {
            return resolved
        }
        switch tier.kind {
        case .needsYou:
            return palette.accent
        case .custom:
            return palette.textTertiary
        case .waiting:
            return palette.warning
        }
    }
}
