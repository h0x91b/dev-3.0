import Dev3Kit
import Dev3UI
import SwiftUI
import UIKit

@MainActor
struct TaskImageLightbox: View {
    @Bindable var store: TaskMediaStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            stage
            if let caption = store.currentImage?.caption, !caption.isEmpty {
                captionView(caption)
            }
            if store.images.count > 1 {
                historyRail
            }
        }
        .background(palette.surfaceBase)
        .task { store.prefetchImageHistory() }
        .sheet(item: $store.sharePayload) { payload in
            MediaShareSheet(payload: payload)
        }
        .alert(
            "Image unavailable",
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
            Text(store.transientError ?? "The image could not be loaded.")
        }
        .accessibilityIdentifier("media.imageLightbox")
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.currentImage?.name ?? "Shared image")
                    .font(.headline)
                    .lineLimit(1)
                Text(imageCounter)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: 8)
            Button {
                store.prepareImageShare()
            } label: {
                Image(systemName: "square.and.arrow.up")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Share image")
            Button {
                store.closePresentation()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Close image viewer")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .background(palette.surfaceRaised)
        .overlay(alignment: .bottom) { Divider().overlay(palette.borderDefault) }
    }

    private var stage: some View {
        ZStack {
            palette.surfaceBase
            if let image = store.currentImage {
                if let data = store.imageData(for: image) {
                    ZoomableImageView(
                        imageID: image.id,
                        data: data,
                        accessibilityLabel: image.caption ?? image.name,
                        reduceMotion: reduceMotion
                    )
                    .padding(8)
                } else if let message = store.imageError(for: image) {
                    mediaError(message)
                } else {
                    ProgressView("Loading image…")
                        .tint(palette.textPrimary)
                }
            } else {
                ContentUnavailableView(
                    "No shared images",
                    systemImage: "photo",
                    description: Text("Images shared from this task will appear here.")
                )
            }

            if store.images.count > 1 {
                HStack {
                    navigationButton(direction: -1, systemName: "chevron.left")
                    Spacer()
                    navigationButton(direction: 1, systemName: "chevron.right")
                }
                .padding(.horizontal, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func navigationButton(direction: Int, systemName: String) -> some View {
        Button {
            store.moveImage(by: direction)
        } label: {
            Image(systemName: systemName)
                .font(.headline)
                .frame(width: 48, height: 48)
                .background(palette.surfaceElevated, in: Circle())
                .overlay { Circle().stroke(palette.borderDefault) }
        }
        .buttonStyle(.plain)
        .disabled(isNavigationDisabled(direction))
        .opacity(isNavigationDisabled(direction) ? 0 : 1)
        .accessibilityLabel(direction < 0 ? "Previous image" : "Next image")
    }

    private func captionView(_ caption: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "text.bubble")
                .foregroundStyle(palette.textMuted)
                .accessibilityHidden(true)
            Text(caption)
                .font(.subheadline)
                .foregroundStyle(palette.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .frame(maxHeight: 120)
        .background(palette.surfaceRaised)
        .overlay(alignment: .top) { Divider().overlay(palette.borderDefault) }
        .accessibilityIdentifier("media.imageCaption")
    }

    private var historyRail: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(store.images.enumerated()), id: \.element.id) { index, image in
                        Button {
                            store.selectImage(index)
                        } label: {
                            thumbnail(for: image)
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(
                                            index == store.selectedImageIndex
                                                ? palette.accent
                                                : palette.borderDefault,
                                            lineWidth: index == store.selectedImageIndex ? 3 : 1
                                        )
                                }
                        }
                        .buttonStyle(.plain)
                        .id(image.id)
                        .accessibilityLabel(image.caption ?? image.name)
                        .accessibilityValue(index == store.selectedImageIndex ? "Selected" : "")
                    }
                }
                .padding(10)
            }
            .onChange(of: store.selectedImageIndex) { _, _ in
                guard let id = store.currentImage?.id else { return }
                if reduceMotion {
                    proxy.scrollTo(id, anchor: .center)
                } else {
                    withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
        .background(palette.surfaceRaised)
        .overlay(alignment: .top) { Divider().overlay(palette.borderDefault) }
        .accessibilityIdentifier("media.imageHistory")
    }

    @ViewBuilder
    private func thumbnail(for image: Dev3SharedImage) -> some View {
        if let data = store.imageData(for: image), let uiImage = UIImage(data: data) {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFill()
                .accessibilityHidden(true)
        } else {
            ZStack {
                palette.surfaceElevated
                if store.imageError(for: image) != nil {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                } else {
                    ProgressView()
                }
            }
            .foregroundStyle(palette.textMuted)
        }
    }

    private func mediaError(_ message: String) -> some View {
        ContentUnavailableView(
            "Image unavailable",
            systemImage: "exclamationmark.triangle",
            description: Text(message)
        )
    }

    private var imageCounter: String {
        guard let index = store.selectedImageIndex else { return "0 / 0" }
        return "\(index + 1) / \(store.images.count)"
    }

    private func isNavigationDisabled(_ delta: Int) -> Bool {
        guard let index = store.selectedImageIndex else { return true }
        return !store.images.indices.contains(index + delta)
    }
}
