@testable import Dev3Kit
import Foundation
import Testing

@Suite("Remote wire models")
struct RemoteModelsTests {
    private let decoder = JSONDecoder()

    @Test("Task and project fixtures capture the canonical v1 fields")
    func taskAndProjectFixtures() throws {
        let project = try decoder.decode(Dev3Project.self, from: Data(projectFixture.utf8))
        #expect(project.id == "project-1")
        #expect(project.kind == .git)
        #expect(project.labels == [Dev3Label(id: "label-1", name: "ios", color: "#3b82f6")])
        #expect(project.portCount == 2)
        #expect(project.builtinColumnAgents?["review-by-ai"]?.agentId == "builtin-codex")

        let task = try decoder.decode(Dev3Task.self, from: Data(taskFixture.utf8))
        #expect(task.id == "task-1")
        #expect(task.status == .userQuestions)
        #expect(task.priority == .p1)
        #expect(task.displayTitle == "Native transport")
        #expect(task.displayOverview == "Pinned by user")
        #expect(task.notes?.first?.source == .ai)
        #expect(task.sessionState?.panes.first?.paneId == "%7")
        #expect(task.prStatusCache?.checks.first?.name == "tests")
        #expect(task.effectivePriority == .p1)
        #expect(task.sharedImages?.first?.caption == "Inspect this")
        #expect(task.sharedArtifacts?.first?.title == "Native report")
    }

    @Test("Legacy tasks default missing priority to P3")
    func legacyTaskPriority() throws {
        let legacy = taskFixture.replacingOccurrences(of: ",\"priority\":\"P1\"", with: "")
        let task = try decoder.decode(Dev3Task.self, from: Data(legacy.utf8))
        #expect(task.priority == nil)
        #expect(task.effectivePriority == .p3)
    }

    @Test("All task statuses and priorities preserve their wire spelling")
    func taskEnums() throws {
        let encoder = JSONEncoder()
        for status in Dev3TaskStatus.allCases {
            let decoded = try decoder.decode(Dev3TaskStatus.self, from: encoder.encode(status))
            #expect(decoded == status)
        }
        #expect(Dev3TaskStatus.inProgress.rawValue == "in-progress")
        #expect(Dev3TaskStatus.reviewByColleague.rawValue == "review-by-colleague")
        #expect(Dev3TaskPriority.allCases.map(\.rawValue) == ["P0", "P1", "P2", "P3", "P4"])
    }

    @Test("JSONValue round-trips nested unknown payloads without dropping integers")
    func jsonValueRoundTrip() throws {
        let value: JSONValue = .object([
            "ok": .bool(true),
            "count": .integer(7),
            "ratio": .number(1.5),
            "items": .array([.string("a"), .null])
        ])
        let data = try JSONEncoder().encode(value)
        #expect(try decoder.decode(JSONValue.self, from: data) == value)
    }

    @Test("PTY resolution distinguishes a ready URL from recoverable session state")
    func ptyResolution() throws {
        let ready = try decoder.decode(
            Dev3PTYResolution.self,
            from: Data(#"{"url":"ws://localhost/pty?session=task-1"}"#.utf8)
        )
        #expect(ready == .ready(url: "ws://localhost/pty?session=task-1"))

        let recoverableJSON = #"""
        {"recoverable":true,"sessionState":{"panes":[
          {"paneId":"%1","agentCmd":"codex","sessionId":"s1","agentId":"builtin-codex","configId":"luna"}
        ]}}
        """#
        let recoverable = try decoder.decode(Dev3PTYResolution.self, from: Data(recoverableJSON.utf8))
        guard case let .needsResume(state) = recoverable else {
            Issue.record("Expected needsResume")
            return
        }
        #expect(state.panes.first?.sessionId == "s1")
    }

    @Test("Unknown additive fields do not break a known model")
    func additiveCompatibility() throws {
        let json = #"""
        {"version":"1.35.2","channel":"dev","buildChannel":"staging",
         "futureField":{"nested":true}}
        """#
        let data = Data(json.utf8)
        let version = try decoder.decode(Dev3AppVersion.self, from: data)
        #expect(version.version == "1.35.2")
        #expect(version.buildChannel == "staging")
    }

    private var projectFixture: String {
        #"""
        {
          "id":"project-1","name":"dev3","path":"/repo","setupScript":"bun install",
          "devScript":"bun run dev","cleanupScript":"","defaultBaseBranch":"main",
          "createdAt":"2026-07-16T10:00:00.000Z","labels":[{"id":"label-1","name":"ios","color":"#3b82f6"}],
          "customColumns":[],"columnOrder":["todo","in-progress"],"autoReviewEnabled":true,
          "peerReviewEnabled":true,"portCount":2,"kind":"git",
          "builtinColumnAgents":{"review-by-ai":{
            "agentId":"builtin-codex","configId":"luna","prompt":"Review"
          }},
          "futureField":"ignored"
        }
        """#
    }

    private var taskFixture: String {
        #"""
        {
          "id":"task-1","seq":969,"projectId":"project-1","title":"Generated title",
          "description":"Implement native transport","overview":"Agent overview",
          "userOverview":"Pinned by user",
          "customTitle":"Native transport","status":"user-questions","priority":"P1","baseBranch":"main",
          "worktreePath":"/worktree","branchName":"feat/ios","prNumber":969,"prUrl":"https://example.test/969",
          "prStatusCache":{"number":969,"url":"https://example.test/969","ciStatus":"success","reviewState":"approved",
            "unresolvedCount":0,"mergeState":{"mergeable":"MERGEABLE","status":"CLEAN"},
            "checks":[{"name":"tests","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":null}],
            "prTitle":"Native app","isDraft":false,"cachedAt":"2026-07-16T10:00:00.000Z"},
          "groupId":null,"variantIndex":null,"agentId":"builtin-codex","configId":"luna",
          "createdAt":"2026-07-16T09:00:00.000Z",
          "updatedAt":"2026-07-16T10:00:00.000Z","labelIds":["label-1"],
          "notes":[{"id":"note-1","content":"Protocol pinned","source":"ai",
            "createdAt":"2026-07-16T09:30:00.000Z","updatedAt":"2026-07-16T09:30:00.000Z"}],
          "watched":true,"sessionState":{"panes":[{"paneId":"%7","agentCmd":"codex",
            "sessionId":"session-1","agentId":"builtin-codex","configId":"luna"}]},
          "statusDurations":{"in-progress":120000},
          "statusEnteredAt":"2026-07-16T10:00:00.000Z","focusMs":5000,
          "sharedImages":[{"id":"image-1","storedPath":"/worktree/shared-images/image.png",
            "originalPath":"/tmp/image.png","name":"image.png","mime":"image/png","bytes":3,
            "caption":"Inspect this","createdAt":1710000000000}],
          "sharedArtifacts":[{"id":"artifact-1","kind":"html","title":"Native report",
            "name":"report.html","storedPath":"/worktree/shared-artifacts/report.html",
            "originalPath":"/tmp/report.html","bytes":20,"createdAt":1710000001000,"assets":[]}],
          "futureField":{"safe":true}
        }
        """#
    }
}
