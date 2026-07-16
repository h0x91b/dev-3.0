import Dev3Kit
import Dev3UI
import SwiftUI

@MainActor
struct TaskDiffScreen: View {
    let store: TaskDiffStore
    @State private var showsFilePicker = false
    @State private var showsCompareRefEditor = false
    @State private var selectedFileID: String?
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !store.isConnected {
                offlineBanner
            }
            controls
            Divider().overlay(palette.borderDefault)
            content
        }
        .background(palette.surfaceBase)
        .navigationTitle("Diff")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Files") { showsFilePicker = true }
                    Button("Compare reference") { showsCompareRefEditor = true }
                        .disabled(
                            !store.isConnected
                                || store.selection.mode == .uncommitted
                                || store.selection.mode == .recent
                        )
                    Divider()
                    Button("Mark all read") { Task { await store.setAllRead(true) } }
                    Button("Mark all unread") { Task { await store.setAllRead(false) } }
                    Divider()
                    Button("Refresh") { Task { await store.load() } }
                        .disabled(!store.isConnected || store.isLoading)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Diff actions")
                .accessibilityIdentifier("diff.actions")
            }
        }
        .sheet(isPresented: $showsFilePicker) {
            NavigationStack {
                fileList
                    .navigationTitle("Changed files")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showsFilePicker = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showsCompareRefEditor) {
            TaskDiffCompareRefSheet(store: store)
                .presentationDetents([.height(220)])
                .presentationDragIndicator(.visible)
        }
        .task { await store.load() }
        .accessibilityIdentifier("diff.screen")
    }
}

private extension TaskDiffScreen {
    private var offlineBanner: some View {
        Label("Offline — showing cached diff", systemImage: "wifi.slash")
            .font(.footnote.weight(.medium))
            .foregroundStyle(palette.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(palette.warning.opacity(0.10))
            .accessibilityIdentifier("diff.offline")
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    modeButton(.uncommitted)
                    modeButton(.branch)
                    modeButton(.unpushed)
                    Menu {
                        ForEach(TaskDiffModeSelection.recentPresets, id: \.self) { count in
                            Button(TaskDiffModeSelection.recent(count).displayName) {
                                Task { await store.select(.recent(count)) }
                            }
                        }
                    } label: {
                        modeLabel(
                            store.selection.mode == .recent ? store.selection : .recent(1),
                            isSelected: store.selection.mode == .recent,
                            showsMenu: true
                        )
                    }
                    .accessibilityLabel("Recent commits diff")
                    .disabled(!store.isConnected)
                }
                .padding(.horizontal, 16)
            }

            HStack(spacing: 10) {
                if let payload = store.payload {
                    Label("\(payload.summary.files) files", systemImage: "doc.on.doc")
                    Text("+\(payload.summary.insertions)").foregroundStyle(palette.success)
                    Text("−\(payload.summary.deletions)").foregroundStyle(palette.danger)
                    Spacer(minLength: 8)
                    Text(compareDescription(payload))
                        .foregroundStyle(palette.textTertiary)
                        .lineLimit(1)
                } else {
                    Text("Choose what to compare")
                        .foregroundStyle(palette.textTertiary)
                }
                if store.isLoading {
                    ProgressView().controlSize(.small)
                }
            }
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
        .background(palette.surfaceRaised)
    }

    private func modeButton(_ selection: TaskDiffModeSelection) -> some View {
        Button {
            Task { await store.select(selection) }
        } label: {
            modeLabel(selection, isSelected: store.selection == selection, showsMenu: false)
        }
        .buttonStyle(.plain)
        .disabled(!store.isConnected)
        .accessibilityValue(store.selection == selection ? "Selected" : "")
    }

    private func modeLabel(
        _ selection: TaskDiffModeSelection,
        isSelected: Bool,
        showsMenu: Bool
    ) -> some View {
        HStack(spacing: 5) {
            Text(selection.displayName)
            if showsMenu {
                Image(systemName: "chevron.down").font(.caption2)
            }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(isSelected ? palette.surfaceBase : palette.textSecondary)
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(isSelected ? palette.accent : palette.surfaceElevated)
        .clipShape(Capsule())
        .overlay {
            Capsule().stroke(isSelected ? palette.accent : palette.borderDefault)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .offline:
            stateView(
                icon: "wifi.slash",
                title: "Diff unavailable offline",
                message: "Reconnect to load changes for this task."
            )
        case .loading:
            VStack(spacing: 14) {
                ProgressView()
                Text("Loading diff…").foregroundStyle(palette.textSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            stateView(
                icon: "checkmark.circle",
                title: "No changes",
                message: emptyDescription
            )
        case let .failed(message):
            stateView(icon: "exclamationmark.triangle", title: "Could not load diff", message: message) {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.isConnected)
            }
        case .content:
            GeometryReader { proxy in
                if proxy.size.width >= 760 {
                    HStack(spacing: 0) {
                        fileList
                            .frame(width: min(320, proxy.size.width * 0.30))
                        Divider().overlay(palette.borderDefault)
                        diffStream
                    }
                } else {
                    diffStream
                }
            }
        }
    }

    private var emptyDescription: String {
        if store.selection.mode == .recent, store.payload?.recentCount == 0 {
            return "This branch has no commits of its own."
        }
        return "There are no files in this comparison."
    }

    private func compareDescription(_ payload: Dev3TaskDiff) -> String {
        if payload.mode == .uncommitted {
            return "Working tree vs HEAD"
        }
        if payload.mode == .recent {
            let count = payload.recentCount ?? store.selection.count ?? 1
            return count == 1 ? "Last commit" : "Last \(count) commits"
        }
        let fallback = payload.fallbackReason == "no-upstream" ? " (no upstream)" : ""
        return "vs \(payload.compareLabel)\(fallback)"
    }

    private var fileList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(store.fileSummaries) { summary in
                    Button {
                        selectedFileID = summary.id
                        showsFilePicker = false
                    } label: {
                        TaskDiffFileSummaryRow(
                            summary: summary,
                            isRead: isSummaryRead(summary),
                            palette: palette
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Jumps to this file")
                }
            }
            .padding(8)
        }
        .background(palette.surfaceRaised)
        .accessibilityIdentifier("diff.files")
    }

    private func isSummaryRead(_ summary: TaskDiffFileSummary) -> Bool {
        if let file = store.sortedFiles.first(where: { $0.id == summary.id }) {
            return store.isRead(file)
        }
        if let file = store.sortedSkippedFiles.first(where: { $0.id == summary.id }) {
            return store.isRead(file)
        }
        return false
    }

    private var diffStream: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if let errorMessage = store.errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(palette.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    }
                    ForEach(store.sortedFiles) { file in
                        TaskDiffFileSection(
                            file: file,
                            isRead: store.isRead(file),
                            palette: palette,
                            onToggleRead: { await store.toggleRead(file) }
                        )
                        .id(file.id)
                    }
                    ForEach(store.sortedSkippedFiles) { file in
                        TaskDiffSkippedFileSection(
                            file: file,
                            isRead: store.isRead(file),
                            palette: palette,
                            onToggleRead: { await store.toggleRead(file) }
                        )
                        .id(file.id)
                    }
                }
                .padding(12)
            }
            .refreshable { await store.load() }
            .onChange(of: selectedFileID) { _, fileID in
                guard let fileID else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(fileID, anchor: .top)
                }
            }
        }
        .opacity(store.isConnected ? 1 : 0.72)
        .accessibilityIdentifier("diff.stream")
    }

    private func stateView(
        icon: String,
        title: String,
        message: String,
        @ViewBuilder action: () -> some View = { EmptyView() }
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            Text(message)
        } actions: {
            action()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
