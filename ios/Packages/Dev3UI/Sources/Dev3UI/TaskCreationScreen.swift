import Dev3Kit
import SwiftUI

public struct TaskCreationScreen: View {
    @Bindable private var store: TaskCreationStore
    private let onCancel: @MainActor () -> Void
    private let onSubmitted: @MainActor (_ mode: TaskCreationMode) -> Void

    public init(
        store: TaskCreationStore,
        onCancel: @escaping @MainActor () -> Void = {},
        onSubmitted: @escaping @MainActor (_ mode: TaskCreationMode) -> Void = { _ in }
    ) {
        self.store = store
        self.onCancel = onCancel
        self.onSubmitted = onSubmitted
    }

    public var body: some View {
        NavigationStack {
            Form {
                if store.isLaunchingExistingTask {
                    existingTaskSection
                } else {
                    taskSection
                    labelsSection
                }
                launchSection
                feedbackSection
            }
            .navigationTitle(store.isLaunchingExistingTask ? "Start task" : "New task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("taskCreation.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !store.isLaunchingExistingTask {
                        Button("Save") {
                            submit(.save)
                        }
                        .disabled(!store.canSubmit)
                        .accessibilityIdentifier("taskCreation.save")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    submit(.saveAndStart)
                } label: {
                    HStack {
                        if store.isSubmitting {
                            ProgressView()
                        }
                        Text(primaryActionTitle)
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canSubmit || store.isSubmitting)
                .padding()
                .background(.bar)
                .accessibilityIdentifier("taskCreation.saveAndStart")
            }
            .task {
                await store.load()
            }
        }
    }

    @ViewBuilder
    private var existingTaskSection: some View {
        if let task = store.existingTask {
            Section("Task") {
                LabeledContent("Title", value: task.displayTitle)
                if let project = store.selectedProject {
                    LabeledContent("Project", value: project.name)
                }
            }
            .accessibilityIdentifier("taskCreation.existingTask")
        }
    }

    private var taskSection: some View {
        Section("Task") {
            Picker("Project", selection: $store.selectedProjectID) {
                ForEach(store.projects) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .accessibilityIdentifier("taskCreation.project")

            TextField("Title (optional)", text: $store.title)
                .accessibilityIdentifier("taskCreation.title")

            TextEditor(text: $store.descriptionText)
                .frame(minHeight: 120)
                .accessibilityLabel("Description")
                .accessibilityIdentifier("taskCreation.description")

            Picker("Priority", selection: $store.priority) {
                ForEach(Dev3TaskPriority.allCases, id: \.self) { priority in
                    Text(priority.rawValue).tag(priority)
                }
            }
            .accessibilityIdentifier("taskCreation.priority")

            Toggle("Watch task", isOn: $store.watched)
                .accessibilityIdentifier("taskCreation.watched")
        }
    }

    @ViewBuilder
    private var labelsSection: some View {
        if !store.availableLabels.isEmpty {
            Section("Labels") {
                ForEach(store.availableLabels) { label in
                    Toggle(label.name, isOn: labelSelection(label.id))
                        .accessibilityIdentifier("taskCreation.label.\(label.id)")
                }
            }
        }
    }

    @ViewBuilder
    private var launchSection: some View {
        if store.isLoading {
            Section("Launch") {
                ProgressView("Loading agents…")
                    .accessibilityIdentifier("taskCreation.loadingAgents")
            }
        } else {
            if !store.favoriteOptions.isEmpty, let firstVariant = store.variants.first {
                Section("Favorites") {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(store.favoriteOptions) { favorite in
                                Button(favorite.label) {
                                    store.applyFavorite(favorite, to: firstVariant.id)
                                }
                                .buttonStyle(.bordered)
                                .disabled(!favorite.isEnabled)
                                .accessibilityIdentifier("taskCreation.favorite.\(favorite.id)")
                            }
                        }
                    }
                }
            }

            ForEach(Array(store.variants.enumerated()), id: \.element.id) { index, variant in
                AgentConfigurationPicker(store: store, variantID: variant.id, index: index)
            }

            if store.canAddVariant {
                Section {
                    Button {
                        store.addVariant()
                    } label: {
                        Label("Add variant", systemImage: "plus")
                    }
                    .accessibilityIdentifier("taskCreation.addVariant")
                }
            }
        }
    }

    @ViewBuilder
    private var feedbackSection: some View {
        if let errorMessage = store.errorMessage {
            Section {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("taskCreation.error")
            }
        }
        if !store.warningMessages.isEmpty {
            Section("Created with warnings") {
                ForEach(store.warningMessages, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.circle")
                        .accessibilityIdentifier("taskCreation.warning")
                }
            }
        }
    }

    private func labelSelection(_ labelID: String) -> Binding<Bool> {
        Binding(
            get: { store.selectedLabelIDs.contains(labelID) },
            set: { selected in
                if selected {
                    store.selectedLabelIDs.insert(labelID)
                } else {
                    store.selectedLabelIDs.remove(labelID)
                }
            }
        )
    }

    private func submit(_ mode: TaskCreationMode) {
        Task {
            let result = await store.submit(mode)
            let succeeded = switch mode {
            case .save:
                store.lastCreatedTaskID != nil
            case .saveAndStart:
                result != nil
            }
            if succeeded {
                onSubmitted(mode)
            }
        }
    }

    private var primaryActionTitle: String {
        if store.pendingTerminalTaskID != nil {
            return "Preparing terminal…"
        }
        return store.isLaunchingExistingTask ? "Start" : "Save & Start"
    }
}
