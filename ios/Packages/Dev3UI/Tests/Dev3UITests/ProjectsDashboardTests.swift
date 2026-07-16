@testable import Dev3UI
import Testing

@Suite("Projects dashboard")
struct ProjectsDashboardTests {
    @Test("Projects report active and attention counts with last activity")
    func activitySummary() throws {
        let project = makeIAProject(id: "git", name: "Git")
        let tasks = [
            makeIATask(
                id: "question",
                projectId: "git",
                status: .userQuestions,
                createdAt: "2026-02-01T00:00:00Z"
            ),
            makeIATask(
                id: "working",
                projectId: "git",
                status: .inProgress,
                createdAt: "2026-03-01T00:00:00Z"
            ),
            makeIATask(id: "todo", projectId: "git", status: .todo),
            makeIATask(id: "done", projectId: "git", status: .completed)
        ]

        let item = try #require(ProjectsDashboardProjection.items(
            projects: [project],
            tasksByProject: ["git": tasks]
        ).first)

        #expect(item.activeTaskCount == 2)
        #expect(item.attentionTaskCount == 1)
        #expect(item.lastActivity == TaskOrdering.date("2026-03-01T00:00:00Z"))
        #expect(item.supportsGitActions)
    }

    @Test("Explicit attention joins status attention without double counting")
    func explicitAttention() throws {
        let project = makeIAProject()
        let tasks = [
            makeIATask(id: "question", status: .userQuestions),
            makeIATask(id: "working", status: .inProgress),
            makeIATask(id: "ai", status: .reviewByAI)
        ]

        let item = try #require(ProjectsDashboardProjection.items(
            projects: [project],
            tasksByProject: [project.id: tasks],
            explicitAttentionTaskIDs: ["question", "working"]
        ).first)

        #expect(item.attentionTaskCount == 2)
    }

    @Test("Built-in Operations is pinned and suppresses git actions")
    func operationsPlacement() {
        let git = makeIAProject(id: "git")
        let operations = makeIAProject(
            id: "ops",
            name: "Operations",
            kind: .virtual,
            builtin: true
        )

        let items = ProjectsDashboardProjection.items(
            projects: [git, operations],
            tasksByProject: [:]
        )

        #expect(items.map(\.id) == ["ops", "git"])
        #expect(!items[0].supportsGitActions)
        #expect(items[1].supportsGitActions)
    }
}
