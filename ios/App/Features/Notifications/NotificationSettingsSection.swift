import SwiftUI

@MainActor
struct NotificationSettingsSection: View {
    @Bindable var coordinator: NativeNotificationCoordinator
    @State private var isRequestingAuthorization = false
    @State private var authorizationError: String?

    var body: some View {
        Section {
            LabeledContent("Permission", value: authorizationLabel)
                .accessibilityIdentifier("settings.notifications.authorization")

            if coordinator.authorization == .notDetermined {
                Button("Enable Notifications") {
                    requestAuthorization()
                }
                .disabled(isRequestingAuthorization)
                .accessibilityIdentifier("settings.notifications.enable")
            }

            Toggle("Agent updates", isOn: preferenceBinding(\.webNotificationsEnabled))
                .accessibilityIdentifier("settings.notifications.web")
            Toggle("Needs attention", isOn: preferenceBinding(\.attentionNotificationsEnabled))
                .accessibilityIdentifier("settings.notifications.attention")
            Toggle("Terminal bells", isOn: preferenceBinding(\.terminalBellNotificationsEnabled))
                .accessibilityIdentifier("settings.notifications.terminalBell")
            Toggle("Terminal bell haptics", isOn: preferenceBinding(\.hapticsEnabled))
                .accessibilityIdentifier("settings.notifications.haptics")

            if let authorizationError {
                Label(authorizationError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("settings.notifications.error")
            } else if coordinator.authorization == .denied {
                Text("Notification permission is denied. You can enable it in iOS Settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.notifications.denied")
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text(NativeNotificationPolicy.backgroundDeliveryLimitation)
        }
        .task {
            await coordinator.refreshAuthorizationStatus()
        }
    }

    private var authorizationLabel: String {
        switch coordinator.authorization {
        case .notDetermined:
            "Not enabled"
        case .denied:
            "Denied"
        case .authorized:
            "Enabled"
        case .provisional:
            "Provisional"
        case .ephemeral:
            "Temporary"
        }
    }

    private func preferenceBinding(
        _ keyPath: WritableKeyPath<NativeNotificationPreferences, Bool>
    ) -> Binding<Bool> {
        Binding(
            get: { coordinator.preferences[keyPath: keyPath] },
            set: { enabled in
                var preferences = coordinator.preferences
                preferences[keyPath: keyPath] = enabled
                coordinator.updatePreferences(preferences)
            }
        )
    }

    private func requestAuthorization() {
        guard !isRequestingAuthorization else { return }
        isRequestingAuthorization = true
        authorizationError = nil
        Task {
            do {
                _ = try await coordinator.requestAuthorizationFromSettings()
            } catch {
                authorizationError = error.localizedDescription
            }
            isRequestingAuthorization = false
        }
    }
}
