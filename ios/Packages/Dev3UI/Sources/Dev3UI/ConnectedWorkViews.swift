import Dev3Kit
import SwiftUI

struct WorkOverview: View {
    @Bindable var store: AppStore
    let actions: (Dev3Task) -> TaskCardActions
    let onCreateTask: () -> Void

    var body: some View {
        Group {
            if store.isInitialLoading, store.projects.isEmpty {
                ProgressView("Loading work…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("work.loading")
            } else {
                WorkQueueView(
                    projects: store.projects,
                    tasks: store.allTasks,
                    prStatusByTask: store.prStatusByTask,
                    mutationsEnabled: store.isConnected,
                    actions: actions,
                    onRefresh: { await store.refreshAll() }
                )
            }
        }
        .onAppear { store.setActiveContext(projectId: nil, taskId: nil) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Task", systemImage: "plus", action: onCreateTask)
                    .disabled(!store.isConnected)
                    .accessibilityIdentifier("taskCreation.open")
            }
        }
    }
}

struct ProjectsOverview: View {
    @Bindable var store: AppStore

    var body: some View {
        Group {
            if store.isInitialLoading, store.projects.isEmpty {
                ProgressView("Loading projects…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("projects.loading")
            } else {
                ProjectsDashboardView(
                    items: ProjectsDashboardProjection.items(
                        projects: store.projects,
                        tasksByProject: store.tasksByProject,
                        explicitAttentionTaskIDs: Set(store.attentionByTask.keys)
                    ),
                    pullStates: store.projectPullStates,
                    mutationsEnabled: store.isConnected,
                    onOpenProject: store.openProject,
                    onPullMain: { projectID in
                        Task { await store.pullProjectMain(projectID) }
                    },
                    onRefresh: { await store.refreshAll() }
                )
            }
        }
        .onAppear { store.setActiveContext(projectId: nil, taskId: nil) }
    }
}

struct ProjectBoardOverview: View {
    @Bindable var store: AppStore
    let project: Dev3Project
    let actions: (Dev3Task) -> TaskCardActions
    let onCreateTask: () -> Void

    var body: some View {
        ProjectBoardView(
            project: project,
            tasks: store.tasksByProject[project.id] ?? [],
            prStatusByTask: store.prStatusByTask,
            dropPosition: store.taskDropPosition,
            mutationsEnabled: store.isConnected,
            actions: actions,
            onCreateTask: onCreateTask,
            onRefresh: { await store.refreshProject(project.id) }
        )
        .task { await store.refreshProject(project.id) }
        .onAppear { store.setActiveContext(projectId: project.id, taskId: nil) }
    }
}

struct TaskDestinationContext: View {
    @Bindable var store: AppStore
    let projectID: String
    let taskID: String
    let destinationBuilder: TaskDestinationBuilder

    var body: some View {
        destinationBuilder(projectID, taskID)
            .onAppear {
                store.setActiveContext(projectId: projectID, taskId: taskID)
            }
    }
}

struct VariantSelection: Identifiable {
    let projectID: String
    let taskID: String

    var id: String {
        "\(projectID):\(taskID)"
    }
}

enum TaskVariantPickerProjection {
    static func siblings(forTaskID taskID: String, among tasks: [Dev3Task]) -> [Dev3Task] {
        guard let task = tasks.first(where: { $0.id == taskID }) else { return [] }
        guard let groupID = task.groupId else { return [task] }
        return tasks.filter { $0.groupId == groupID }.sorted {
            let lhs = $0.variantIndex ?? 0
            let rhs = $1.variantIndex ?? 0
            return lhs == rhs ? $0.id < $1.id : lhs < rhs
        }
    }
}

struct TaskVariantPicker: View {
    let selected: VariantSelection
    let tasks: [Dev3Task]
    let onOpen: (Dev3Task) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(TaskVariantPickerProjection.siblings(forTaskID: selected.taskID, among: tasks)) { task in
                Button {
                    dismiss()
                    onOpen(task)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(task.displayTitle)
                                .foregroundStyle(.primary)
                            Text("#\(task.seq) · \(task.status.displayName)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if task.id == selected.taskID {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                                .accessibilityLabel("Current variant")
                        }
                    }
                }
                .accessibilityIdentifier("task-variant-choice-\(task.id)")
            }
            .navigationTitle("Task variants")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("task-variant-picker")
    }
}
