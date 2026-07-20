import Dev3Kit
import Foundation

// SwiftFormat keeps simple switch cases compact.
// swiftlint:disable switch_case_on_newline

public enum TaskDiffFileStatus: String, CaseIterable, Sendable {
    case added
    case modified
    case deleted
    case renamed
    case copied
    case typeChanged = "type-changed"
    case untracked
    case unknown

    public init(wireValue: String) {
        self = Self(rawValue: wireValue) ?? .unknown
    }

    public var badge: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .copied: "C"
        case .typeChanged: "T"
        case .untracked: "?"
        case .unknown: "•"
        }
    }

    public var displayName: String {
        switch self {
        case .added: "Added"
        case .modified: "Modified"
        case .deleted: "Deleted"
        case .renamed: "Renamed"
        case .copied: "Copied"
        case .typeChanged: "Type changed"
        case .untracked: "Untracked"
        case .unknown: "Unknown"
        }
    }
}

public enum TaskDiffSkippedReason: String, Sendable {
    case binary
    case tooLarge = "too-large"
    case unknown

    public init(wireValue: String) {
        self = Self(rawValue: wireValue) ?? .unknown
    }

    public var displayName: String {
        switch self {
        case .binary: "Binary file"
        case .tooLarge: "Too large to display"
        case .unknown: "Unavailable"
        }
    }
}

public enum TaskDiffModeSelection: Equatable, Hashable, Identifiable, Sendable {
    case uncommitted
    case branch
    case unpushed
    case recent(Int)

    public static let recentPresets = [1, 2, 3, 5, 10]

    public var id: String {
        switch self {
        case .uncommitted: "uncommitted"
        case .branch: "branch"
        case .unpushed: "unpushed"
        case let .recent(count): "recent:\(count)"
        }
    }

    public var mode: Dev3TaskDiffMode {
        switch self {
        case .uncommitted: .uncommitted
        case .branch: .branch
        case .unpushed: .unpushed
        case .recent: .recent
        }
    }

    public var count: Int? {
        guard case let .recent(count) = self else { return nil }
        return max(1, count)
    }

    public var displayName: String {
        switch self {
        case .uncommitted: "Uncommitted"
        case .branch: "Branch"
        case .unpushed: "Unpushed"
        case .recent(1): "Last commit"
        case let .recent(count): "Last \(max(1, count)) commits"
        }
    }
}

public struct TaskDiffFileSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let path: String
    public let status: TaskDiffFileStatus
    public let insertions: Int
    public let deletions: Int
    public let skippedReason: TaskDiffSkippedReason?
    public let oldSize: Int?
    public let newSize: Int?

    public init(file: Dev3TaskDiffFile) {
        id = file.id
        path = file.displayPath
        status = TaskDiffFileStatus(wireValue: file.status)
        insertions = file.insertions
        deletions = file.deletions
        skippedReason = nil
        oldSize = nil
        newSize = nil
    }

    public init(skippedFile: Dev3SkippedDiffFile) {
        id = skippedFile.id
        path = skippedFile.displayPath
        status = TaskDiffFileStatus(wireValue: skippedFile.status)
        insertions = 0
        deletions = 0
        skippedReason = TaskDiffSkippedReason(wireValue: skippedFile.reason)
        oldSize = skippedFile.oldSize
        newSize = skippedFile.newSize
    }
}

public enum TaskDiffLineKind: Equatable, Sendable {
    case hunkHeader
    case context
    case addition
    case deletion
    case note
}

public struct TaskDiffLine: Equatable, Identifiable, Sendable {
    public let id: Int
    public let kind: TaskDiffLineKind
    public let oldLineNumber: Int?
    public let newLineNumber: Int?
    public let text: String

    public init(
        id: Int,
        kind: TaskDiffLineKind,
        oldLineNumber: Int?,
        newLineNumber: Int?,
        text: String
    ) {
        self.id = id
        self.kind = kind
        self.oldLineNumber = oldLineNumber
        self.newLineNumber = newLineNumber
        self.text = text
    }
}

public enum TaskDiffLineParser {
    // The parser intentionally keeps old/new counters and output identity in one pass.
    // swiftlint:disable:next function_body_length
    public static func lines(for file: Dev3TaskDiffFile) -> [TaskDiffLine] {
        guard let hunks = file.hunks, !hunks.isEmpty else {
            return fallbackLines(for: file)
        }

        var result: [TaskDiffLine] = []
        var nextID = 0
        for hunk in hunks {
            var oldLine = 0
            var newLine = 0
            var reachedHunkHeader = false
            let rawLines = hunk.split(separator: "\n", omittingEmptySubsequences: false)
            for (lineIndex, rawLine) in rawLines.enumerated() {
                let line = String(rawLine)
                if lineIndex == rawLines.indices.last, line.isEmpty {
                    continue
                }
                if !reachedHunkHeader, !line.hasPrefix("@@") {
                    continue
                }
                let kind: TaskDiffLineKind
                let oldNumber: Int?
                let newNumber: Int?
                let content: String

                if line.hasPrefix("@@") {
                    reachedHunkHeader = true
                    let ranges = hunkRanges(from: line)
                    oldLine = ranges.old
                    newLine = ranges.new
                    kind = .hunkHeader
                    oldNumber = nil
                    newNumber = nil
                    content = line
                } else if line.hasPrefix("+") {
                    kind = .addition
                    oldNumber = nil
                    newNumber = newLine
                    newLine += 1
                    content = String(line.dropFirst())
                } else if line.hasPrefix("-") {
                    kind = .deletion
                    oldNumber = oldLine
                    newNumber = nil
                    oldLine += 1
                    content = String(line.dropFirst())
                } else if line.hasPrefix("\\") {
                    kind = .note
                    oldNumber = nil
                    newNumber = nil
                    content = line
                } else {
                    kind = .context
                    oldNumber = oldLine
                    newNumber = newLine
                    oldLine += 1
                    newLine += 1
                    content = line.first == " " ? String(line.dropFirst()) : line
                }

                result.append(
                    TaskDiffLine(
                        id: nextID,
                        kind: kind,
                        oldLineNumber: oldNumber,
                        newLineNumber: newNumber,
                        text: content
                    )
                )
                nextID += 1
            }
        }
        return result
    }

    private static func fallbackLines(for file: Dev3TaskDiffFile) -> [TaskDiffLine] {
        let status = TaskDiffFileStatus(wireValue: file.status)
        if status == .deleted {
            return contentLines(file.oldContent)
                .enumerated()
                .map { index, line in
                    TaskDiffLine(
                        id: index,
                        kind: .deletion,
                        oldLineNumber: index + 1,
                        newLineNumber: nil,
                        text: line
                    )
                }
        }
        if status == .added || status == .untracked || file.oldContent.isEmpty {
            return contentLines(file.newContent)
                .enumerated()
                .map { index, line in
                    TaskDiffLine(
                        id: index,
                        kind: .addition,
                        oldLineNumber: nil,
                        newLineNumber: index + 1,
                        text: line
                    )
                }
        }

        return lineDiff(old: contentLines(file.oldContent), new: contentLines(file.newContent))
    }

    /// Computes a line-level diff when the backend sends full file contents
    /// without unified-diff hunks (`hunks == nil` for every file today). Trims
    /// the common prefix and suffix — which handles append/prepend/single-region
    /// edits cheaply and correctly — then runs an LCS over the differing middle
    /// so unchanged interior lines stay `.context` instead of being rendered as a
    /// deletion followed by an addition (the previous whole-file-replace bug).
    static func lineDiff(old: [String], new: [String]) -> [TaskDiffLine] {
        var result: [TaskDiffLine] = []
        var nextID = 0
        var oldNumber = 1
        var newNumber = 1
        func append(_ kind: TaskDiffLineKind, oldNo: Int?, newNo: Int?, _ text: String) {
            result.append(
                TaskDiffLine(id: nextID, kind: kind, oldLineNumber: oldNo, newLineNumber: newNo, text: text)
            )
            nextID += 1
        }

        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] {
            prefix += 1
        }
        var oldEnd = old.count
        var newEnd = new.count
        while oldEnd > prefix, newEnd > prefix, old[oldEnd - 1] == new[newEnd - 1] {
            oldEnd -= 1
            newEnd -= 1
        }

        for index in 0 ..< prefix {
            append(.context, oldNo: oldNumber, newNo: newNumber, old[index])
            oldNumber += 1
            newNumber += 1
        }
        for entry in middleDiff(old: Array(old[prefix ..< oldEnd]), new: Array(new[prefix ..< newEnd])) {
            switch entry.kind {
            case .context:
                append(.context, oldNo: oldNumber, newNo: newNumber, entry.text)
                oldNumber += 1
                newNumber += 1
            case .deletion:
                append(.deletion, oldNo: oldNumber, newNo: nil, entry.text)
                oldNumber += 1
            case .addition:
                append(.addition, oldNo: nil, newNo: newNumber, entry.text)
                newNumber += 1
            case .hunkHeader, .note:
                break
            }
        }
        for index in newEnd ..< new.count {
            append(.context, oldNo: oldNumber, newNo: newNumber, new[index])
            oldNumber += 1
            newNumber += 1
        }
        return result
    }

    private struct MiddleLine {
        let kind: TaskDiffLineKind
        let text: String
    }

    /// Caps the LCS table so a large, fully-rewritten region degrades to a plain
    /// delete-then-add instead of blowing the review-screen time/memory budget.
    private static let maxLCSCells = 1_000_000

    private static func middleDiff(old: [String], new: [String]) -> [MiddleLine] {
        if old.isEmpty {
            return new.map { MiddleLine(kind: .addition, text: $0) }
        }
        if new.isEmpty {
            return old.map { MiddleLine(kind: .deletion, text: $0) }
        }
        if old.count * new.count > maxLCSCells {
            return old.map { MiddleLine(kind: .deletion, text: $0) }
                + new.map { MiddleLine(kind: .addition, text: $0) }
        }

        let rows = old.count
        let cols = new.count
        var lcs = Array(repeating: Array(repeating: 0, count: cols + 1), count: rows + 1)
        for row in stride(from: rows - 1, through: 0, by: -1) {
            for col in stride(from: cols - 1, through: 0, by: -1) {
                lcs[row][col] = old[row] == new[col]
                    ? lcs[row + 1][col + 1] + 1
                    : max(lcs[row + 1][col], lcs[row][col + 1])
            }
        }

        var result: [MiddleLine] = []
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < rows, newIndex < cols {
            if old[oldIndex] == new[newIndex] {
                result.append(MiddleLine(kind: .context, text: old[oldIndex]))
                oldIndex += 1
                newIndex += 1
            } else if lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1] {
                result.append(MiddleLine(kind: .deletion, text: old[oldIndex]))
                oldIndex += 1
            } else {
                result.append(MiddleLine(kind: .addition, text: new[newIndex]))
                newIndex += 1
            }
        }
        while oldIndex < rows {
            result.append(MiddleLine(kind: .deletion, text: old[oldIndex]))
            oldIndex += 1
        }
        while newIndex < cols {
            result.append(MiddleLine(kind: .addition, text: new[newIndex]))
            newIndex += 1
        }
        return result
    }

    private static func contentLines(_ content: String) -> [String] {
        var lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.last?.isEmpty == true {
            lines.removeLast()
        }
        return lines
    }

    private static func hunkRanges(from header: String) -> (old: Int, new: Int) {
        let parts = header.split(separator: " ")
        let old = parts.first(where: { $0.hasPrefix("-") }).flatMap(rangeStart) ?? 0
        let new = parts.first(where: { $0.hasPrefix("+") }).flatMap(rangeStart) ?? 0
        return (old, new)
    }

    private static func rangeStart(_ token: Substring) -> Int? {
        let value = token.dropFirst().split(separator: ",", maxSplits: 1).first
        return value.flatMap { Int($0) }
    }
}

public enum TaskDiffReadSignature {
    public static func make(taskID: String, file: Dev3TaskDiffFile) -> String {
        let payload = [
            file.hunks?.joined(separator: "\n") ?? "",
            file.oldContent,
            file.newContent,
            file.oldPath ?? "",
            file.newPath ?? ""
        ].joined(separator: "\u{1f}")
        return "\(taskID):\(file.id):\(hash(payload))"
    }

    public static func make(taskID: String, skippedFile: Dev3SkippedDiffFile) -> String {
        let payload = [
            skippedFile.status,
            skippedFile.reason,
            skippedFile.oldPath ?? "",
            skippedFile.newPath ?? "",
            skippedFile.oldSize.map(String.init) ?? "",
            skippedFile.newSize.map(String.init) ?? ""
        ].joined(separator: "\u{1f}")
        return "\(taskID):\(skippedFile.id):\(hash(payload))"
    }

    private static func hash(_ value: String) -> String {
        var hash: UInt64 = 5381
        for byte in value.utf8 {
            hash = ((hash << 5) &+ hash) ^ UInt64(byte)
        }
        return String(hash, radix: 36)
    }
}

// swiftlint:enable switch_case_on_newline
