import Dev3Kit
import SwiftUI

public enum TaskCardSurface: Equatable, Sendable {
    case solid
    case kanbanGlass
}

public struct TaskVariantSummary: Equatable, Sendable {
    public let count: Int
    public let activeIndex: Int

    public init(count: Int = 0, activeIndex: Int = 0) {
        self.count = count
        self.activeIndex = activeIndex
    }

    public static func resolve(task: Dev3Task, among tasks: [Dev3Task]) -> TaskVariantSummary {
        guard let groupId = task.groupId else { return TaskVariantSummary() }
        let siblings = tasks.filter { $0.groupId == groupId }.sorted {
            let lhsIndex = $0.variantIndex ?? 0
            let rhsIndex = $1.variantIndex ?? 0
            return lhsIndex == rhsIndex ? $0.id < $1.id : lhsIndex < rhsIndex
        }
        guard siblings.count > 1 else { return TaskVariantSummary() }
        return TaskVariantSummary(
            count: siblings.count,
            activeIndex: siblings.firstIndex { $0.id == task.id } ?? 0
        )
    }
}

public struct TaskCardActions {
    public let open: () -> Void
    public let move: (Dev3TaskStatus) -> Void
    public let moveToCustomColumn: (String) -> Void
    public let setPriority: (Dev3TaskPriority) -> Void
    public let toggleWatch: () -> Void
    public let openInfo: () -> Void
    public let showVariants: () -> Void

    public init(
        open: @escaping () -> Void,
        move: @escaping (Dev3TaskStatus) -> Void = { _ in },
        moveToCustomColumn: @escaping (String) -> Void = { _ in },
        setPriority: @escaping (Dev3TaskPriority) -> Void = { _ in },
        toggleWatch: @escaping () -> Void = {},
        openInfo: @escaping () -> Void = {},
        showVariants: @escaping () -> Void = {}
    ) {
        self.open = open
        self.move = move
        self.moveToCustomColumn = moveToCustomColumn
        self.setPriority = setPriority
        self.toggleWatch = toggleWatch
        self.openInfo = openInfo
        self.showVariants = showVariants
    }
}

public struct NativeTaskCard: View {
    private let task: Dev3Task
    private let labels: [Dev3Label]
    private let customColumns: [Dev3CustomColumn]
    private let variantSummary: TaskVariantSummary
    private let prStatus: TaskPRStatusPush?
    private let surface: TaskCardSurface
    private let mutationsEnabled: Bool
    private let actions: TaskCardActions

    @Environment(\.colorScheme) private var colorScheme

    public init(
        task: Dev3Task,
        labels: [Dev3Label] = [],
        customColumns: [Dev3CustomColumn] = [],
        variantSummary: TaskVariantSummary = TaskVariantSummary(),
        prStatus: TaskPRStatusPush? = nil,
        surface: TaskCardSurface = .solid,
        mutationsEnabled: Bool = true,
        actions: TaskCardActions
    ) {
        self.task = task
        self.labels = labels
        self.customColumns = customColumns
        self.variantSummary = variantSummary
        self.prStatus = prStatus
        self.surface = surface
        self.mutationsEnabled = mutationsEnabled
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TaskCardHeader(task: task, palette: palette)
            if !labels.isEmpty {
                TaskCardLabels(labels: labels, palette: palette)
            }
            if variantSummary.count > 1 || TaskCardMetadata.hasBranchBadge(task: task, prStatus: prStatus) {
                TaskCardMetadata(
                    task: task,
                    variantSummary: variantSummary,
                    prStatus: prStatus,
                    palette: palette,
                    actions: actions
                )
            }
            if task.preparing == true {
                preparationProgress
            }
            if task.shuttingDown == true {
                shuttingDownState
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { cardSurface }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(cardBorder)
        }
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture(perform: actions.open)
        .contextMenu { taskContextMenu }
        .opacity(task.shuttingDown == true ? 0.72 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("task-card-\(task.id)")
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    private var cardBorder: Color {
        surface == .kanbanGlass ? palette.glassBorderCard : palette.borderDefault
    }

    @ViewBuilder
    private var cardSurface: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        if surface == .kanbanGlass {
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.fill(palette.glassCard))
                .shadow(
                    color: palette.statusColor(task.status.themeToken)
                        .opacity(palette.metrics.glowStartAlpha),
                    radius: 12
                )
        } else {
            shape.fill(palette.surfaceRaised)
        }
    }

    private var preparationProgress: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                ProgressView()
                    .controlSize(.small)
                Text(task.preparingStage ?? "Preparing worktree")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                Spacer(minLength: 0)
                if let progress = task.preparingProgress {
                    Text("\(progress)%")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.textTertiary)
                }
            }
            if let progress = task.preparingProgress {
                ProgressView(value: Double(progress), total: 100)
                    .tint(palette.accent)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(preparationAccessibilityLabel)
    }

    private var shuttingDownState: some View {
        Label("Closing terminal…", systemImage: "power")
            .font(.caption)
            .foregroundStyle(palette.textTertiary)
            .accessibilityIdentifier("task-shutting-down-\(task.id)")
    }

    @ViewBuilder
    private var taskContextMenu: some View {
        Menu("Move to") {
            ForEach(TaskCardContextDestinations.statuses(for: task), id: \.self) { status in
                Button(status.displayName) { actions.move(status) }
            }
            ForEach(TaskCardContextDestinations.customColumns(for: task, among: customColumns)) { column in
                Button(column.name) { actions.moveToCustomColumn(column.id) }
            }
        }
        .disabled(!mutationsEnabled)
        Menu("Priority") {
            ForEach(Dev3TaskPriority.allCases, id: \.self) { priority in
                Button(priority.rawValue) { actions.setPriority(priority) }
            }
        }
        .disabled(!mutationsEnabled)
        Button(task.watched == true ? "Unwatch" : "Watch", action: actions.toggleWatch)
            .disabled(!mutationsEnabled)
        Button("Open task info", systemImage: "info.circle", action: actions.openInfo)
    }

    private var preparationAccessibilityLabel: String {
        TaskCardSemantics.preparationLabel(task)
    }

    private var accessibilityLabel: String {
        TaskCardSemantics.accessibilityLabel(
            task: task,
            labels: labels,
            variantSummary: variantSummary
        )
    }

    private var accessibilityHint: String {
        mutationsEnabled
            ? "Opens task terminal. Long press for task actions."
            : "Opens task terminal. Task changes are unavailable while disconnected."
    }
}

enum TaskCardContextDestinations {
    static func statuses(for task: Dev3Task) -> [Dev3TaskStatus] {
        Dev3TaskStatus.allCases.filter { status in
            guard status != task.status || task.customColumnId != nil else { return false }
            return !(task.status == .todo && status == .inProgress)
        }
    }

    static func customColumns(
        for task: Dev3Task,
        among columns: [Dev3CustomColumn]
    ) -> [Dev3CustomColumn] {
        columns.filter { $0.id != task.customColumnId }
    }
}
