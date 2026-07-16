import Dev3Kit
import Dev3UI
import SwiftUI

// SwiftFormat keeps simple switch cases compact.
// swiftlint:disable switch_case_on_newline

@MainActor
struct TaskPRStatusScreen: View {
    @State private var store: TaskPRStatusStore
    @Environment(\.colorScheme) private var colorScheme

    init(store: TaskPRStatusStore) {
        _store = State(initialValue: store)
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        Group {
            if let detail = store.detail {
                statusList(detail)
            } else {
                ContentUnavailableView(
                    "No pull request",
                    systemImage: "arrow.triangle.pull",
                    description: Text("This task does not have an open pull request.")
                )
            }
        }
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await store.refresh() } } label: {
                    if store.isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(!store.isConnected || store.isRefreshing)
                .accessibilityLabel(
                    store.isRefreshing ? "Refreshing pull request" : "Refresh pull request"
                )
                .accessibilityIdentifier("pr.refresh")
            }
        }
        .task { await store.refresh() }
        .accessibilityIdentifier("pr.status.screen")
    }
}

private extension TaskPRStatusScreen {
    private var navigationTitle: String {
        store.detail.map { "Pull request #\($0.number)" } ?? "Pull request"
    }

    private func statusList(_ detail: TaskPRStatusDetail) -> some View {
        List {
            if !store.isConnected {
                Section {
                    Label("Offline — showing cached status", systemImage: "wifi.slash")
                        .foregroundStyle(palette.warning)
                        .accessibilityIdentifier("pr.offline")
                }
            }
            if let errorMessage = store.errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(palette.danger)
                }
            }

            summarySection(detail)
            mergeStatusSection(detail)
            mergeBlockerSection(detail)
            checksSection(detail)
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.refresh() }
        .opacity(store.isConnected ? 1 : 0.78)
    }

    private func summarySection(_ detail: TaskPRStatusDetail) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("#\(detail.number)")
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(palette.accent)
                        if let title = detail.title, !title.isEmpty {
                            Text(title).font(.headline)
                        }
                    }
                    Spacer()
                    if detail.isDraft == true {
                        Text("DRAFT")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.warning)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(palette.warning.opacity(0.10), in: Capsule())
                    }
                }

                if let url = Dev3SafeExternalURL.parse(detail.url) {
                    Link(destination: url) {
                        Label("Open on GitHub", systemImage: "arrow.up.right.square")
                    }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("pr.open")
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func mergeStatusSection(_ detail: TaskPRStatusDetail) -> some View {
        Section("Merge status") {
            statusRow("Mergeable", value: mergeabilityLabel(detail), color: mergeabilityColor(detail))
            statusRow(
                "Auto-merge",
                value: autoMergeLabel(detail.autoMergeEnabled),
                color: detail.autoMergeEnabled == true ? palette.success : palette.textTertiary
            )
            statusRow("Review", value: reviewLabel(detail), color: reviewColor(detail))
            statusRow(
                "Review threads",
                value: unresolvedLabel(detail.unresolvedCount),
                color: (detail.unresolvedCount ?? 0) > 0 ? palette.warning : palette.textTertiary
            )
        }
    }

    @ViewBuilder
    private func mergeBlockerSection(_ detail: TaskPRStatusDetail) -> some View {
        if !detail.mergeBlockers.isEmpty {
            Section("Merge blockers") {
                ForEach(Array(detail.mergeBlockers.enumerated()), id: \.offset) { _, blocker in
                    Label(blocker.displayName, systemImage: "exclamationmark.octagon.fill")
                        .font(.subheadline)
                        .foregroundStyle(palette.danger)
                }
            }
        }
    }

    private func checksSection(_ detail: TaskPRStatusDetail) -> some View {
        Section("Checks") {
            if detail.sortedChecks.isEmpty {
                Text("No checks reported")
                    .foregroundStyle(palette.textMuted)
            } else {
                ForEach(Array(detail.sortedChecks.enumerated()), id: \.offset) { _, check in
                    checkRow(check)
                }
            }
        }
    }

    private func statusRow(_ label: String, value: String, color: Color) -> some View {
        HStack {
            Text(label).foregroundStyle(palette.textSecondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func checkRow(_ check: Dev3PRCheck) -> some View {
        let state = TaskPRCheckState(check: check)
        let row = HStack(spacing: 10) {
            Image(systemName: checkIcon(state))
                .foregroundStyle(checkColor(state))
                .accessibilityHidden(true)
            Text(check.name.isEmpty ? "Unnamed check" : check.name)
                .lineLimit(2)
            Spacer()
            Text(state.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(checkColor(state))
        }
        .frame(minHeight: 36)
        .accessibilityElement(children: .combine)

        if let url = Dev3SafeExternalURL.parse(check.detailsUrl) {
            Link(destination: url) { row }
                .accessibilityHint("Opens check details")
        } else {
            row
        }
    }

    private func mergeabilityLabel(_ detail: TaskPRStatusDetail) -> String {
        switch detail.mergeability {
        case .mergeable: "Yes"
        case .notMergeable: "No"
        case .unknown: "Unknown"
        }
    }

    private func mergeabilityColor(_ detail: TaskPRStatusDetail) -> Color {
        switch detail.mergeability {
        case .mergeable: palette.success
        case .notMergeable: palette.danger
        case .unknown: palette.textTertiary
        }
    }

    private func autoMergeLabel(_ enabled: Bool?) -> String {
        switch enabled {
        case true: "Enabled"
        case false: "Not set"
        case nil: "Unknown"
        }
    }

    private func reviewLabel(_ detail: TaskPRStatusDetail) -> String {
        switch detail.reviewDecision ?? detail.reviewState {
        case "approved": "Approved"
        case "changes_requested": "Changes requested"
        case "review_required": "Review required"
        case "commented": "Comments"
        default: "No review yet"
        }
    }

    private func reviewColor(_ detail: TaskPRStatusDetail) -> Color {
        switch detail.reviewDecision ?? detail.reviewState {
        case "approved": palette.success
        case "changes_requested": palette.danger
        case "review_required", "commented": palette.warning
        default: palette.textTertiary
        }
    }

    private func unresolvedLabel(_ count: Int?) -> String {
        guard let count else { return "Unknown" }
        return count == 1 ? "1 unresolved" : "\(count) unresolved"
    }

    private func checkIcon(_ state: TaskPRCheckState) -> String {
        switch state {
        case .failure: "xmark.circle.fill"
        case .pending: "clock.fill"
        case .success: "checkmark.circle.fill"
        case .unknown: "questionmark.circle"
        }
    }

    private func checkColor(_ state: TaskPRCheckState) -> Color {
        switch state {
        case .failure: palette.danger
        case .pending: palette.warning
        case .success: palette.success
        case .unknown: palette.textTertiary
        }
    }
}

// swiftlint:enable switch_case_on_newline
