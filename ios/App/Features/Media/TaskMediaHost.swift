import SwiftUI

@MainActor
struct TaskMediaHost: View {
    @Bindable var store: TaskMediaStore

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .fullScreenCover(isPresented: imagePresentation) {
                TaskImageLightbox(store: store)
            }
            .fullScreenCover(isPresented: artifactPresentation) {
                TaskArtifactViewer(store: store)
            }
            .accessibilityHidden(true)
    }

    private var imagePresentation: Binding<Bool> {
        Binding(
            get: {
                if case .image = store.presentation {
                    return true
                }
                return false
            },
            set: {
                if !$0 {
                    store.closePresentation()
                }
            }
        )
    }

    private var artifactPresentation: Binding<Bool> {
        Binding(
            get: {
                if case .artifact = store.presentation {
                    return true
                }
                return false
            },
            set: {
                if !$0 {
                    store.closePresentation()
                }
            }
        )
    }
}
