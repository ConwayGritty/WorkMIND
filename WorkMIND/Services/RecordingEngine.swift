import Foundation
import AVFoundation

@MainActor
final class RecordingEngine: NSObject, ObservableObject, AVAudioRecorderDelegate {

    enum Status: String {
        case stopped = "STOPPED"
        case recording = "RECORDING"
        case recovering = "RECOVERING"
    }

    @Published var status: Status = .stopped
    @Published var queuedSegments = 0
    @Published var processedSegments = 0
    @Published var restartCount = 0
    @Published var lastTranscriptAt: Date?
    @Published var lastError: String?

    private weak var store: WorkMindStore?
    private var recorder: AVAudioRecorder?
    private var segmentTimer: Timer?
    private var worker: Task<Void, Never>?
    private var shouldRun = false

    private let segmentSeconds: TimeInterval = 20
    private let fileManager = FileManager.default

    private var queueDirectory: URL {
        let base = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]

        return base.appendingPathComponent(
            "WorkMINDQueue",
            isDirectory: true
        )
    }

    func configure(store: WorkMindStore) {
        self.store = store

        try? fileManager.createDirectory(
            at: queueDirectory,
            withIntermediateDirectories: true
        )

        refreshQueueCount()
        observeAudioSession()
        startWorker()
    }

    func start() async {
        let granted = await AVAudioApplication.requestRecordPermission()

        guard granted else {
            lastError = "Microphone permission denied."
            return
        }

        shouldRun = true

        do {
            try activateAudioSession()
            try beginSegment()
            status = .recording
        } catch {
            lastError = error.localizedDescription
            status = .stopped
        }
    }

    func stop() {
        shouldRun = false
        segmentTimer?.invalidate()
        recorder?.stop()
        recorder = nil
        status = .stopped
    }

    private func activateAudioSession() throws {
        let session = AVAudioSession.sharedInstance()

        try session.setCategory(
            .record,
            mode: .spokenAudio,
            options: [.allowBluetoothHFP]
        )

        try session.setActive(true)
    }

    private func beginSegment() throws {
        guard shouldRun else { return }

        let filename =
            "segment-\(Date().timeIntervalSince1970)-\(UUID().uuidString).m4a"

        let url = queueDirectory.appendingPathComponent(filename)

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
            AVEncoderAudioQualityKey:
                AVAudioQuality.medium.rawValue
        ]

        let newRecorder = try AVAudioRecorder(
            url: url,
            settings: settings
        )

        newRecorder.delegate = self
        newRecorder.prepareToRecord()

        guard newRecorder.record() else {
            throw NSError(
                domain: "WorkMIND",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Recorder failed to start."
                ]
            )
        }

        recorder = newRecorder

        segmentTimer?.invalidate()

        segmentTimer = Timer.scheduledTimer(
            withTimeInterval: segmentSeconds,
            repeats: false
        ) { [weak self] _ in

            Task { @MainActor in
                self?.rotateSegment()
            }
        }

        status = .recording
    }

    private func rotateSegment() {
        guard shouldRun else { return }

        recorder?.stop()
        recorder = nil

        refreshQueueCount()

        do {
            try beginSegment()
        } catch {
            recover(error)
        }
    }

    private func recover(_ error: Error? = nil) {
        lastError = error?.localizedDescription
        status = .recovering
        restartCount += 1

        recorder?.stop()
        recorder = nil
        segmentTimer?.invalidate()

        guard shouldRun else {
            status = .stopped
            return
        }

        Task {
            try? await Task.sleep(for: .seconds(1))

            do {
                try activateAudioSession()
                try beginSegment()
            } catch {
                lastError = error.localizedDescription

                try? await Task.sleep(for: .seconds(3))

                if shouldRun {
                    recover(error)
                }
            }
        }
    }

    private func startWorker() {
        worker?.cancel()

        worker = Task { [weak self] in
            while !Task.isCancelled {
                await self?.processNext()

                try? await Task.sleep(
                    for: .seconds(2)
                )
            }
        }
    }

    private func processNext() async {
        let files =
            ((try? fileManager.contentsOfDirectory(
                at: queueDirectory,
                includingPropertiesForKeys: nil
            )) ?? [])
            .filter { $0.pathExtension == "m4a" }
            .sorted {
                $0.lastPathComponent <
                $1.lastPathComponent
            }

        queuedSegments = files.count

        guard let url = files.first else {
            return
        }

        // Never process the segment currently being recorded.
        if url == recorder?.url {
            return
        }

        do {
            let data = try Data(contentsOf: url)

            guard data.count > 1000 else {
                try? fileManager.removeItem(at: url)
                return
            }

            let text =
                try await APIClient.shared.transcribe(
                    data: data
                )

            if !text
                .trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                .isEmpty {

                try await store?.processTranscript(text)

                lastTranscriptAt = Date()
            }

            try fileManager.removeItem(at: url)

            processedSegments += 1
            refreshQueueCount()

        } catch {
            lastError = error.localizedDescription

            // Keep the audio file so it can retry later.
            try? await Task.sleep(
                for: .seconds(8)
            )
        }
    }

    private func refreshQueueCount() {
        queuedSegments =
            ((try? fileManager.contentsOfDirectory(
                at: queueDirectory,
                includingPropertiesForKeys: nil
            )) ?? [])
            .filter {
                $0.pathExtension == "m4a"
            }
            .count
    }

    private func observeAudioSession() {
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in

            Task { @MainActor in
                guard let self else { return }

                if
                    let raw =
                        notification.userInfo?[
                            AVAudioSessionInterruptionTypeKey
                        ] as? UInt,
                    let type =
                        AVAudioSession.InterruptionType(
                            rawValue: raw
                        )
                {
                    if type == .began {
                        self.status = .recovering
                    } else if self.shouldRun {
                        self.recover()
                    }
                }
            }
        }

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in

            Task { @MainActor in
                guard let self else { return }

                if self.shouldRun &&
                    self.recorder?.isRecording != true {

                    self.recover()
                }
            }
        }
    }

    func audioRecorderEncodeErrorDidOccur(
        _ recorder: AVAudioRecorder,
        error: Error?
    ) {
        recover(error)
    }
}
