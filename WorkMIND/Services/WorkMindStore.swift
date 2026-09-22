import Foundation

@MainActor
final class WorkMindStore: ObservableObject {
    @Published var state = WorkState()
    @Published var transcript = ""
    @Published var backendOnline = false
    @Published var lastError: String?

    private let stateKey = "wm_ios_v1_state"
    private let transcriptKey = "wm_ios_v1_transcript"

    init() {
        load()
    }

    func checkHealth() async {
        do {
            try await APIClient.shared.health()
            backendOnline = true
        } catch {
            backendOnline = false
            lastError = error.localizedDescription
        }
    }

    func processTranscript(_ text: String) async throws {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }

        let previousTranscript = transcript

        transcript += (transcript.isEmpty ? "" : "\n") + cleaned
        save()

        let actions = try await APIClient.shared.extract(
            transcript: cleaned,
            context: String(previousTranscript.suffix(4000)),
            state: state
        )

        actions
            .filter { $0.confidence >= 0.65 }
            .forEach(apply)

        save()
    }

    func ask(_ question: String) async throws -> String {
        try await APIClient.shared.ask(
            question,
            transcript: transcript,
            state: state
        )
    }

    func completeManually(_ item: WorkItem) {
        removeOpen(id: item.id)

        var completed = item

        let note = "Marked complete manually"

        if let details = completed.details, !details.isEmpty {
            completed.details = details + " · " + note
        } else {
            completed.details = note
        }

        state.completedWork.insert(completed, at: 0)

        addEvent(
            type: "COMPLETE",
            text: item.title
        )

        save()
    }

    private func apply(_ action: WorkAction) {
        switch action.action {

        case .createMyTask:
            guard let title = clean(action.title) else { return }

            guard !containsOpen(title) else { return }

            let item = WorkItem(
                id: newID(),
                title: title,
                owner: "Supervisor",
                due: clean(action.due),
                details: clean(action.details)
            )

            state.myTasks.append(item)

            addEvent(
                type: "CREATE",
                text: title
            )

        case .createTeamTask:
            guard
                let title = clean(action.title),
                let owner = clean(action.owner)
            else { return }

            guard !containsOpen(title) else { return }

            let item = WorkItem(
                id: newID(),
                title: title,
                owner: owner,
                due: clean(action.due),
                details: clean(action.details)
            )

            state.teamTasks.append(item)

            addEvent(
                type: "CREATE",
                text: "\(owner): \(title)"
            )

        case .updateTask:
            guard let id = action.targetId else { return }

            mutate(id) { item in
                if let title = clean(action.title) {
                    item.title = title
                }

                if let due = clean(action.due) {
                    item.due = due
                }

                if let details = clean(action.details) {
                    item.details = details
                }
            }

            addEvent(
                type: "UPDATE",
                text: action.title ?? id
            )

        case .reassignTask:
            guard
                let id = action.targetId,
                let owner = clean(action.owner),
                var item = takeOpen(id: id)
            else { return }

            item.owner = owner

            let normalizedOwner = owner.lowercased()

            if normalizedOwner == "supervisor" ||
                normalizedOwner == "me" ||
                normalizedOwner == "myself" {

                state.myTasks.append(item)

            } else {
                state.teamTasks.append(item)
            }

            addEvent(
                type: "REASSIGN",
                text: "\(item.title) → \(owner)"
            )

        case .completeTask:
            guard
                let id = action.targetId,
                var item = takeOpen(id: id)
            else { return }

            if let details = clean(action.details) {
                item.details = details
            }

            state.completedWork.insert(item, at: 0)

            addEvent(
                type: "COMPLETE",
                text: item.title
            )

        case .cancelTask:
            guard
                let id = action.targetId,
                let item = takeOpen(id: id)
            else { return }

            addEvent(
                type: "CANCEL",
                text: item.title
            )

        case .addCompletedWork:
            guard let title = clean(action.title) else { return }

            guard !contains(state.completedWork, title) else { return }

            let item = WorkItem(
                id: newID(),
                title: title,
                owner: clean(action.owner),
                due: nil,
                details: clean(action.details)
            )

            state.completedWork.insert(item, at: 0)

            addEvent(
                type: "COMPLETE",
                text: title
            )

        case .addNote:
            guard let title = clean(action.title) else { return }

            guard !contains(state.notes, title) else { return }

            let item = WorkItem(
                id: newID(),
                title: title,
                owner: nil,
                due: nil,
                details: clean(action.details)
            )

            state.notes.insert(item, at: 0)

            addEvent(
                type: "NOTE",
                text: title
            )
        }
    }

    private func clean(_ value: String?) -> String? {
        guard let value = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return nil
        }

        guard !value.isEmpty else { return nil }

        let lower = value.lowercased()

        guard
            value != "\"\"",
            lower != "null",
            lower != "none",
            lower != "n/a"
        else {
            return nil
        }

        return value
    }

    private func newID() -> String {
        UUID().uuidString.lowercased()
    }

    private func normalized(_ value: String) -> String {
        value
            .lowercased()
            .filter { $0.isLetter || $0.isNumber }
    }

    private func contains(
        _ items: [WorkItem],
        _ title: String
    ) -> Bool {
        items.contains {
            normalized($0.title) == normalized(title)
        }
    }

    private func containsOpen(_ title: String) -> Bool {
        contains(state.myTasks, title) ||
        contains(state.teamTasks, title)
    }

    private func mutate(
        _ id: String,
        _ update: (inout WorkItem) -> Void
    ) {
        if let index = state.myTasks.firstIndex(
            where: { $0.id == id }
        ) {
            update(&state.myTasks[index])
            return
        }

        if let index = state.teamTasks.firstIndex(
            where: { $0.id == id }
        ) {
            update(&state.teamTasks[index])
        }
    }

    private func takeOpen(id: String) -> WorkItem? {
        if let index = state.myTasks.firstIndex(
            where: { $0.id == id }
        ) {
            return state.myTasks.remove(at: index)
        }

        if let index = state.teamTasks.firstIndex(
            where: { $0.id == id }
        ) {
            return state.teamTasks.remove(at: index)
        }

        return nil
    }

    private func removeOpen(id: String) {
        _ = takeOpen(id: id)
    }

    private func addEvent(
        type: String,
        text: String
    ) {
        state.events.insert(
            WorkEvent(
                type: type,
                text: text
            ),
            at: 0
        )
    }

    private func save() {
        if let data = try? JSONEncoder.workMind.encode(state) {
            UserDefaults.standard.set(
                data,
                forKey: stateKey
            )
        }

        UserDefaults.standard.set(
            transcript,
            forKey: transcriptKey
        )
    }

    private func load() {
        if
            let data = UserDefaults.standard.data(
                forKey: stateKey
            ),
            let savedState = try? JSONDecoder.workMind.decode(
                WorkState.self,
                from: data
            )
        {
            state = savedState
        }

        transcript =
            UserDefaults.standard.string(
                forKey: transcriptKey
            ) ?? ""
    }
}
