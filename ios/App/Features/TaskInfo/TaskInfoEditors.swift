import Dev3Kit
import Dev3UI
import SwiftUI

@MainActor
struct TaskLabelsEditor: View {
    @Bindable var store: TaskInfoStore
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        List {
            if (store.project.labels ?? []).isEmpty {
                ContentUnavailableView(
                    "No labels",
                    systemImage: "tag",
                    description: Text("Create labels in the desktop app, then assign them here.")
                )
                .accessibilityIdentifier("taskInfo.labels.empty")
            } else {
                ForEach(Array((store.project.labels ?? []).enumerated()), id: \.element.id) { index, label in
                    Button {
                        Task { await store.toggleLabel(label.id) }
                    } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(palette.labelColor(at: labelPaletteIndex(label, fallback: index)))
                                .frame(width: 10, height: 10)
                                .accessibilityHidden(true)
                            Text(label.name)
                                .foregroundStyle(palette.textPrimary)
                            Spacer()
                            if selectedLabelIDs.contains(label.id) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(palette.accent)
                                    .accessibilityLabel("Selected")
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!store.canMutate)
                    .accessibilityIdentifier("taskInfo.label.\(label.id)")
                }
            }
        }
        .navigationTitle("Labels")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("taskInfo.labelsEditor")
    }

    private var selectedLabelIDs: Set<String> {
        Set(store.task.labelIds ?? [])
    }

    private func labelPaletteIndex(_ label: Dev3Label, fallback: Int) -> Int {
        let hash = label.id.unicodeScalars.reduce(fallback) { partialResult, scalar in
            partialResult + Int(scalar.value)
        }
        return hash % palette.labelValues.count
    }
}

@MainActor
struct TaskNoteSummary: View {
    let note: Dev3TaskNote

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(note.content.isEmpty ? "Empty note" : note.content)
                .lineLimit(3)
            Text(note.source == .user ? "Your note" : "Agent note")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

@MainActor
struct TaskNoteEditor: View {
    @Bindable var store: TaskInfoStore
    let note: Dev3TaskNote?

    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var confirmsDeletion = false

    init(store: TaskInfoStore, note: Dev3TaskNote?) {
        self.store = store
        self.note = note
        _content = State(initialValue: note?.content ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $content)
                    .frame(minHeight: 180)
                    .disabled(!store.isConnected)
                    .accessibilityIdentifier("taskInfo.noteEditor.content")
            } header: {
                Text(note == nil ? "New note" : "Note")
            } footer: {
                if note?.source == .ai {
                    Text("This note was added by an agent. Your edits will be saved as written.")
                }
            }

            if note != nil {
                Section {
                    Button("Delete note", role: .destructive) {
                        confirmsDeletion = true
                    }
                    .disabled(!store.canMutate)
                    .accessibilityIdentifier("taskInfo.noteEditor.delete")
                }
            }
        }
        .navigationTitle(note == nil ? "Add note" : "Edit note")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task { await save() }
                }
                .disabled(!canSave)
                .accessibilityIdentifier("taskInfo.noteEditor.save")
            }
        }
        .confirmationDialog(
            "Delete note?",
            isPresented: $confirmsDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete note", role: .destructive) {
                Task { await delete() }
            }
            .accessibilityIdentifier("taskInfo.noteEditor.confirmDelete")
            Button("Keep note", role: .cancel) {}
                .accessibilityIdentifier("taskInfo.noteEditor.keep")
        } message: {
            Text("This note will be removed from the task.")
        }
        .accessibilityIdentifier("taskInfo.noteEditor")
    }

    private var canSave: Bool {
        guard store.canMutate else { return false }
        if note == nil {
            return !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return content != note?.content
    }

    private func save() async {
        let saved: Bool = if let note {
            await store.updateNote(note.id, content: content)
        } else {
            await store.addNote(content)
        }
        if saved {
            dismiss()
        }
    }

    private func delete() async {
        guard let note else { return }
        if await store.deleteNote(note.id) {
            dismiss()
        }
    }
}
