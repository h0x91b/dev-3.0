@testable import Dev3Kit
import Foundation

func makeIATask(
    id: String,
    projectId: String = "project-1",
    seq: Int = 1,
    status: Dev3TaskStatus = .inProgress,
    priority: Dev3TaskPriority? = nil,
    createdAt: String = "2026-01-01T00:00:00Z",
    movedAt: String? = nil,
    columnOrder: Int? = nil,
    customColumnId: String? = nil,
    groupId: String? = nil,
    variantIndex: Int? = nil,
    labelIds: [String]? = nil,
    preparing: Bool? = nil,
    shuttingDown: Bool? = nil,
    watched: Bool? = nil,
    prNumber: Int? = nil,
    branchName: String? = nil
) -> Dev3Task {
    var object: [String: Any] = [
        "id": id,
        "seq": seq,
        "projectId": projectId,
        "title": "Task \(id)",
        "description": "Description",
        "status": status.rawValue,
        "baseBranch": "main",
        "createdAt": createdAt,
        "updatedAt": createdAt
    ]
    object["priority"] = priority?.rawValue
    object["movedAt"] = movedAt
    object["columnOrder"] = columnOrder
    object["customColumnId"] = customColumnId
    object["groupId"] = groupId
    object["variantIndex"] = variantIndex
    object["labelIds"] = labelIds
    object["preparing"] = preparing
    object["shuttingDown"] = shuttingDown
    object["watched"] = watched
    object["prNumber"] = prNumber
    object["branchName"] = branchName
    return decodeIAFixture(object)
}

func makeIAProject(
    id: String = "project-1",
    name: String = "Project",
    customColumns: [[String: Any]] = [],
    columnOrder: [String]? = nil,
    peerReviewEnabled: Bool? = nil,
    builtinColumnAgents: [String: Any]? = nil,
    kind: Dev3Project.Kind? = nil,
    builtin: Bool? = nil,
    labels: [[String: Any]] = []
) -> Dev3Project {
    var object: [String: Any] = [
        "id": id,
        "name": name,
        "path": "/tmp/\(id)",
        "setupScript": "",
        "devScript": "",
        "cleanupScript": "",
        "defaultBaseBranch": "main",
        "createdAt": "2026-01-01T00:00:00Z",
        "customColumns": customColumns,
        "labels": labels
    ]
    object["columnOrder"] = columnOrder
    object["peerReviewEnabled"] = peerReviewEnabled
    object["builtinColumnAgents"] = builtinColumnAgents
    object["kind"] = kind?.rawValue
    object["builtin"] = builtin
    return decodeIAFixture(object)
}

func makeIACustomColumn(_ id: String, name: String? = nil, color: String = "#4496ff") -> [String: Any] {
    [
        "id": id,
        "name": name ?? id,
        "color": color,
        "llmInstruction": "Move here"
    ]
}

private func decodeIAFixture<Value: Decodable>(_ object: [String: Any]) -> Value {
    do {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(Value.self, from: data)
    } catch {
        preconditionFailure("Invalid IA test fixture: \(error)")
    }
}
