import Dev3Kit
import Dev3UI
import Foundation

private struct OfflineTaskInfoError: LocalizedError {
    var errorDescription: String? {
        "Reconnect to edit this task."
    }
}

actor OfflineTaskInfoService: TaskInfoServicing {
    func renameTask(taskID _: String, projectID _: String, customTitle _: String?) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func moveTask(
        taskID _: String,
        projectID _: String,
        status _: Dev3TaskStatus,
        force _: Bool
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func moveTaskToCustomColumn(
        taskID _: String,
        projectID _: String,
        customColumnID _: String
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func setPriority(
        taskID _: String,
        projectID _: String,
        priority _: Dev3TaskPriority
    ) async throws -> [Dev3Task] {
        throw OfflineTaskInfoError()
    }

    func setWatched(
        taskID _: String,
        projectID _: String,
        watched _: Bool
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func setLabels(
        taskID _: String,
        projectID _: String,
        labelIDs _: [String]
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func setUserOverview(
        taskID _: String,
        projectID _: String,
        overview _: String
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func addNote(taskID _: String, projectID _: String, content _: String) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func updateNote(
        taskID _: String,
        projectID _: String,
        noteID _: String,
        content _: String
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func deleteNote(
        taskID _: String,
        projectID _: String,
        noteID _: String
    ) async throws -> Dev3Task {
        throw OfflineTaskInfoError()
    }

    func deleteTask(taskID _: String, projectID _: String) async throws {
        throw OfflineTaskInfoError()
    }

    func branchStatus(taskID _: String, projectID _: String) async throws -> Dev3BranchStatus {
        throw OfflineTaskInfoError()
    }

    func refreshPRStatus(taskID _: String, projectID _: String) async throws {
        throw OfflineTaskInfoError()
    }
}
