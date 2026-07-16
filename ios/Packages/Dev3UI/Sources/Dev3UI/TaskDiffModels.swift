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

    // swiftlint:disable:next function_body_length
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

        var result: [TaskDiffLine] = []
        for (index, line) in contentLines(file.oldContent).enumerated() {
            result.append(
                TaskDiffLine(
                    id: result.count,
                    kind: .deletion,
                    oldLineNumber: index + 1,
                    newLineNumber: nil,
                    text: line
                )
            )
        }
        for (index, line) in contentLines(file.newContent).enumerated() {
            result.append(
                TaskDiffLine(
                    id: result.count,
                    kind: .addition,
                    oldLineNumber: nil,
                    newLineNumber: index + 1,
                    text: line
                )
            )
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
