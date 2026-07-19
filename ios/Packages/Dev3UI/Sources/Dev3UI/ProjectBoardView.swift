import Dev3Kit
import SwiftUI

public struct ProjectBoardView: View {
    private let project: Dev3Project
    private let tasks: [Dev3Task]
    private let prStatusByTask: [String: TaskPRStatusPush]
    private let dropPosition: TaskDropPosition
    private let explicitlyCollapsedColumnIDs: Set<String>
    private let mutationsEnabled: Bool
    private let actions: (Dev3Task) -> TaskCardActions
    private let onCreateTask: () -> Void
    private let onRefresh: () async -> Void

    @State private var selectedColumnID: String
    @State private var hasUserNavigated = false
    @Environment(\.colorScheme) private var colorScheme

    public init(
        project: Dev3Project,
        tasks: [Dev3Task],
        prStatusByTask: [String: TaskPRStatusPush] = [:],
        dropPosition: TaskDropPosition = .top,
        explicitlyCollapsedColumnIDs: Set<String> = [],
        mutationsEnabled: Bool = true,
        actions: @escaping (Dev3Task) -> TaskCardActions,
        onCreateTask: @escaping () -> Void = {},
        onRefresh: @escaping () async -> Void = {}
    ) {
        self.project = project
        self.tasks = tasks
        self.prStatusByTask = prStatusByTask
        self.dropPosition = dropPosition
        self.explicitlyCollapsedColumnIDs = explicitlyCollapsedColumnIDs
        self.mutationsEnabled = mutationsEnabled
        self.actions = actions
        self.onCreateTask = onCreateTask
        self.onRefresh = onRefresh
        let columns = ProjectBoardProjection.columns(
            project: project,
            tasks: tasks,
            dropPosition: dropPosition,
            explicitlyCollapsedColumnIDs: explicitlyCollapsedColumnIDs
        )
        _selectedColumnID = State(
            initialValue: ProjectBoardProjection.preferredInitialColumnID(columns) ?? ""
        )
    }

    public var body: some View {
        Group {
            if columns.isEmpty {
                emptyBoard
            } else {
                boardPager
                    .onChange(of: columns.map(\.id), initial: true) { _, columnIDs in
                        reconcileSelection(columnIDs)
                    }
                    .onChange(of: preferredColumnID, initial: true) { _, preferred in
                        applyPreferredColumn(preferred)
                    }
            }
        }
        .background(palette.surfaceBase)
        .navigationTitle(project.name)
        .dev3InlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Task", systemImage: "plus", action: onCreateTask)
                    .disabled(!mutationsEnabled)
                    .accessibilityIdentifier("taskCreation.open.project")
            }
        }
        .accessibilityIdentifier("project-board-\(project.id)")
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    private var columns: [ProjectBoardColumn] {
        ProjectBoardProjection.columns(
            project: project,
            tasks: tasks,
            dropPosition: dropPosition,
            explicitlyCollapsedColumnIDs: explicitlyCollapsedColumnIDs
        )
    }

    private var preferredColumnID: String? {
        ProjectBoardProjection.preferredInitialColumnID(columns)
    }

    private var userSelection: Binding<String> {
        Binding(
            get: { selectedColumnID },
            set: { newValue in
                selectedColumnID = newValue
                hasUserNavigated = true
            }
        )
    }

    @ViewBuilder
    private var boardPager: some View {
        #if os(iOS)
            TabView(selection: userSelection) {
                boardPages
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .interactive))
        #else
            TabView(selection: userSelection) {
                boardPages
            }
        #endif
    }

    private var boardPages: some View {
        ForEach(Array(columns.enumerated()), id: \.element.id) { index, column in
            boardPage(column, index: index)
                .tag(column.id)
        }
    }

    private var emptyBoard: some View {
        ContentUnavailableView(
            "No visible columns",
            systemImage: "rectangle.split.3x1",
            description: Text("Show at least one column to use this board.")
        )
        .foregroundStyle(palette.textSecondary)
        .accessibilityIdentifier("project-board-empty-\(project.id)")
    }

    private func boardPage(_ column: ProjectBoardColumn, index: Int) -> some View {
        VStack(spacing: 0) {
            columnHeader(column, index: index)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if column.tasks.isEmpty {
                        Text("No tasks in this column")
                            .font(.subheadline)
                            .foregroundStyle(palette.textTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 44)
                            .accessibilityIdentifier("board-column-empty-\(column.id)")
                    } else {
                        ForEach(column.tasks) { task in
                            NativeTaskCard(
                                task: task,
                                labels: labels(for: task),
                                customColumns: project.customColumns ?? [],
                                variantSummary: TaskVariantSummary.resolve(task: task, among: tasks),
                                prStatus: prStatusByTask[task.id],
                                surface: .kanbanGlass,
                                mutationsEnabled: mutationsEnabled,
                                actions: actions(task)
                            )
                        }
                    }
                }
                .padding(12)
            }
            .refreshable { await onRefresh() }
        }
        .background {
            let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.fill(palette.glassColumn))
                .shadow(
                    color: columnColor(column).opacity(palette.metrics.glowMidAlpha),
                    radius: 18
                )
        }
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(palette.glassBorderColumn)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 28)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(column.title) column, page \(index + 1) of \(columns.count)")
        .accessibilityIdentifier("board-column-\(column.id)")
    }

    private func columnHeader(_ column: ProjectBoardColumn, index: Int) -> some View {
        HStack(spacing: 8) {
            columnStepButton(from: column.id, offset: -1, systemImage: "chevron.left")
            Circle()
                .fill(columnColor(column))
                .frame(width: 10, height: 10)
                .accessibilityHidden(true)
            Text(column.title)
                .font(.headline)
                .foregroundStyle(palette.textPrimary)
                .lineLimit(1)
            Text("\(column.tasks.count)")
                .font(.caption2.bold().monospacedDigit())
                .foregroundStyle(palette.textTertiary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(palette.surfaceElevated, in: Capsule())
            Spacer(minLength: 0)
            Text("\(index + 1)/\(columns.count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(palette.textMuted)
            columnStepButton(from: column.id, offset: 1, systemImage: "chevron.right")
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(columnColor(column).opacity(0.08))
    }

    private func columnStepButton(
        from currentID: String,
        offset: Int,
        systemImage: String
    ) -> some View {
        let targetID = ProjectBoardProjection.adjacentColumnID(columns, from: currentID, offset: offset)
        let isPrevious = offset < 0
        return Button {
            if let targetID {
                userSelection.wrappedValue = targetID
            }
        } label: {
            Image(systemName: systemImage)
                .font(.headline)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(targetID == nil ? palette.textMuted.opacity(0.4) : palette.accent)
        .disabled(targetID == nil)
        .accessibilityLabel(isPrevious ? "Previous column" : "Next column")
        .accessibilityIdentifier(isPrevious ? "board-column-prev" : "board-column-next")
    }

    private func labels(for task: Dev3Task) -> [Dev3Label] {
        let labelsByID = Dictionary(uniqueKeysWithValues: (project.labels ?? []).map { ($0.id, $0) })
        return (task.labelIds ?? []).compactMap { labelsByID[$0] }
    }

    private func columnColor(_ column: ProjectBoardColumn) -> Color {
        switch column.kind {
        case let .builtin(status):
            palette.statusColor(status.themeToken)
        case let .custom(customColumn):
            Color(dev3Hex: customColumn.color) ?? palette.accent
        }
    }

    private func reconcileSelection(_ columnIDs: [String]) {
        guard !columnIDs.contains(selectedColumnID) else { return }
        selectedColumnID = columnIDs.first ?? ""
    }

    private func applyPreferredColumn(_ preferred: String?) {
        guard !hasUserNavigated, let preferred, columns.contains(where: { $0.id == preferred }) else {
            return
        }
        selectedColumnID = preferred
    }
}

private extension View {
    @ViewBuilder
    func dev3InlineNavigationTitle() -> some View {
        #if os(iOS)
            navigationBarTitleDisplayMode(.inline)
        #else
            self
        #endif
    }
}
