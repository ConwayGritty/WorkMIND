import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: WorkMindStore
    @EnvironmentObject var recorder: RecordingEngine

    @State private var question = ""
    @State private var answer = ""
    @State private var asking = false

    var body: some View {
        NavigationStack {
            List {

                Section {
                    VStack(alignment: .leading, spacing: 8) {

                        HStack {
                            VStack(alignment: .leading) {

                                Text(
                                    recorder.status == .recording
                                    ? "🟢 RECORDING"
                                    : recorder.status == .recovering
                                    ? "🟠 RECOVERING…"
                                    : "🔴 RECORDING STOPPED"
                                )
                                .font(.headline)

                                Text(
                                    "Queue \(recorder.queuedSegments) · Processed \(recorder.processedSegments) · Restarts \(recorder.restartCount)"
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Button(
                                recorder.status == .stopped
                                ? "Start"
                                : "Stop"
                            ) {
                                if recorder.status == .stopped {
                                    Task {
                                        await recorder.start()
                                    }
                                } else {
                                    recorder.stop()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        HStack {
                            Circle()
                                .frame(width: 8, height: 8)

                            Text(
                                store.backendOnline
                                ? "WorkMIND server online"
                                : "WorkMIND server offline"
                            )
                        }
                        .foregroundStyle(
                            store.backendOnline
                            ? .green
                            : .red
                        )
                    }
                }

                taskSection(
                    "My Tasks",
                    items: store.state.myTasks
                )

                taskSection(
                    "Team Tasks",
                    items: store.state.teamTasks
                )

                Section("Completed Work") {
                    ForEach(store.state.completedWork) { item in
                        ItemRow(item: item)
                    }
                }

                Section("Shift Notes") {
                    ForEach(store.state.notes) { item in
                        ItemRow(item: item)
                    }
                }

                Section("Ask WorkMIND") {

                    TextField(
                        "What happened with Pump 12?",
                        text: $question
                    )

                    Button(
                        asking ? "Thinking…" : "Ask"
                    ) {
                        guard !question.isEmpty else {
                            return
                        }

                        asking = true

                        Task {
                            do {
                                answer = try await store.ask(
                                    question
                                )
                            } catch {
                                answer =
                                    error.localizedDescription
                            }

                            asking = false
                        }
                    }
                    .disabled(asking)

                    if !answer.isEmpty {
                        Text(answer)
                    }
                }

                Section("Activity History") {
                    ForEach(
                        Array(store.state.events.prefix(50))
                    ) { event in

                        VStack(alignment: .leading) {

                            Text(
                                "\(event.type) · \(event.text)"
                            )

                            Text(
                                event.at.formatted()
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Transcript") {
                    Text(
                        store.transcript.isEmpty
                        ? "No transcript yet."
                        : store.transcript
                    )
                    .font(.caption)
                }

                if let error =
                    recorder.lastError ??
                    store.lastError {

                    Section("Diagnostics") {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("WorkMIND")
        }
    }

    @ViewBuilder
    private func taskSection(
        _ title: String,
        items: [WorkItem]
    ) -> some View {

        Section(title) {

            ForEach(items) { item in

                HStack {

                    ItemRow(item: item)

                    Spacer()

                    Button {
                        store.completeManually(item)
                    } label: {
                        Image(
                            systemName:
                                "checkmark.circle"
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct ItemRow: View {
    let item: WorkItem

    var body: some View {

        VStack(
            alignment: .leading,
            spacing: 3
        ) {

            Text(item.title)

            let metadata =
                [item.owner, item.due]
                .compactMap { $0 }
                .filter { !$0.isEmpty }

            if !metadata.isEmpty {
                Text(
                    metadata.joined(
                        separator: " · "
                    )
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if let details = item.details,
               !details.isEmpty {

                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
