import Dev3Kit
import Dev3UI
import SwiftUI

@MainActor
struct TaskInfoSheet: View {
    @Bindable var store: TaskInfoStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                overviewSection
                organizationSection
                sourceControlSection
                notesSection
                actionsSection
            }
            .navigationTitle("Task info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .overlay {
                if store.isMutating {
                    ProgressView()
                        .controlSize(.large)
                        .padding(20)
                        .background(palette.surfaceOverlay, in: RoundedRectangle(cornerRadius: 16))
                        .accessibilityLabel("Updating task")
                        .accessibilityIdentifier("taskInfo.updating")
                }
            }
            .alert("Task action failed", isPresented: errorBinding) {
                Button("OK") { store.clearError() }
            } message: {
                Text(store.errorMessage ?? "The task action failed.")
            }
            .confirmationDialog(
                store.pendingConfirmation?.title ?? "Confirm task action",
                isPresented: confirmationBinding,
                titleVisibility: .visible
            ) {
                confirmationActions
            } message: {
                Text(store.pendingConfirmation?.message ?? "")
            }
            .task {
                async let branch: Void = store.refreshBranchStatus()
                async let pullRequest: Void = store.refreshPRStatus()
                _ = await (branch, pullRequest)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(palette.surfaceBase)
        .accessibilityIdentifier("taskInfo.sheet")
    }
}

private extension TaskInfoSheet {
    @ViewBuilder
    var connectionSection: some View {
        if !store.isConnected {
            Section {
                Label("Viewing cached task details", systemImage: "wifi.slash")
                    .foregroundStyle(palette.warning)
                    .accessibilityIdentifier("taskInfo.disconnected")
            } footer: {
                Text("Reconnect to rename, move, label, watch, edit notes, or delete this task.")
            }
        }
    }

    var overviewSection: some View {
        Section("Overview") {
            TextField("Task title", text: $store.titleDraft, axis: .vertical)
                .textInputAutocapitalization(.sentences)
                .disabled(!store.isConnected)
                .accessibilityIdentifier("taskInfo.title")

            if store.task.customTitle != nil {
                Button("Reset to automatic title") {
                    Task { await store.resetTitle() }
                }
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.resetTitle")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Your overview")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                TextEditor(text: $store.userOverviewDraft)
                    .frame(minHeight: 72)
                    .scrollContentBackground(.hidden)
                    .disabled(!store.isConnected)
                    .accessibilityIdentifier("taskInfo.userOverview")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Agent overview")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
                Text(nonempty(store.task.overview) ?? "No agent overview yet.")
                    .foregroundStyle(
                        nonempty(store.task.overview) == nil ? palette.textTertiary : palette.textPrimary
                    )
                    .textSelection(.enabled)
                    .accessibilityIdentifier("taskInfo.agentOverview")
            }
        }
    }

    var organizationSection: some View {
        Section("Organization") {
            LabeledContent("Status") {
                Menu(currentDestinationName) {
                    ForEach(store.destinations) { destination in
                        Button(destination.displayName) {
                            Task { await store.requestMove(to: destination) }
                        }
                        .accessibilityIdentifier("taskInfo.move.\(destination.id)")
                    }
                }
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.status")
            }

            LabeledContent("Priority") {
                Menu(store.task.effectivePriority.rawValue) {
                    ForEach(Dev3TaskPriority.allCases, id: \.rawValue) { priority in
                        Button(priority.rawValue) {
                            Task { await store.setPriority(priority) }
                        }
                        .accessibilityIdentifier("taskInfo.priority.\(priority.rawValue)")
                    }
                }
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.priority")
            }

            Toggle("Watch task", isOn: watchedBinding)
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.watch")

            NavigationLink {
                TaskLabelsEditor(store: store)
            } label: {
                LabeledContent("Labels", value: selectedLabelSummary)
            }
            .disabled(!store.canMutate)
            .accessibilityIdentifier("taskInfo.labels")
        }
    }

    var sourceControlSection: some View {
        Section("Branch & pull request") {
            if let branchName = nonempty(store.task.branchName) {
                LabeledContent("Branch", value: branchName)
                    .accessibilityIdentifier("taskInfo.branch")
            } else {
                LabeledContent("Branch", value: "No active worktree")
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityIdentifier("taskInfo.branch.empty")
            }

            branchStatusRow
            pullRequestRow

            HStack {
                Button("Refresh branch") {
                    Task { await store.refreshBranchStatus() }
                }
                .disabled(!store.isConnected || store.isRefreshingBranch)
                .accessibilityIdentifier("taskInfo.refreshBranch")

                Spacer()

                Button("Refresh PR") {
                    Task { await store.refreshPRStatus() }
                }
                .disabled(!store.isConnected || store.isRefreshingPR)
                .accessibilityIdentifier("taskInfo.refreshPR")
            }
        }
    }

    var notesSection: some View {
        Section("Notes") {
            ForEach(store.task.notes ?? []) { note in
                NavigationLink {
                    TaskNoteEditor(store: store, note: note)
                } label: {
                    TaskNoteSummary(note: note)
                }
                .accessibilityIdentifier("taskInfo.note.\(note.id)")
            }

            NavigationLink {
                TaskNoteEditor(store: store, note: nil)
            } label: {
                Label("Add note", systemImage: "plus")
            }
            .disabled(!store.canMutate)
            .accessibilityIdentifier("taskInfo.addNote")
        }
    }

    var actionsSection: some View {
        Section("Actions") {
            if store.task.status != .completed {
                Button {
                    Task { await store.requestMove(to: .status(.completed)) }
                } label: {
                    Label("Complete task", systemImage: "checkmark.circle")
                }
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.complete")
            }

            if store.task.status != .cancelled {
                Button(role: .destructive) {
                    Task { await store.requestCancellation() }
                } label: {
                    Label("Cancel task", systemImage: "xmark.circle")
                }
                .disabled(!store.canMutate)
                .accessibilityIdentifier("taskInfo.cancel")
            }

            Button(role: .destructive) {
                store.requestDeletion()
            } label: {
                Label("Delete task", systemImage: "trash")
            }
            .disabled(!store.canMutate)
            .accessibilityIdentifier("taskInfo.delete")
        }
    }
}

private extension TaskInfoSheet {
    @ToolbarContentBuilder
    var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }
                .accessibilityIdentifier("taskInfo.close")
        }
        ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
                Task { await store.saveDrafts() }
            }
            .disabled(!store.canMutate || !store.hasDraftChanges)
            .accessibilityIdentifier("taskInfo.save")
        }
    }

    @ViewBuilder
    var branchStatusRow: some View {
        if store.isRefreshingBranch, store.branchStatus == nil {
            LabeledContent("Changes") {
                ProgressView()
                    .controlSize(.small)
            }
            .accessibilityIdentifier("taskInfo.branch.loading")
        } else if let status = store.branchStatus {
            LabeledContent(
                "Changes",
                value: "+\(status.insertions) / -\(status.deletions) · \(status.ahead) ahead"
            )
            .accessibilityIdentifier("taskInfo.branch.status")
        }
    }

    @ViewBuilder
    var pullRequestRow: some View {
        if let url = pullRequestURL, let number = pullRequestNumber {
            Link(destination: url) {
                LabeledContent("Pull request", value: "#\(number) · \(pullRequestState)")
            }
            .accessibilityIdentifier("taskInfo.pr.link")
        } else if let number = pullRequestNumber {
            LabeledContent("Pull request", value: "#\(number) · \(pullRequestState)")
                .accessibilityIdentifier("taskInfo.pr")
        } else {
            LabeledContent("Pull request", value: "None")
                .foregroundStyle(palette.textSecondary)
                .accessibilityIdentifier("taskInfo.pr.empty")
        }
    }

    @ViewBuilder
    var confirmationActions: some View {
        if let confirmation = store.pendingConfirmation {
            Button(confirmation.confirmTitle, role: confirmation.isDestructive ? .destructive : nil) {
                guard let pending = store.takePendingConfirmation() else { return }
                Task { await store.perform(pending, confirmed: true) }
            }
            .accessibilityIdentifier("taskInfo.confirm")
            Button(confirmation.cancelTitle, role: .cancel) {
                _ = store.takePendingConfirmation()
            }
            .accessibilityIdentifier("taskInfo.confirm.cancel")
        }
    }

    var watchedBinding: Binding<Bool> {
        Binding(
            get: { store.task.watched == true },
            set: { watched in
                Task { await store.setWatched(watched) }
            }
        )
    }

    var errorBinding: Binding<Bool> {
        Binding(
            get: { store.errorMessage != nil },
            set: {
                if !$0 {
                    store.clearError()
                }
            }
        )
    }

    var confirmationBinding: Binding<Bool> {
        Binding(
            get: { store.pendingConfirmation != nil },
            set: {
                if !$0 {
                    _ = store.takePendingConfirmation()
                }
            }
        )
    }

    var currentDestinationName: String {
        // SwiftFormat's multiline-brace rule intentionally differs from SwiftLint here.
        // swiftlint:disable opening_brace
        if let customColumnID = store.task.customColumnId,
           let column = store.project.customColumns?.first(where: { $0.id == customColumnID })
        {
            return column.name
        }
        // swiftlint:enable opening_brace
        return store.task.status.taskInfoDisplayName
    }

    var selectedLabelSummary: String {
        let selected = Set(store.task.labelIds ?? [])
        let names = (store.project.labels ?? []).filter { selected.contains($0.id) }.map(\.name)
        return names.isEmpty ? "None" : names.joined(separator: ", ")
    }

    var pullRequestNumber: Int? {
        store.pushedPRStatus?.prNumber ?? store.task.prStatusCache?.number ?? store.task.prNumber
    }

    var pullRequestURL: URL? {
        let raw = store.pushedPRStatus?.prUrl ?? store.task.prStatusCache?.url ?? store.task.prUrl
        return raw.flatMap(URL.init(string:))
    }

    var pullRequestState: String {
        store.pushedPRStatus?.ciStatus ?? store.task.prStatusCache?.ciStatus ?? "Status unknown"
    }

    func nonempty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
