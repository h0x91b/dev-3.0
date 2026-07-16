@testable import Dev3UI
import Testing

@Suite("Task readiness tiers")
struct TaskReadinessTests {
    @Test("Groups exact statuses as Needs You then Waiting")
    func builtinTierMembership() {
        let tasks = [
            makeIATask(id: "question", status: .userQuestions),
            makeIATask(id: "review", status: .reviewByUser),
            makeIATask(id: "pr", status: .reviewByColleague),
            makeIATask(id: "working", status: .inProgress),
            makeIATask(id: "ai", status: .reviewByAI),
            makeIATask(id: "todo", status: .todo),
            makeIATask(id: "done", status: .completed)
        ]

        let tiers = TaskReadiness.tiers(tasks: tasks, projects: [makeIAProject()])

        #expect(tiers.map(\.kind) == [.needsYou, .waiting])
        #expect(Set(tiers[0].tasks.map(\.id)) == ["question", "review", "pr"])
        #expect(Set(tiers[1].tasks.map(\.id)) == ["working", "ai"])
    }

    @Test("Custom placement wins and follows project then explicit column order")
    func customPlacementAndOrder() {
        let first = makeIAProject(
            id: "project-2",
            customColumns: [makeIACustomColumn("later"), makeIACustomColumn("first")],
            columnOrder: ["first", "later"]
        )
        let second = makeIAProject(
            id: "project-1",
            customColumns: [makeIACustomColumn("hold")]
        )
        let tasks = [
            makeIATask(
                id: "actionable-but-parked",
                projectId: "project-2",
                status: .reviewByUser,
                customColumnId: "later"
            ),
            makeIATask(id: "first", projectId: "project-2", customColumnId: "first"),
            makeIATask(id: "hold", projectId: "project-1", customColumnId: "hold"),
            makeIATask(id: "waiting", projectId: "project-1", status: .inProgress)
        ]

        let tiers = TaskReadiness.tiers(tasks: tasks, projects: [first, second])

        #expect(tiers.map(\.id) == [
            "custom:project-2|first",
            "custom:project-2|later",
            "custom:project-1|hold",
            "waiting"
        ])
        #expect(tiers[1].tasks.map(\.id) == ["actionable-but-parked"])
    }

    @Test("Sorts P0 through P4, then oldest movedAt, then seq")
    func taskOrdering() {
        let tasks = [
            makeIATask(id: "p4", seq: 1, status: .reviewByUser, priority: .p4),
            makeIATask(
                id: "p1-new",
                seq: 2,
                status: .reviewByUser,
                priority: .p1,
                movedAt: "2026-03-01T00:00:00Z"
            ),
            makeIATask(
                id: "p1-old",
                seq: 9,
                status: .reviewByUser,
                priority: .p1,
                movedAt: "2026-01-01T00:00:00Z"
            ),
            makeIATask(id: "p0", seq: 3, status: .reviewByUser, priority: .p0),
            makeIATask(id: "p1-no-move-high", seq: 8, status: .reviewByUser, priority: .p1),
            makeIATask(id: "p1-no-move-low", seq: 4, status: .reviewByUser, priority: .p1)
        ]

        let tier = TaskReadiness.tiers(tasks: tasks, projects: [makeIAProject()])[0]

        #expect(tier.tasks.map(\.id) == [
            "p0",
            "p1-old",
            "p1-new",
            "p1-no-move-low",
            "p1-no-move-high",
            "p4"
        ])
    }
}
