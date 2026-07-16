import Dev3Kit
import SwiftUI

public struct AgentConfigurationPicker: View {
    @Bindable private var store: TaskCreationStore
    private let variantID: UUID
    private let index: Int

    public init(store: TaskCreationStore, variantID: UUID, index: Int) {
        self.store = store
        self.variantID = variantID
        self.index = index
    }

    public var body: some View {
        Section("Variant \(index + 1)") {
            Picker("Agent", selection: agentSelection) {
                Text("Choose an agent").tag("")
                ForEach(store.agents) { agent in
                    Text(agent.name).tag(agent.id)
                }
            }
            .accessibilityIdentifier("taskCreation.variant.\(index).agent")

            Menu {
                if configurations.isEmpty {
                    Text("No configurations available")
                }
                ForEach(configurations) { configuration in
                    Button {
                        store.selectConfiguration(configuration.id, for: variantID)
                    } label: {
                        if configuration.id == variant?.configurationID {
                            Label(configuration.name, systemImage: "checkmark")
                        } else {
                            Text(configuration.name)
                        }
                    }
                    .disabled(!configurationEnabled(configuration))
                }
            } label: {
                LabeledContent("Configuration") {
                    Text(configurationLabel)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("taskCreation.variant.\(index).configuration")

            if selectedConfigurationNeedsProxy {
                Label(
                    "Requires the pxpipe proxy on the connected Mac.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
                .accessibilityIdentifier("taskCreation.variant.\(index).pxpipeRequired")
            }

            if store.variants.count > 1 {
                Button("Remove variant", role: .destructive) {
                    store.removeVariant(id: variantID)
                }
                .accessibilityIdentifier("taskCreation.variant.\(index).remove")
            }
        }
    }

    private var variant: TaskCreationVariant? {
        store.variants.first { $0.id == variantID }
    }

    private var selectedAgent: Dev3CodingAgent? {
        guard let agentID = variant?.agentID else { return nil }
        return store.agents.first { $0.id == agentID }
    }

    private var configurations: [Dev3AgentConfiguration] {
        selectedAgent?.configurations ?? []
    }

    private var selectedConfiguration: Dev3AgentConfiguration? {
        guard let configurationID = variant?.configurationID else { return nil }
        return configurations.first { $0.id == configurationID }
    }

    private var configurationLabel: String {
        selectedConfiguration?.name ?? "Choose a configuration"
    }

    private var selectedConfigurationNeedsProxy: Bool {
        guard let selectedConfiguration else { return false }
        return !configurationEnabled(selectedConfiguration)
    }

    private var agentSelection: Binding<String> {
        Binding(
            get: { variant?.agentID ?? "" },
            set: { agentID in
                guard !agentID.isEmpty else { return }
                store.selectAgent(agentID, for: variantID)
            }
        )
    }

    private func configurationEnabled(_ configuration: Dev3AgentConfiguration) -> Bool {
        guard let settings = store.settings else { return false }
        return TaskCreationAgentResolver.isConfigurationEnabled(configuration, settings: settings)
    }
}
