import Foundation
import SwiftUI

// SwiftFormat keeps simple switch cases compact and places wrapped-condition braces on a new line.
// swiftlint:disable opening_brace switch_case_on_newline

public enum TaskDiffSyntaxRole: Equatable, Sendable {
    case plain
    case keyword
    case string
    case number
    case comment
    case property
}

public struct TaskDiffSyntaxFragment: Equatable, Sendable {
    public let text: String
    public let role: TaskDiffSyntaxRole

    public init(text: String, role: TaskDiffSyntaxRole) {
        self.text = text
        self.role = role
    }
}

public enum TaskDiffSyntaxHighlighter {
    public static func fragments(in source: String, path: String) -> [TaskDiffSyntaxFragment] {
        let language = language(for: path)
        guard language != .plain, !source.isEmpty else {
            return [TaskDiffSyntaxFragment(text: source, role: .plain)]
        }

        let characters = Array(source)
        var result: [TaskDiffSyntaxFragment] = []
        var index = 0
        while index < characters.count {
            if let marker = commentMarker(at: index, characters: characters, language: language) {
                append(String(characters[index...]), role: .comment, to: &result)
                index += marker.count
                break
            }

            let character = characters[index]
            if character == "\"" || character == "'" || (character == "`" && language.supportsBackticks) {
                let end = stringEnd(startingAt: index, quote: character, characters: characters)
                let role = stringRole(endingAt: end, characters: characters, language: language)
                append(String(characters[index ..< end]), role: role, to: &result)
                index = end
                continue
            }

            if character.isNumber {
                let end = consumeNumber(startingAt: index, characters: characters)
                append(String(characters[index ..< end]), role: .number, to: &result)
                index = end
                continue
            }

            if isIdentifierStart(character) {
                let end = consumeIdentifier(startingAt: index, characters: characters)
                let word = String(characters[index ..< end])
                let role: TaskDiffSyntaxRole = if language.keywords.contains(word) {
                    .keyword
                } else if language == .json, nextNonWhitespace(after: end, characters: characters) == ":" {
                    .property
                } else {
                    .plain
                }
                append(word, role: role, to: &result)
                index = end
                continue
            }

            append(String(character), role: .plain, to: &result)
            index += 1
        }
        return result
    }

    public static func attributedString(
        for source: String,
        path: String,
        palette: Dev3ThemePalette
    ) -> AttributedString {
        var result = AttributedString()
        for fragment in fragments(in: source, path: path) {
            var attributed = AttributedString(fragment.text)
            attributed.foregroundColor = color(for: fragment.role, palette: palette)
            result.append(attributed)
        }
        return result
    }

    private static func color(for role: TaskDiffSyntaxRole, palette: Dev3ThemePalette) -> Color {
        switch role {
        case .plain: palette.textSecondary
        case .keyword: palette.accent
        case .string: palette.success
        case .number: palette.warning
        case .comment: palette.textMuted
        case .property: palette.color(.chart2)
        }
    }

    private static func append(
        _ text: String,
        role: TaskDiffSyntaxRole,
        to fragments: inout [TaskDiffSyntaxFragment]
    ) {
        guard !text.isEmpty else { return }
        if fragments.last?.role == role {
            let previous = fragments.removeLast()
            fragments.append(TaskDiffSyntaxFragment(text: previous.text + text, role: role))
        } else {
            fragments.append(TaskDiffSyntaxFragment(text: text, role: role))
        }
    }
}

private extension TaskDiffSyntaxHighlighter {
    enum Language: Equatable {
        case swift
        case javascript
        case python
        case shell
        case json
        case yaml
        case plain

        var keywords: Set<String> {
            switch self {
            case .swift:
                [
                    "actor", "any", "as", "async", "await", "break", "case", "catch", "class",
                    "continue", "default", "defer", "do", "else", "enum", "extension", "false", "for",
                    "func", "guard", "if", "import", "in", "init", "let", "nil", "nonisolated",
                    "private", "protocol", "public", "repeat", "return", "self", "some", "static",
                    "struct", "switch", "throw", "throws", "true", "try", "var", "where", "while"
                ]
            case .javascript:
                [
                    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
                    "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
                    "for", "function", "if", "import", "in", "instanceof", "interface", "let", "new",
                    "null", "private", "public", "return", "static", "super", "switch", "this", "throw",
                    "true", "try", "type", "typeof", "undefined", "var", "while", "yield"
                ]
            case .python:
                [
                    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
                    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
                    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
                    "return", "try", "while", "with", "yield"
                ]
            case .shell:
                [
                    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function",
                    "if", "in", "local", "readonly", "select", "then", "until", "while"
                ]
            case .json:
                ["false", "null", "true"]
            case .yaml:
                ["false", "null", "true", "yes", "no"]
            case .plain:
                []
            }
        }

        var supportsBackticks: Bool {
            self == .javascript || self == .shell
        }
    }

    static func language(for path: String) -> Language {
        let filename = URL(fileURLWithPath: path).lastPathComponent.lowercased()
        let extensionName = URL(fileURLWithPath: path).pathExtension.lowercased()
        switch extensionName {
        case "swift": return .swift
        case "js", "jsx", "mjs", "cjs", "ts", "tsx": return .javascript
        case "py", "pyi": return .python
        case "sh", "bash", "zsh", "fish": return .shell
        case "json", "jsonc": return .json
        case "yaml", "yml": return .yaml
        default:
            if ["dockerfile", "makefile"].contains(filename) {
                return .shell
            }
            return .plain
        }
    }

    static func commentMarker(
        at index: Int,
        characters: [Character],
        language: Language
    ) -> String? {
        if language == .swift || language == .javascript,
           index + 1 < characters.count,
           characters[index] == "/",
           characters[index + 1] == "/"
        {
            return "//"
        }
        if language == .python || language == .shell || language == .yaml,
           characters[index] == "#"
        {
            return "#"
        }
        return nil
    }

    static func stringEnd(
        startingAt start: Int,
        quote: Character,
        characters: [Character]
    ) -> Int {
        var index = start + 1
        var escaped = false
        while index < characters.count {
            let character = characters[index]
            if escaped {
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == quote {
                return index + 1
            }
            index += 1
        }
        return characters.count
    }

    static func stringRole(
        endingAt end: Int,
        characters: [Character],
        language: Language
    ) -> TaskDiffSyntaxRole {
        if language == .json,
           nextNonWhitespace(after: end, characters: characters) == ":"
        {
            return .property
        }
        return .string
    }

    static func consumeNumber(startingAt start: Int, characters: [Character]) -> Int {
        var index = start + 1
        let allowedNumberCharacters: [Character] = [
            ".", "_", "x", "X", "a", "b", "c", "d", "e", "f"
        ]
        while index < characters.count,
              characters[index].isNumber || allowedNumberCharacters.contains(characters[index])
        {
            index += 1
        }
        return index
    }

    static func consumeIdentifier(startingAt start: Int, characters: [Character]) -> Int {
        var index = start + 1
        while index < characters.count,
              characters[index].isLetter || characters[index].isNumber || characters[index] == "_"
        {
            index += 1
        }
        return index
    }

    static func isIdentifierStart(_ character: Character) -> Bool {
        character.isLetter || character == "_"
    }

    static func nextNonWhitespace(after start: Int, characters: [Character]) -> Character? {
        var index = start
        while index < characters.count {
            if !characters[index].isWhitespace {
                return characters[index]
            }
            index += 1
        }
        return nil
    }
}

// swiftlint:enable opening_brace switch_case_on_newline
