import Dev3Kit
@testable import Dev3UI
import SwiftUI
import Testing

@Suite("Native task card")
struct TaskCardTests {
    @Test("Variant summary orders siblings and retains full count")
    func variantSummary() {
        let tasks = [
            makeIATask(id: "third", groupId: "group", variantIndex: 2),
            makeIATask(id: "first", groupId: "group", variantIndex: 0),
            makeIATask(id: "second", groupId: "group", variantIndex: 1),
            makeIATask(id: "other", groupId: "other", variantIndex: 0)
        ]

        #expect(TaskVariantSummary.resolve(task: tasks[0], among: tasks) == TaskVariantSummary(
            count: 3,
            activeIndex: 2
        ))
        #expect(TaskVariantSummary.resolve(task: tasks[3], among: tasks) == TaskVariantSummary())
    }

    @Test("Accessibility includes all load-bearing card states")
    func accessibilitySemantics() throws {
        let project = makeIAProject(labels: [[
            "id": "urgent",
            "name": "Urgent",
            "color": "#ff0000"
        ]])
        let label = try #require(project.labels?.first)
        let task = makeIATask(
            id: "stateful",
            seq: 42,
            status: .reviewByUser,
            priority: .p0,
            labelIds: [label.id],
            preparing: true,
            shuttingDown: true
        )
        let labelText = TaskCardSemantics.accessibilityLabel(
            task: task,
            labels: [label],
            variantSummary: TaskVariantSummary(count: 4, activeIndex: 1)
        )

        #expect(labelText.contains("Task 42"))
        #expect(labelText.contains("Your review"))
        #expect(labelText.contains("priority P0"))
        #expect(labelText.contains("labels Urgent"))
        #expect(labelText.contains("4 variants"))
        #expect(labelText.contains("Preparing worktree"))
        #expect(labelText.contains("closing terminal"))
    }

    @Test("Generated color tokens reject malformed values")
    func generatedColorTokens() {
        #expect(Color(dev3Hex: "#ff0000") != nil)
        #expect(Color(dev3Hex: "#123") == nil)
        #expect(Color(dev3Hex: "not-a-color") == nil)
    }

    @Test("Context destinations expose every other project custom column")
    func customColumnDestinations() throws {
        let project = makeIAProject(customColumns: [
            makeIACustomColumn("current", name: "Current"),
            makeIACustomColumn("later", name: "Later")
        ])
        let task = makeIATask(id: "custom", customColumnId: "current")

        let destinations = try TaskCardContextDestinations.customColumns(
            for: task,
            among: #require(project.customColumns)
        )

        #expect(destinations.map(\.id) == ["later"])
        #expect(!TaskCardContextDestinations.statuses(for: task).isEmpty)
        let todo = makeIATask(id: "todo", status: .todo)
        #expect(!TaskCardContextDestinations.statuses(for: todo).contains(.inProgress))
    }

    @Test("Variant picker exposes ordered siblings and handles a removed task")
    func variantPickerSiblings() {
        let tasks = [
            makeIATask(id: "second", groupId: "group", variantIndex: 1),
            makeIATask(id: "other", groupId: "other", variantIndex: 0),
            makeIATask(id: "first", groupId: "group", variantIndex: 0)
        ]

        #expect(
            TaskVariantPickerProjection.siblings(forTaskID: "second", among: tasks).map(\.id) ==
                ["first", "second"]
        )
        #expect(TaskVariantPickerProjection.siblings(forTaskID: "removed", among: tasks).isEmpty)
    }

    @Test("Cards and owning screens construct for every status and state")
    @MainActor
    func componentConstruction() {
        let project = makeIAProject()
        let tasks = Dev3TaskStatus.allCases.enumerated().map { index, status in
            makeIATask(
                id: status.rawValue,
                seq: index + 1,
                status: status,
                preparing: status == .todo,
                shuttingDown: status == .completed,
                watched: status == .userQuestions,
                prNumber: status == .reviewByColleague ? 91 : nil,
                branchName: "feat/native"
            )
        }
        let actionBuilder = { (_: Dev3Task) in TaskCardActions(open: {}) }

        for task in tasks {
            _ = NativeTaskCard(
                task: task,
                surface: .solid,
                mutationsEnabled: false,
                actions: actionBuilder(task)
            )
            _ = NativeTaskCard(
                task: task,
                surface: .kanbanGlass,
                actions: actionBuilder(task)
            )
        }
        _ = WorkQueueView(projects: [project], tasks: tasks, actions: actionBuilder)
        _ = ProjectBoardView(project: project, tasks: tasks, actions: actionBuilder)
        _ = ProjectsDashboardView(
            items: ProjectsDashboardProjection.items(
                projects: [project],
                tasksByProject: [project.id: tasks]
            ),
            onOpenProject: { _ in },
            onPullMain: { _ in }
        )
    }
}
