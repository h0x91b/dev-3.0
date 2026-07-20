import Dev3TerminalKit
import Dev3UI
import SwiftUI
import UIKit

// swiftlint:disable file_length

@MainActor
struct TaskTerminalScreen: View {
    @State private var store: TerminalTaskStore
    @State private var rawSubmitRevision: UInt64 = 0
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @FocusState private var composerFocused: Bool

    private let title: String
    private let networkRecoveryRevision: UInt64
    private let instanceResolvedTheme: Dev3ResolvedThemeMode?
    private let onTaskInfo: (() -> Void)?

    init(
        title: String,
        service: any TerminalTaskServicing,
        networkRecoveryRevision: UInt64,
        instanceResolvedTheme: Dev3ResolvedThemeMode?,
        onTaskInfo: (() -> Void)? = nil
    ) {
        self.title = title
        self.networkRecoveryRevision = networkRecoveryRevision
        self.instanceResolvedTheme = instanceResolvedTheme
        self.onTaskInfo = onTaskInfo
        _store = State(initialValue: TerminalTaskStore(service: service))
    }

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.windows.total > 1 {
                windowPager
            }
            if store.panes.total != 0 {
                panePager
            }
            if store.showsSharedTerminalSizeNotice {
                sharedTerminalSizeNotice
            }

            terminalSurface
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if store.inputMode == .compose {
                    composer
                }
                accessoryBar
            }
            .background(palette.surfaceRaised)
        }
        .background(palette.surfaceBase)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if let onTaskInfo {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onTaskInfo) {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityLabel("Task info")
                    .accessibilityIdentifier("terminal.taskInfo")
                }
            }
        }
        .sheet(isPresented: $store.isPaneSheetPresented) {
            TerminalPaneActionSheet(store: store)
                .presentationDetents([.height(320), .medium])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Close the last pane?",
            isPresented: $store.confirmsLastPaneClose,
            titleVisibility: .visible
        ) {
            Button("Close pane and end the session", role: .destructive) {
                store.closeLastPane()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Closing the final pane stops this task's tmux session and agent.")
        }
        .alert(
            "Terminal error",
            isPresented: Binding(
                get: { store.transientError != nil },
                set: {
                    if !$0 {
                        store.transientError = nil
                    }
                }
            )
        ) {
            Button("OK") { store.transientError = nil }
        } message: {
            Text(store.transientError ?? "The terminal action failed.")
        }
        .onAppear {
            store.attach(
                isSceneActive: scenePhase == .active,
                networkRecoveryRevision: networkRecoveryRevision
            )
        }
        .onChange(of: scenePhase) { _, newPhase in
            store.sceneChanged(isActive: newPhase == .active)
        }
        .onChange(of: networkRecoveryRevision) { _, revision in
            store.networkBecameReachable(revision: revision)
        }
        .onDisappear {
            store.detach()
        }
        .accessibilityIdentifier("terminal.screen")
    }
}

private extension TaskTerminalScreen {
    private var terminalSurface: some View {
        ZStack {
            Dev3TerminalView(
                endpoint: store.endpoint,
                interaction: store.service.terminalInteraction,
                resize: { [service = store.service] columns, rows in
                    try await service.resize(columns: columns, rows: rows)
                },
                serverID: store.service.serverID,
                inputMode: store.inputMode,
                rawSubmitRevision: rawSubmitRevision,
                terminalRefreshRevision: store.terminalRefreshRevision,
                instanceResolvedTheme: instanceResolvedTheme,
                onError: store.report
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 12, coordinateSpace: .local)
                    .onEnded { value in
                        store.handlePaneSwipe(
                            horizontal: value.translation.width,
                            vertical: value.translation.height
                        )
                    }
            )

            phaseOverlay
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .accessibilityIdentifier("terminal.surface")
    }

    @ViewBuilder
    private var phaseOverlay: some View {
        switch store.phase {
        case .idle, .connecting:
            terminalStatusCard(title: "Connecting…", message: "Opening the task terminal") {
                ProgressView().tint(palette.textPrimary)
            }
        case let .reconnecting(attempt, _):
            terminalStatusCard(
                title: "Reconnecting…",
                message: "Retry \(attempt) keeps your task attached"
            ) {
                ProgressView().tint(palette.textPrimary)
            }
        case .needsResume:
            terminalRecoveryCard(
                title: "Task session is paused",
                message: "Resume the existing session or restart it with a fresh terminal."
            )
        case let .failed(message):
            terminalRecoveryCard(title: "Terminal unavailable", message: message)
        case .disconnected:
            terminalRecoveryCard(
                title: "Terminal disconnected",
                message: "Reconnect to the existing task session or restart it with a fresh terminal."
            )
        case .connected:
            EmptyView()
        }
    }

    private func terminalStatusCard(
        title: String,
        message: String,
        @ViewBuilder icon: () -> some View
    ) -> some View {
        VStack(spacing: 10) {
            icon()
            Text(title).font(.headline)
            Text(message)
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .background(palette.surfaceElevated, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(palette.borderDefault)
        }
        .padding(24)
    }

    private func terminalRecoveryCard(title: String, message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "terminal.fill")
                .font(.title2)
                .foregroundStyle(palette.warning)
                .accessibilityHidden(true)
            Text(title).font(.headline)
            Text(message)
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Resume") { store.resume() }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                Button("Restart") { store.restart() }
                    .buttonStyle(.bordered)
                    .tint(palette.danger)
            }
            .disabled(store.isBusy)
        }
        .padding(20)
        .background(palette.surfaceElevated, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(palette.borderDefault)
        }
        .padding(24)
        .accessibilityIdentifier("terminal.recovery")
    }

    private var windowPager: some View {
        HStack(spacing: 4) {
            pagerButton(systemName: "chevron.left", label: "Previous window") {
                store.navigateWindow(step: .previous)
            }
            Menu {
                ForEach(0 ..< store.windows.total, id: \.self) { index in
                    Button {
                        store.navigateWindow(index: index)
                    } label: {
                        if index == store.windows.boundedActiveIndex {
                            Label(windowLabel(index), systemImage: "checkmark")
                        } else {
                            Text(windowLabel(index))
                        }
                    }
                }
            } label: {
                Label(
                    windowLabel(store.windows.boundedActiveIndex),
                    systemImage: "macwindow.on.rectangle"
                )
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .frame(maxWidth: .infinity)
            }
            .frame(minHeight: 44)
            .accessibilityLabel("Switch tmux window")
            pagerButton(systemName: "chevron.right", label: "Next window") {
                store.navigateWindow(step: .next)
            }
        }
        .padding(.horizontal, 6)
        .background(palette.surfaceRaised)
        .overlay(alignment: .bottom) { Divider().overlay(palette.borderDefault) }
        .accessibilityIdentifier("terminal.windowPager")
    }

    private var panePager: some View {
        HStack(spacing: 4) {
            if store.panes.total > 1 {
                pagerButton(systemName: "chevron.left", label: "Previous pane") {
                    store.navigatePane(step: .previous)
                }
                HStack(spacing: 7) {
                    ForEach(0 ..< store.panes.total, id: \.self) { index in
                        Button {
                            store.navigatePane(index: index)
                        } label: {
                            Circle()
                                .fill(
                                    index == store.panes.boundedActiveIndex
                                        ? palette.accent
                                        : palette.textMuted
                                )
                                .frame(width: 8, height: 8)
                                .frame(minWidth: 28, minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Pane \(index + 1) of \(store.panes.total)")
                        .accessibilityValue(index == store.panes.boundedActiveIndex ? "Selected" : "")
                    }
                }
                .frame(maxWidth: .infinity)
                pagerButton(systemName: "chevron.right", label: "Next pane") {
                    store.navigatePane(step: .next)
                }
            } else {
                Text(paneLabel(0))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 10)
            }

            pagerButton(systemName: "rectangle.3.group", label: "Manage panes and windows") {
                store.isPaneSheetPresented = true
            }
        }
        .padding(.horizontal, 6)
        .background(palette.surfaceRaised)
        .overlay(alignment: .bottom) { Divider().overlay(palette.borderDefault) }
        .accessibilityIdentifier("terminal.panePager")
    }

    private func pagerButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(palette.textSecondary)
        .accessibilityLabel(label)
    }

    private var sharedTerminalSizeNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.compress.vertical")
                .foregroundStyle(palette.warning)
                .accessibilityHidden(true)
            Text(TerminalSharedSizeNotice.message)
                .font(.caption)
                .foregroundStyle(palette.textSecondary)
            Spacer(minLength: 0)
            Text(TerminalSharedSizeNotice.leaveHint)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.textMuted)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(palette.warning.opacity(0.09))
        .accessibilityIdentifier("terminal.sharedSizeNotice")
    }

    private var composer: some View {
        VStack(spacing: 8) {
            TextEditor(text: $store.draft)
                .focused($composerFocused)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 44, maxHeight: composerMaxHeight)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    palette.surfaceRaised,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(composerFocused ? palette.borderActive : palette.borderDefault)
                }
                .accessibilityLabel("Terminal message")
                .accessibilityIdentifier("terminal.composer")

            // Single compact action row reclaims the vertical space the old
            // full-width "Insert / Compose mode" row wasted. The mode is already
            // shown by the accessory bar's Raw/Compose toggle, so the redundant
            // "Compose mode" label is dropped.
            HStack(spacing: 8) {
                Button {
                    store.isComposerExpanded.toggle()
                } label: {
                    Image(systemName: composerExpansionIcon)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.textSecondary)
                .accessibilityLabel(store.isComposerExpanded ? "Collapse editor" : "Expand editor")

                Spacer(minLength: 0)

                Button("Insert") { store.insertDraft() }
                    .buttonStyle(.bordered)
                    .tint(palette.textSecondary)
                    .frame(minHeight: 44)
                    .disabled(store.draft.isEmpty || store.isBusy)
                    .accessibilityIdentifier("terminal.insert")

                Button("Send") { store.submitDraft() }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .frame(minHeight: 44)
                    .disabled(store.draft.isEmpty || store.isBusy)
                    .accessibilityIdentifier("terminal.send")
            }
        }
        .padding(10)
        .background(palette.surfaceElevated)
        .overlay(alignment: .top) { Divider().overlay(palette.borderDefault) }
    }

    private var accessoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Dev3TerminalAccessoryKey.allCases) { key in
                    Button(key.rawValue) {
                        if store.sendAccessory(key) {
                            rawSubmitRevision &+= 1
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(
                        key == .control && store.isControlLatched
                            ? palette.accent
                            : palette.textSecondary
                    )
                    .frame(minHeight: 44)
                    .accessibilityValue(key == .control && store.isControlLatched ? "On" : "")
                }

                Button {
                    if let text = UIPasteboard.general.string, !text.isEmpty {
                        store.pasteClipboard(text)
                    }
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.bordered)
                .tint(palette.textSecondary)
                .frame(minHeight: 44)

                Button {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder),
                        to: nil,
                        from: nil,
                        for: nil
                    )
                } label: {
                    Label("Hide keyboard", systemImage: "keyboard.chevron.compact.down")
                }
                .buttonStyle(.bordered)
                .tint(palette.textSecondary)
                .frame(minHeight: 44)
                .accessibilityIdentifier("terminal.hideKeyboard")

                Button {
                    withAnimation(reduceMotion ? nil : .snappy) {
                        store.inputMode = store.inputMode == .compose ? .raw : .compose
                    }
                } label: {
                    Label(
                        store.inputMode == .raw ? "Raw" : "Compose",
                        systemImage: "keyboard"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(store.inputMode == .raw ? palette.warning : palette.accent)
                .frame(minHeight: 44)
                .accessibilityHint("Switches between direct terminal typing and the message editor")
                .accessibilityIdentifier("terminal.rawToggle")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(palette.surfaceRaised)
        .overlay(alignment: .top) { Divider().overlay(palette.borderDefault) }
        .accessibilityIdentifier("terminal.accessoryBar")
    }

    private func windowLabel(_ index: Int) -> String {
        "\(index + 1). \(store.windows.label(at: index, fallback: "Window \(index + 1)"))"
    }

    private func paneLabel(_ index: Int) -> String {
        store.panes.label(at: index, fallback: "Pane \(index + 1)")
    }

    private var composerExpansionIcon: String {
        store.isComposerExpanded
            ? "arrow.down.right.and.arrow.up.left"
            : "arrow.up.left.and.arrow.down.right"
    }

    /// In a compact height (landscape on iPhone) the composer must stay short so
    /// the terminal keeps usable real estate; only the roomy portrait layout gets
    /// the taller editor.
    private var composerMaxHeight: CGFloat {
        if verticalSizeClass == .compact {
            return store.isComposerExpanded ? 110 : 44
        }
        return store.isComposerExpanded ? 180 : 88
    }
}
