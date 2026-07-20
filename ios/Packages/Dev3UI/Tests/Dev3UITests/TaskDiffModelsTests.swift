import Dev3Kit
@testable import Dev3UI
import Foundation
import Testing

@Suite("Native diff review")
struct TaskDiffModelsTests {
    @Test("Modes preserve recent counts and backend request values")
    func modes() {
        #expect(TaskDiffModeSelection.uncommitted.mode == .uncommitted)
        #expect(TaskDiffModeSelection.branch.mode == .branch)
        #expect(TaskDiffModeSelection.unpushed.mode == .unpushed)
        #expect(TaskDiffModeSelection.recent(3).mode == .recent)
        #expect(TaskDiffModeSelection.recent(3).count == 3)
        #expect(TaskDiffModeSelection.recent(0).count == 1)
        #expect(TaskDiffModeSelection.recent(1).displayName == "Last commit")
        #expect(TaskDiffModeSelection.recentPresets == [1, 2, 3, 5, 10])
    }

    @Test("Real unified fixture ignores git metadata and trailing separators")
    func parsesRealUnifiedFixture() throws {
        let hunk = """
        diff --git a/src/example.ts b/src/example.ts
        index 2db047d..acd91de 100644
        --- a/src/example.ts
        +++ b/src/example.ts
        @@ -10,3 +10,4 @@ export function example() {
         const before = true;
        -return before;
        +const after = false;
        +
         }

        """
        let file = try makeDiffFile(hunks: [hunk])

        let lines = TaskDiffLineParser.lines(for: file)

        #expect(lines.count == 6)
        #expect(lines.first?.kind == .hunkHeader)
        #expect(lines.first?.text.hasPrefix("@@") == true)
        #expect(lines.contains { $0.text.hasPrefix("diff --git") } == false)
        #expect(lines.contains { $0.text.hasPrefix("---") } == false)
        #expect(lines[1].oldLineNumber == 10)
        #expect(lines[1].newLineNumber == 10)
        #expect(lines[2].kind == .deletion)
        #expect(lines[2].oldLineNumber == 11)
        #expect(lines[3].kind == .addition)
        #expect(lines[3].newLineNumber == 11)
        #expect(lines[4].kind == .addition)
        #expect(lines[4].text.isEmpty)
        #expect(lines.last?.text == "}")
    }

    @Test("Content-only added files do not render a phantom final line")
    func addedFileFallback() throws {
        let file = try makeDiffFile(
            status: "added",
            oldContent: "",
            newContent: "let one = 1\nlet two = 2\n",
            hunks: nil
        )

        let lines = TaskDiffLineParser.lines(for: file)

        #expect(lines.map(\.kind) == [.addition, .addition])
        #expect(lines.map(\.newLineNumber) == [1, 2])
        #expect(lines.map(\.text) == ["let one = 1", "let two = 2"])
    }

    @Test("Modified files without hunks diff line-by-line instead of whole-file replace")
    func modifiedFileFallbackProducesLineDiff() throws {
        let file = try makeDiffFile(
            status: "modified",
            oldContent: "line 1\nline 2\nline 3\n",
            newContent: "line 1\nline 2 changed\nline 3\nline 4\n",
            hunks: nil
        )

        let lines = TaskDiffLineParser.lines(for: file)

        let context = lines.filter { $0.kind == .context }.map(\.text)
        #expect(context.contains("line 1"))
        #expect(context.contains("line 3"))
        #expect(lines.filter { $0.kind == .deletion }.map(\.text) == ["line 2"])
        #expect(lines.filter { $0.kind == .addition }.map(\.text) == ["line 2 changed", "line 4"])
        // An unchanged line must appear exactly once (as context), never as delete + add.
        #expect(lines.filter { $0.text == "line 1" }.count == 1)
    }

    @Test("Appending to an unchanged file yields only additions, no phantom deletions")
    func appendOnlyFallbackHasNoPhantomDeletions() throws {
        let old = (1 ... 20).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let new = old + "line 21\nline 22\n"
        let file = try makeDiffFile(status: "modified", oldContent: old, newContent: new, hunks: nil)

        let lines = TaskDiffLineParser.lines(for: file)

        // Reproduces the "+2 −0" AGENTS.md report: unchanged body must stay context.
        #expect(!lines.contains { $0.kind == .deletion })
        #expect(lines.filter { $0.kind == .addition }.map(\.text) == ["line 21", "line 22"])
        #expect(lines.filter { $0.kind == .context }.count == 20)
        // Line numbers stay monotonic across the whole file.
        #expect(lines.compactMap(\.newLineNumber) == Array(1 ... 22))
    }

    @Test("A large single-edit fallback diff stays within budget", .timeLimit(.minutes(1)))
    func largeFallbackDiffPerformance() throws {
        let oldBody = (1 ... 2000).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let newBody = oldBody.replacingOccurrences(of: "line 1000", with: "line 1000 edited")
        let files = try (0 ..< 60).map { index in
            try makeDiffFile(
                id: "file-\(index)",
                path: "Sources/File\(index).swift",
                status: "modified",
                oldContent: oldBody,
                newContent: newBody,
                hunks: nil
            )
        }

        let clock = ContinuousClock()
        var total = 0
        let elapsed = clock.measure {
            total = files.reduce(into: 0) { $0 += TaskDiffLineParser.lines(for: $1).count }
        }

        #expect(files.count == 60)
        // 2000 context-ish lines + 1 delete + 1 add per file (prefix/suffix trim keeps it linear).
        #expect(total == 60 * 2001)
        #expect(elapsed < .seconds(5))
    }

    @Test("Read identity is stable for unchanged content and invalidates stale content")
    func readSignatureTracksContent() throws {
        let first = try makeDiffFile(newContent: "export const version = 1;\n")
        let same = try makeDiffFile(newContent: "export const version = 1;\n")
        let changed = try makeDiffFile(newContent: "export const version = 2;\n")

        let firstSignature = TaskDiffReadSignature.make(taskID: "task", file: first)
        #expect(firstSignature == TaskDiffReadSignature.make(taskID: "task", file: same))
        #expect(firstSignature != TaskDiffReadSignature.make(taskID: "task", file: changed))
        #expect(
            TaskDiffReadSignature.make(taskID: "task-a", file: first)
                != TaskDiffReadSignature.make(taskID: "task-b", file: first)
        )
    }

    @Test("Native lexer highlights common Swift and TypeScript tokens without a web runtime")
    func syntaxHighlighting() {
        let swift = TaskDiffSyntaxHighlighter.fragments(
            in: "let count = 42 // result",
            path: "Feature.swift"
        )
        #expect(swift.contains(TaskDiffSyntaxFragment(text: "let", role: .keyword)))
        #expect(swift.contains(TaskDiffSyntaxFragment(text: "42", role: .number)))
        #expect(swift.last == TaskDiffSyntaxFragment(text: "// result", role: .comment))

        let typeScript = TaskDiffSyntaxHighlighter.fragments(
            in: "const title = `dev3`;",
            path: "feature.ts"
        )
        #expect(typeScript.contains(TaskDiffSyntaxFragment(text: "const", role: .keyword)))
        #expect(typeScript.contains(TaskDiffSyntaxFragment(text: "`dev3`", role: .string)))

        let json = TaskDiffSyntaxHighlighter.fragments(in: #""status": true"#, path: "task.json")
        #expect(json.contains(TaskDiffSyntaxFragment(text: #""status""#, role: .property)))
    }

    @Test("A 120-file fixture parses within the review-screen performance budget", .timeLimit(.minutes(1)))
    func largeDiffFixture() throws {
        let repeatedLines = (1 ... 80).map { " line \($0)" }.joined(separator: "\n")
        let hunk = "@@ -1,80 +1,81 @@\n\(repeatedLines)\n+new line\n"
        let files = try (0 ..< 120).map { index in
            try makeDiffFile(id: "file-\(index)", path: "Sources/File\(index).swift", hunks: [hunk])
        }

        let clock = ContinuousClock()
        var parsedLineCount = 0
        let elapsed = clock.measure {
            parsedLineCount = files.reduce(into: 0) { count, file in
                count += TaskDiffLineParser.lines(for: file).count
            }
        }

        #expect(files.count == 120)
        #expect(parsedLineCount == 120 * 82)
        #expect(elapsed < .seconds(5))
    }
}

private func makeDiffFile(
    id: String = "src/example.ts",
    path: String = "src/example.ts",
    status: String = "modified",
    oldContent: String = "export const version = 0;\n",
    newContent: String = "export const version = 1;\n",
    hunks: [String]? = ["@@ -1 +1 @@\n-export const version = 0;\n+export const version = 1;\n"]
) throws -> Dev3TaskDiffFile {
    var object: [String: Any] = [
        "id": id,
        "status": status,
        "displayPath": path,
        "oldPath": path,
        "newPath": path,
        "oldContent": oldContent,
        "newContent": newContent,
        "insertions": 1,
        "deletions": 1
    ]
    object["hunks"] = hunks
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(Dev3TaskDiffFile.self, from: data)
}
