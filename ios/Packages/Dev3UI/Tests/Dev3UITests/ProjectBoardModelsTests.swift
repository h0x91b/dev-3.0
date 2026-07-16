@testable import Dev3UI
import Testing

@Suite("Project board projection")
struct ProjectBoardModelsTests {
    @Test("Matches canonical default and explicit custom column ordering")
    func canonicalColumnOrdering() throws {
        let project = makeIAProject(
            customColumns: [makeIACustomColumn("deploy")],
            columnOrder: ["todo", "deploy", "in-progress", "completed"]
        )

        let columns = ProjectBoardProjection.columns(project: project, tasks: [])

        #expect(columns.prefix(3).map(\.id) == ["todo", "deploy", "in-progress"])
        #expect(columns.map(\.id).contains("review-by-ai"))
        #expect(columns.map(\.id).contains("review-by-colleague"))
        let colleagueIndex = try #require(columns.map(\.id).firstIndex(of: "review-by-colleague"))
        let completedIndex = try #require(columns.map(\.id).firstIndex(of: "completed"))
        #expect(colleagueIndex < completedIndex)
    }

    @Test("Virtual boards and disabled review columns mirror the web rules")
    func reviewVisibility() {
        let virtual = makeIAProject(kind: .virtual)
        let disabledAI = makeIAProject(builtinColumnAgents: [:])
        let retainedAI = ProjectBoardProjection.columns(
            project: disabledAI,
            tasks: [makeIATask(id: "ai", status: .reviewByAI)]
        )

        #expect(ProjectBoardProjection.columns(project: virtual, tasks: []).map(\.id) == [
            "todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled"
        ])
        let disabledColumns = ProjectBoardProjection.columns(project: disabledAI, tasks: [])
        #expect(!disabledColumns.map(\.id).contains("review-by-ai"))
        #expect(retainedAI.map(\.id).contains("review-by-ai"))
    }

    @Test("Custom placement wins and dangling custom IDs fall back to status")
    func customPlacementWins() {
        let project = makeIAProject(customColumns: [makeIACustomColumn("hold")])
        let tasks = [
            makeIATask(id: "parked-review", status: .reviewByUser, customColumnId: "hold"),
            makeIATask(id: "dangling", status: .reviewByUser, customColumnId: "deleted")
        ]
        let columns = ProjectBoardProjection.columns(project: project, tasks: tasks)

        #expect(columns.first { $0.id == "hold" }?.tasks.map(\.id) == ["parked-review"])
        #expect(columns.first { $0.id == "review-by-user" }?.tasks.map(\.id) == ["dangling"])
    }

    @Test("Only explicit collapse hides a page, so terminal defaults stay visible")
    func explicitCollapseOnly() {
        let project = makeIAProject()

        let defaultColumns = ProjectBoardProjection.columns(project: project, tasks: [])
        let explicitlyCollapsed = ProjectBoardProjection.columns(
            project: project,
            tasks: [],
            explicitlyCollapsedColumnIDs: ["todo"]
        )

        #expect(defaultColumns.map(\.id).suffix(2) == ["completed", "cancelled"])
        #expect(!explicitlyCollapsed.map(\.id).contains("todo"))
        #expect(explicitlyCollapsed.map(\.id).contains("completed"))
        #expect(explicitlyCollapsed.map(\.id).contains("cancelled"))
    }

    @Test("Initial attention page prefers questions then user review")
    func initialAttentionColumn() {
        let project = makeIAProject()
        let reviewOnly = ProjectBoardProjection.columns(
            project: project,
            tasks: [makeIATask(id: "review", status: .reviewByUser)]
        )
        let withQuestion = ProjectBoardProjection.columns(
            project: project,
            tasks: [
                makeIATask(id: "review", status: .reviewByUser),
                makeIATask(id: "question", status: .userQuestions)
            ]
        )

        #expect(ProjectBoardProjection.preferredInitialColumnID(reviewOnly) == "review-by-user")
        #expect(ProjectBoardProjection.preferredInitialColumnID(withQuestion) == "user-questions")
    }

    @Test("Top and bottom modes place moved and unmoved tasks exactly like web")
    func dropPositionOrdering() {
        let project = makeIAProject()
        let tasks = [
            makeIATask(id: "unmoved", seq: 1, status: .inProgress, priority: .p1),
            makeIATask(
                id: "old-move",
                seq: 2,
                status: .inProgress,
                priority: .p1,
                movedAt: "2026-01-01T00:00:00Z"
            ),
            makeIATask(
                id: "new-move",
                seq: 3,
                status: .inProgress,
                priority: .p1,
                movedAt: "2026-03-01T00:00:00Z"
            )
        ]

        let top = ProjectBoardProjection.columns(project: project, tasks: tasks, dropPosition: .top)
        let bottom = ProjectBoardProjection.columns(project: project, tasks: tasks, dropPosition: .bottom)

        #expect(top.first { $0.id == "in-progress" }?.tasks.map(\.id) == ["new-move", "old-move", "unmoved"])
        #expect(bottom.first { $0.id == "in-progress" }?.tasks.map(\.id) == ["unmoved", "old-move", "new-move"])
    }

    @Test("Explicit order and variant grouping are stable inside a priority band")
    func explicitOrderAndVariants() {
        let project = makeIAProject()
        let ordered = makeIATask(
            id: "ordered",
            seq: 99,
            status: .inProgress,
            priority: .p2,
            columnOrder: 0
        )
        let variants = [
            makeIATask(
                id: "variant-2",
                seq: 2,
                status: .inProgress,
                priority: .p2,
                groupId: "group",
                variantIndex: 2
            ),
            makeIATask(
                id: "variant-0",
                seq: 3,
                status: .inProgress,
                priority: .p2,
                groupId: "group",
                variantIndex: 0
            ),
            makeIATask(id: "plain", seq: 1, status: .inProgress, priority: .p2)
        ]

        let tasks = ProjectBoardProjection.columns(project: project, tasks: variants + [ordered])
            .first { $0.id == "in-progress" }?.tasks ?? []

        #expect(tasks.map(\.id) == ["ordered", "variant-0", "variant-2", "plain"])
    }

    @Test("Completed and cancelled sort newest entry first regardless of priority or grouping")
    func terminalColumnRecency() {
        let project = makeIAProject()
        let tasks = [
            makeIATask(
                id: "old-p0",
                status: .completed,
                priority: .p0,
                movedAt: "2026-01-01T00:00:00Z",
                groupId: "a"
            ),
            makeIATask(
                id: "new-p4",
                status: .completed,
                priority: .p4,
                movedAt: "2026-04-01T00:00:00Z"
            ),
            makeIATask(
                id: "fallback-created",
                status: .cancelled,
                priority: .p4,
                createdAt: "2026-05-01T00:00:00Z"
            ),
            makeIATask(
                id: "cancelled-moved",
                status: .cancelled,
                priority: .p0,
                createdAt: "2026-06-01T00:00:00Z",
                movedAt: "2026-07-01T00:00:00Z"
            )
        ]
        let columns = ProjectBoardProjection.columns(
            project: project,
            tasks: tasks,
            dropPosition: .bottom
        )

        #expect(columns.first { $0.id == "completed" }?.tasks.map(\.id) == ["new-p4", "old-p0"])
        let cancelled = columns.first { $0.id == "cancelled" }?.tasks.map(\.id)
        #expect(cancelled == ["cancelled-moved", "fallback-created"])
    }
}
