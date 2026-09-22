import Foundation

enum WorkActionType: String, Codable {
    case createMyTask = "CREATE_MY_TASK"
    case createTeamTask = "CREATE_TEAM_TASK"
    case updateTask = "UPDATE_TASK"
    case reassignTask = "REASSIGN_TASK"
    case completeTask = "COMPLETE_TASK"
    case cancelTask = "CANCEL_TASK"
    case addCompletedWork = "ADD_COMPLETED_WORK"
    case addNote = "ADD_NOTE"
}

struct WorkAction: Codable {
    var action: WorkActionType
    var targetId: String?
    var title: String?
    var owner: String?
    var due: String?
    var details: String?
    var confidence: Double
}

struct ActionEnvelope: Codable {
    var actions: [WorkAction]
}

struct WorkItem: Identifiable, Codable, Equatable {
    var id: String
    var title: String
    var owner: String?
    var due: String?
    var details: String?
    var createdAt: Date = Date()
}

struct WorkEvent: Identifiable, Codable {
    var id = UUID()
    var type: String
    var text: String
    var at = Date()
}

struct WorkState: Codable {
    var myTasks: [WorkItem] = []
    var teamTasks: [WorkItem] = []
    var completedWork: [WorkItem] = []
    var notes: [WorkItem] = []
    var events: [WorkEvent] = []
}

struct TranscriptionResponse: Codable {
    let text: String
}

struct AskResponse: Codable {
    let answer: String
}
