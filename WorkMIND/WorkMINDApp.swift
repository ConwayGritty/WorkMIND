import SwiftUI

@main
struct WorkMINDApp: App {
    @StateObject private var store = WorkMindStore()
    @StateObject private var recorder = RecordingEngine()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(recorder)
                .task {
                    recorder.configure(store: store)
                    await store.checkHealth()
                }
        }
    }
}
