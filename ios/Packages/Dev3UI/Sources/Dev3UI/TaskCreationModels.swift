import Dev3Kit
import Foundation

public struct TaskCreationProvenance: Equatable, Sendable {
    public let serverID: String
    public let rpcGeneration: UUID

    public init(serverID: String, rpcGeneration: UUID) {
        self.serverID = serverID
        self.rpcGeneration = rpcGeneration
    }
}

public struct TaskCreationVariant: Equatable, Identifiable, Sendable {
    public let id: UUID
    public var agentID: String?
    public var configurationID: String?
    public var accountID: String?

    public init(
        id: UUID = UUID(),
        agentID: String?,
        configurationID: String?,
        accountID: String? = nil
    ) {
        self.id = id
        self.agentID = agentID
        self.configurationID = configurationID
        self.accountID = accountID
    }

    public var launchVariant: Dev3LaunchVariant {
        Dev3LaunchVariant(
            agentId: agentID,
            configId: configurationID,
            accountId: accountID
        )
    }
}

public struct TaskCreationFavoriteOption: Equatable, Identifiable, Sendable {
    public var id: String {
        "\(agentID)\u{0}\(configurationID)"
    }

    public let agentID: String
    public let configurationID: String
    public let label: String
    public let isEnabled: Bool

    public init(
        agentID: String,
        configurationID: String,
        label: String,
        isEnabled: Bool
    ) {
        self.agentID = agentID
        self.configurationID = configurationID
        self.label = label
        self.isEnabled = isEnabled
    }
}

public enum TaskCreationMode: Equatable, Sendable {
    case save
    case saveAndStart
}

public enum TaskCreationContext: Equatable, Sendable {
    case create
    case launchExisting(Dev3Task)
}

public struct TaskCreationLaunchResult: Equatable, Sendable {
    public let sourceTaskID: String
    public let projectID: String
    public let variants: [Dev3Task]
    public let provenance: TaskCreationProvenance

    public init(
        sourceTaskID: String,
        projectID: String,
        variants: [Dev3Task],
        provenance: TaskCreationProvenance
    ) {
        self.sourceTaskID = sourceTaskID
        self.projectID = projectID
        self.variants = variants
        self.provenance = provenance
    }
}

public enum TaskCreationEvent: Equatable, Sendable {
    case created(Dev3Task, provenance: TaskCreationProvenance)
    case updated(Dev3Task, provenance: TaskCreationProvenance)
    case replaced(TaskCreationLaunchResult)
    case reconciled(projectID: String, tasks: [Dev3Task], provenance: TaskCreationProvenance)
    case preparationFailed(Dev3Task, provenance: TaskCreationProvenance)
}

public enum TaskCreationValidationError: Error, Equatable, LocalizedError, Sendable {
    case projectUnavailable
    case descriptionRequired
    case noSelectableAgent
    case invalidVariant(Int)
    case existingTaskUnavailable

    public var errorDescription: String? {
        switch self {
        case .projectUnavailable:
            "Choose an available project."
        case .descriptionRequired:
            "Add a task description."
        case .noSelectableAgent:
            "No launch configuration is currently available."
        case let .invalidVariant(index):
            "Variant \(index + 1) needs an available agent and configuration."
        case .existingTaskUnavailable:
            "This task can no longer be started from Todo."
        }
    }
}

public enum TaskCreationAgentResolver {
    public static func defaultVariant(
        agents: [Dev3CodingAgent],
        settings: Dev3GlobalSettings
    ) -> TaskCreationVariant {
        let selectableAgents = agents.filter {
            !selectableConfigurations(for: $0, settings: settings).isEmpty
        }
        let agent = selectableAgents.first { $0.id == settings.defaultAgentId }
            ?? selectableAgents.first { $0.isDefault == true }
            ?? selectableAgents.first
        guard let agent else {
            return TaskCreationVariant(agentID: nil, configurationID: nil)
        }
        return TaskCreationVariant(
            agentID: agent.id,
            configurationID: defaultConfiguration(for: agent, settings: settings)?.id
        )
    }

    public static func defaultConfiguration(
        for agent: Dev3CodingAgent,
        settings: Dev3GlobalSettings
    ) -> Dev3AgentConfiguration? {
        let selectable = selectableConfigurations(for: agent, settings: settings)
        return selectable.first { $0.id == settings.defaultConfigId }
            ?? selectable.first { $0.id == agent.defaultConfigId }
            ?? selectable.first
    }

    public static func selectableConfigurations(
        for agent: Dev3CodingAgent,
        settings: Dev3GlobalSettings
    ) -> [Dev3AgentConfiguration] {
        agent.configurations.filter { isConfigurationEnabled($0, settings: settings) }
    }

    public static func isConfigurationEnabled(
        _ configuration: Dev3AgentConfiguration,
        settings: Dev3GlobalSettings
    ) -> Bool {
        configuration.requiresPxpipeProxy != true || settings.pxpipeProxyEnabled == true
    }

    public static func isVariantSelectable(
        _ variant: TaskCreationVariant,
        agents: [Dev3CodingAgent],
        settings: Dev3GlobalSettings
    ) -> Bool {
        guard let agentID = variant.agentID,
              let configurationID = variant.configurationID,
              let agent = agents.first(where: { $0.id == agentID }),
              let configuration = agent.configurations.first(where: { $0.id == configurationID })
        else {
            return false
        }
        return isConfigurationEnabled(configuration, settings: settings)
    }

    public static func favoriteOptions(
        agents: [Dev3CodingAgent],
        settings: Dev3GlobalSettings
    ) -> [TaskCreationFavoriteOption] {
        let ordered = (settings.favorites ?? []).sorted {
            $0.uses == $1.uses
                ? $0.lastUsedAt > $1.lastUsedAt
                : $0.uses > $1.uses
        }
        var seen = Set<String>()
        return ordered.compactMap { favorite in
            guard let agent = agents.first(where: { $0.id == favorite.agentId }),
                  let configuration = agent.configurations.first(where: { $0.id == favorite.configId })
            else {
                return nil
            }
            let key = "\(agent.id)\u{0}\(configuration.id)"
            guard seen.insert(key).inserted else { return nil }
            return TaskCreationFavoriteOption(
                agentID: agent.id,
                configurationID: configuration.id,
                label: "\(agent.name) · \(configuration.name)",
                isEnabled: isConfigurationEnabled(configuration, settings: settings)
            )
        }
    }
}
