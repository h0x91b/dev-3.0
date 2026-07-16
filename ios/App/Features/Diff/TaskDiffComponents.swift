import Dev3Kit
import Dev3UI
import SwiftUI

// SwiftFormat keeps simple switch cases compact.
// swiftlint:disable switch_case_on_newline

struct TaskDiffFileSummaryRow: View {
    let summary: TaskDiffFileSummary
    let isRead: Bool
    let palette: Dev3ThemePalette

    var body: some View {
        HStack(spacing: 8) {
            Text(summary.status.badge)
                .font(.caption2.monospaced().bold())
                .foregroundStyle(statusColor)
                .frame(width: 22, height: 22)
                .background(statusColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.path)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .foregroundStyle(isRead ? palette.textMuted : palette.textSecondary)
                if let reason = summary.skippedReason {
                    Text(reason.displayName)
                        .font(.caption2)
                        .foregroundStyle(palette.textMuted)
                } else {
                    HStack(spacing: 6) {
                        Text("+\(summary.insertions)").foregroundStyle(palette.success)
                        Text("−\(summary.deletions)").foregroundStyle(palette.danger)
                    }
                    .font(.caption2.monospacedDigit())
                }
            }
            Spacer(minLength: 4)
            if isRead {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(palette.textMuted)
                    .accessibilityLabel("Read")
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 50)
        .contentShape(Rectangle())
    }

    private var statusColor: Color {
        switch summary.status {
        case .added, .untracked: palette.success
        case .deleted: palette.danger
        case .renamed, .copied: palette.accent
        default: palette.textSecondary
        }
    }
}

struct TaskDiffFileSection: View {
    let file: Dev3TaskDiffFile
    let isRead: Bool
    let palette: Dev3ThemePalette
    let onToggleRead: @MainActor () async -> Void
    @State private var lines: [TaskDiffLine]?
    @State private var isExpanded = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button { isExpanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                        Text(file.displayPath)
                            .font(.caption.monospaced().weight(.semibold))
                            .lineLimit(1)
                        Spacer()
                        Text("+\(file.insertions)").foregroundStyle(palette.success)
                        Text("−\(file.deletions)").foregroundStyle(palette.danger)
                    }
                    .padding(.leading, 10)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    isExpanded ? "Collapse \(file.displayPath)" : "Expand \(file.displayPath)"
                )

                Button {
                    Task { await onToggleRead() }
                } label: {
                    Image(systemName: isRead ? "checkmark.circle.fill" : "circle")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isRead ? "Mark file unread" : "Mark file read")
            }
            .padding(.trailing, 4)

            if isExpanded {
                Divider().overlay(palette.borderDefault)
                if let lines {
                    LazyVStack(spacing: 0) {
                        ForEach(lines) { line in
                            TaskDiffLineRow(line: line, path: file.displayPath, palette: palette)
                        }
                    }
                } else {
                    ProgressView().padding(20)
                }
            }
        }
        .background(palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(palette.borderDefault) }
        .opacity(isRead ? 0.68 : 1)
        .task(id: TaskDiffReadSignature.make(taskID: "render", file: file)) {
            lines = nil
            let parsed = await Task.detached(priority: .utility) {
                TaskDiffLineParser.lines(for: file)
            }.value
            guard !Task.isCancelled else { return }
            lines = parsed
        }
    }
}

private struct TaskDiffLineRow: View {
    let line: TaskDiffLine
    let path: String
    let palette: Dev3ThemePalette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(number(line.oldLineNumber))
                .frame(width: 38, alignment: .trailing)
            Text(number(line.newLineNumber))
                .frame(width: 38, alignment: .trailing)
            Text(prefix)
                .frame(width: 20)
                .foregroundStyle(prefixColor)
            Text(attributedContent)
                .textSelection(.enabled)
            Spacer(minLength: 8)
        }
        .font(.system(size: 12, weight: .regular, design: .monospaced))
        .foregroundStyle(palette.textMuted)
        .padding(.horizontal, 6)
        .padding(.vertical, line.kind == .hunkHeader ? 5 : 2)
        .background(background)
        .accessibilityElement(children: .combine)
    }

    private var attributedContent: AttributedString {
        guard line.kind != .hunkHeader, line.kind != .note else {
            var value = AttributedString(line.text)
            value.foregroundColor = palette.textTertiary
            return value
        }
        return TaskDiffSyntaxHighlighter.attributedString(for: line.text, path: path, palette: palette)
    }

    private var prefix: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        default: " "
        }
    }

    private var prefixColor: Color {
        switch line.kind {
        case .addition: palette.success
        case .deletion: palette.danger
        default: palette.textMuted
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: palette.success.opacity(0.08)
        case .deletion: palette.danger.opacity(0.08)
        case .hunkHeader: palette.accent.opacity(0.08)
        default: Color.clear
        }
    }

    private func number(_ value: Int?) -> String {
        value.map(String.init) ?? ""
    }
}

struct TaskDiffSkippedFileSection: View {
    let file: Dev3SkippedDiffFile
    let isRead: Bool
    let palette: Dev3ThemePalette
    let onToggleRead: @MainActor () async -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: file.reason == "binary" ? "doc.zipper" : "doc.badge.ellipsis")
                .foregroundStyle(file.reason == "binary" ? palette.accent : palette.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.displayPath)
                    .font(.caption.monospaced().weight(.semibold))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(palette.textTertiary)
            }
            Spacer()
            Button {
                Task { await onToggleRead() }
            } label: {
                Image(systemName: isRead ? "checkmark.circle.fill" : "circle")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel(isRead ? "Mark file unread" : "Mark file read")
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 60)
        .background(palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(palette.borderDefault) }
        .opacity(isRead ? 0.68 : 1)
    }

    private var detail: String {
        let reason = TaskDiffSkippedReason(wireValue: file.reason).displayName
        let oldSize = file.oldSize.map(formatBytes) ?? "—"
        let newSize = file.newSize.map(formatBytes) ?? "—"
        return "\(reason) · \(oldSize) → \(newSize)"
    }

    private func formatBytes(_ value: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
    }
}

@MainActor
struct TaskDiffCompareRefSheet: View {
    let store: TaskDiffStore
    @State private var draft: String
    @Environment(\.dismiss) private var dismiss

    init(store: TaskDiffStore) {
        self.store = store
        _draft = State(initialValue: store.compareRef)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Branch or ref", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
            }
            .navigationTitle("Compare reference")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        Task {
                            await store.updateCompareRef(draft)
                            dismiss()
                        }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// swiftlint:enable switch_case_on_newline
