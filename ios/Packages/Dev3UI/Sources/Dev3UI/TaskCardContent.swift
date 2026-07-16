import Dev3Kit
import SwiftUI

struct TaskCardHeader: View {
    let task: Dev3Task
    let palette: Dev3ThemePalette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Circle()
                .fill(palette.statusColor(task.status.themeToken))
                .frame(width: 9, height: 9)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.displayTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .lineLimit(2)
                Text("#\(task.seq) · \(task.status.displayName)")
                    .font(.caption)
                    .foregroundStyle(palette.textTertiary)
            }
            Spacer(minLength: 4)
            if task.watched == true {
                Image(systemName: "eye.fill")
                    .font(.caption)
                    .foregroundStyle(palette.accent)
                    .accessibilityLabel("Watched")
            }
            priorityBadge
        }
    }

    private var priorityBadge: some View {
        Text(task.effectivePriority.rawValue)
            .font(.caption2.bold().monospaced())
            .foregroundStyle(priorityColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(priorityColor.opacity(0.13), in: Capsule())
            .accessibilityLabel("Priority \(task.effectivePriority.rawValue)")
    }

    private var priorityColor: Color {
        switch task.effectivePriority {
        case .p0:
            palette.danger
        case .p1:
            palette.warning
        case .p2:
            palette.accent
        case .p3, .p4:
            palette.textTertiary
        }
    }
}

struct TaskCardLabels: View {
    let labels: [Dev3Label]
    let palette: Dev3ThemePalette

    var body: some View {
        HStack(spacing: 5) {
            ForEach(labels.prefix(3)) { label in
                Text(label.name)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(labelColor(label))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(labelColor(label).opacity(0.14), in: Capsule())
                    .lineLimit(1)
            }
            if labels.count > 3 {
                Text("+\(labels.count - 3)")
                    .font(.caption2)
                    .foregroundStyle(palette.textTertiary)
            }
        }
    }

    private func labelColor(_ label: Dev3Label) -> Color {
        let paletteIndex = label.id.unicodeScalars.reduce(0) { partialResult, scalar in
            (partialResult + Int(scalar.value)) % palette.labelValues.count
        }
        return Color(dev3Hex: label.color) ?? palette.labelColor(at: paletteIndex)
    }
}

struct TaskCardMetadata: View {
    let task: Dev3Task
    let variantSummary: TaskVariantSummary
    let prStatus: TaskPRStatusPush?
    let palette: Dev3ThemePalette
    let actions: TaskCardActions

    var body: some View {
        HStack(spacing: 10) {
            if variantSummary.count > 1 {
                Button(action: actions.showVariants) {
                    variantDots
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.textTertiary)
                .accessibilityLabel("\(variantSummary.count) task variants")
                .accessibilityHint("Opens the variant switcher")
                .accessibilityIdentifier("task-variants-\(task.id)")
            }
            Spacer(minLength: 0)
            if Self.hasBranchBadge(task: task, prStatus: prStatus) {
                branchBadge
            }
        }
    }

    static func hasBranchBadge(task: Dev3Task, prStatus: TaskPRStatusPush?) -> Bool {
        prStatus?.prNumber != nil ||
            task.prNumber != nil ||
            task.branchName?.isEmpty == false
    }

    private var variantDots: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< min(variantSummary.count, 3), id: \.self) { index in
                Capsule()
                    .fill(variantDotColor(index))
                    .frame(width: index == variantSummary.activeIndex ? 12 : 5, height: 5)
            }
            if variantSummary.count > 3 {
                Text("+\(variantSummary.count - 3)")
                    .font(.caption2)
            }
        }
    }

    @ViewBuilder
    private var branchBadge: some View {
        if let prNumber = prStatus?.prNumber ?? task.prNumber {
            Label("PR #\(prNumber)", systemImage: "arrow.triangle.pull")
                .foregroundStyle(prColor)
                .accessibilityLabel("Pull request \(prNumber), \(prStateDescription)")
        } else if let branchName = task.branchName, !branchName.isEmpty {
            Label(branchName, systemImage: "arrow.triangle.branch")
                .foregroundStyle(palette.textTertiary)
                .lineLimit(1)
        }
    }

    private var prColor: Color {
        let status = (prStatus?.ciStatus ?? task.prStatusCache?.ciStatus ?? "").uppercased()
        if ["SUCCESS", "PASSED", "COMPLETED"].contains(status) {
            return palette.success
        }
        if ["FAILURE", "FAILED", "ERROR"].contains(status) {
            return palette.danger
        }
        return status.isEmpty ? palette.textTertiary : palette.warning
    }

    private func variantDotColor(_ index: Int) -> Color {
        index == variantSummary.activeIndex ? palette.accent : palette.textMuted
    }

    private var prStateDescription: String {
        prStatus?.ciStatus ?? task.prStatusCache?.ciStatus ?? "status pending"
    }
}
