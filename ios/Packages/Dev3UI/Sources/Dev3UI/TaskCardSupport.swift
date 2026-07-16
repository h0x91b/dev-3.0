import Dev3Kit
import SwiftUI

enum TaskCardSemantics {
    static func preparationLabel(_ task: Dev3Task) -> String {
        var label = task.preparingStage ?? "Preparing worktree"
        if let progress = task.preparingProgress {
            label += ", \(progress) percent"
        }
        return label
    }

    static func accessibilityLabel(
        task: Dev3Task,
        labels: [Dev3Label],
        variantSummary: TaskVariantSummary
    ) -> String {
        var parts = ["Task \(task.seq)", task.displayTitle, task.status.displayName]
        parts.append("priority \(task.effectivePriority.rawValue)")
        if !labels.isEmpty {
            parts.append("labels \(labels.map(\.name).joined(separator: ", "))")
        }
        if variantSummary.count > 1 {
            parts.append("\(variantSummary.count) variants")
        }
        if task.preparing == true {
            parts.append(preparationLabel(task))
        }
        if task.shuttingDown == true {
            parts.append("closing terminal")
        }
        return parts.joined(separator: ", ")
    }
}

extension Color {
    init?(dev3Hex value: String) {
        let normalized = value.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard normalized.count == 6, let rgb = UInt64(normalized, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension Dev3TaskStatus {
    var themeToken: Dev3StatusToken {
        switch self {
        case .todo:
            .todo
        case .inProgress:
            .inProgress
        case .userQuestions:
            .userQuestions
        case .reviewByAI:
            .reviewByAi
        case .reviewByUser:
            .reviewByUser
        case .reviewByColleague:
            .reviewByColleague
        case .completed:
            .completed
        case .cancelled:
            .cancelled
        }
    }
}
