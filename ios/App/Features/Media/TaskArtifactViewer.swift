import Dev3UI
import SwiftUI

@MainActor
struct TaskArtifactViewer: View {
    @Bindable var store: TaskMediaStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !store.isArtifactFullscreen {
                header
            }
            artifactContent
        }
        .background(palette.surfaceBase)
        .ignoresSafeArea(edges: store.isArtifactFullscreen ? .all : [])
        .overlay(alignment: .topTrailing) {
            if store.isArtifactFullscreen {
                fullscreenActions
                    .padding(12)
            }
        }
        .onDisappear { store.isArtifactFullscreen = false }
        .sheet(item: $store.sharePayload) { payload in
            MediaShareSheet(payload: payload)
        }
        .alert(
            "Artifact unavailable",
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
            Text(store.transientError ?? "The artifact could not be loaded.")
        }
        .accessibilityIdentifier("media.artifactViewer")
    }

    private var header: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.currentArtifact?.title ?? "HTML artifact")
                    .font(.headline)
                    .lineLimit(1)
                Text(artifactSubtitle)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if store.artifacts.count > 1 {
                headerButton(
                    "chevron.left",
                    label: "Previous artifact",
                    disabled: isArtifactNavigationDisabled(-1)
                ) { store.moveArtifact(by: -1) }
                headerButton(
                    "chevron.right",
                    label: "Next artifact",
                    disabled: isArtifactNavigationDisabled(1)
                ) { store.moveArtifact(by: 1) }
            }
            headerButton("square.and.arrow.up", label: "Share artifact") {
                store.prepareArtifactShare()
            }
            headerButton("arrow.up.left.and.arrow.down.right", label: "Enter fullscreen") {
                setFullscreen(true)
            }
            headerButton("xmark", label: "Close artifact viewer") {
                store.closePresentation()
            }
        }
        .padding(.horizontal, 10)
        .background(palette.surfaceRaised)
        .overlay(alignment: .bottom) { Divider().overlay(palette.borderDefault) }
    }

    @ViewBuilder
    private var artifactContent: some View {
        if store.currentArtifact == nil {
            ContentUnavailableView(
                "No shared artifacts",
                systemImage: "doc.richtext",
                description: Text("HTML artifacts shared from this task will appear here.")
            )
        } else {
            switch store.artifactState {
            case .idle, .loading:
                ProgressView("Loading artifact…")
                    .tint(palette.textPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .loaded(bundle):
                ArtifactWebView(bundle: bundle) { message in
                    store.transientError = message
                }
                .id(bundle.artifactID)
                .accessibilityIdentifier("media.artifactWebView")
            case let .failed(message):
                ContentUnavailableView(
                    "Artifact unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
        }
    }

    private var fullscreenActions: some View {
        HStack(spacing: 2) {
            Button {
                store.prepareArtifactShare()
            } label: {
                Image(systemName: "square.and.arrow.up")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Share artifact")
            Button {
                setFullscreen(false)
            } label: {
                Image(systemName: "arrow.down.right.and.arrow.up.left")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Exit fullscreen")
            Button {
                store.closePresentation()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Close artifact viewer")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .background(palette.surfaceElevated, in: Capsule())
        .overlay { Capsule().stroke(palette.borderDefault) }
        .accessibilityIdentifier("media.artifactFullscreenActions")
    }

    private func headerButton(
        _ systemName: String,
        label: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
        .accessibilityLabel(label)
    }

    private func setFullscreen(_ fullscreen: Bool) {
        if reduceMotion {
            store.isArtifactFullscreen = fullscreen
        } else {
            withAnimation(.snappy) { store.isArtifactFullscreen = fullscreen }
        }
    }

    private var artifactSubtitle: String {
        guard let index = store.selectedArtifactIndex else { return "0 / 0" }
        let name = store.currentArtifact?.name ?? "Artifact"
        return "\(name) · \(index + 1) / \(store.artifacts.count)"
    }

    private func isArtifactNavigationDisabled(_ delta: Int) -> Bool {
        guard let index = store.selectedArtifactIndex else { return true }
        return !store.artifacts.indices.contains(index + delta)
    }
}
