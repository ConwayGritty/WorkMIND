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
    private var worker: Task<Void, Never>?

    private var shouldRun = false
    private var isStartingSegment = false

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

        do {
            try fileManager.createDirectory(
                at: queueDirectory,
                withIntermediateDirectories: true,
                attributes: nil
            )
        } catch {
            lastError =
                "Queue setup failed: \(error.localizedDescription)"
        }

        refreshQueueCount()
        observeAudioSession()
        startWorker()
    }

    func start() async {

        guard !shouldRun else {
            return
        }

        lastError = nil

        let granted =
            await AVAudioApplication.requestRecordPermission()

        guard granted else {
            lastError = "Microphone permission denied."
            status = .stopped
            return
        }

        shouldRun = true

        do {
            try activateAudioSession()
            try beginSegment()

        } catch {
            shouldRun = false
            recorder?.stop()
            recorder = nil

            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )

            lastError =
                "Recording start failed: \(error.localizedDescription)"

            status = .stopped
        }
    }

    func stop() {

        shouldRun = false
        isStartingSegment = false

        recorder?.stop()
        recorder = nil

        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )

        refreshQueueCount()
        status = .stopped
    }

    private func activateAudioSession() throws {

        let session = AVAudioSession.sharedInstance()

        try session.setCategory(
            .record,
            mode: .default,
            options: []
        )

        try session.setActive(true)
    }

    private func beginSegment() throws {

        guard shouldRun else {
            return
        }

        guard !isStartingSegment else {
            return
        }

        isStartingSegment = true
        defer {
            isStartingSegment = false
        }

        let filename =
            "segment-\(Date().timeIntervalSince1970)-\(UUID().uuidString).m4a"

        let url =
            queueDirectory.appendingPathComponent(filename)

        let settings: [String: Any] = [
            AVFormatIDKey:
                Int(kAudioFormatMPEG4AAC),

            AVSampleRateKey:
                44_100.0,

            AVNumberOfChannelsKey:
                1,

            AVEncoderBitRateKey:
                64_000,

            AVEncoderAudioQualityKey:
                AVAudioQuality.high.rawValue
        ]

        let newRecorder = try AVAudioRecorder(
            url: url,
            settings: settings
        )

        newRecorder.delegate = self
        newRecorder.isMeteringEnabled = false

        guard newRecorder.prepareToRecord() else {
            throw recordingError(
                2,
                "The audio recorder could not prepare."
            )
        }

        /*
         Important:

         record(forDuration:) lets AVAudioRecorder itself
         control the segment duration.

         We are NOT depending on a Swift Timer firing while
         the application is backgrounded.
        */
        guard newRecorder.record(
            forDuration: segmentSeconds
        ) else {
            throw recordingError(
                3,
                "The audio recorder could not start."
            )
        }

        recorder = newRecorder
        status = .recording
        lastError = nil
    }

    /*
     AVAudioRecorder calls this when a 20-second segment
     reaches its duration.

     This is what rotates recording instead of Timer.
    */
    nonisolated func audioRecorderDidFinishRecording(
        _ recorder: AVAudioRecorder,
        successfully flag: Bool
    ) {

        Task { @MainActor [weak self] in

            guard let self else {
                return
            }

            guard self.shouldRun else {
                return
            }

            self.recorder = nil
            self.refreshQueueCount()

            if !flag {
                self.recover(
                    self.recordingError(
                        4,
                        "Audio segment ended unexpectedly."
                    )
                )
                return
            }

            do {
                try self.beginSegment()
            } catch {
                self.recover(error)
            }
        }
    }

    private func recover(_ error: Error? = nil) {

        if let error {
            lastError =
                "Recording interrupted: \(error.localizedDescription)"
        }

        status = .recovering
        restartCount += 1

        recorder?.stop()
        recorder = nil

        guard shouldRun else {
            status = .stopped
            return
        }

        Task {

            try? await Task.sleep(
                for: .seconds(1)
            )

            guard shouldRun else {
                status = .stopped
                return
            }

            do {
                try activateAudioSession()
                try beginSegment()

            } catch {

                lastError =
                    "Recording recovery failed: \(error.localizedDescription)"

                try? await Task.sleep(
                    for: .seconds(3)
                )

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
            .filter {
                $0.pathExtension.lowercased() == "m4a"
            }
            .sorted {
                $0.lastPathComponent <
                $1.lastPathComponent
            }

        queuedSegments = files.count

        guard let url = files.first else {
            return
        }

        /*
         Never process the M4A file currently being written.
        */
        if url == recorder?.url {
            return
        }

        do {

            let data = try Data(
                contentsOf: url
            )

            guard data.count > 1000 else {
                try? fileManager.removeItem(
                    at: url
                )

                refreshQueueCount()
                return
            }

            let text =
                try await APIClient.shared.transcribe(
                    data: data
                )

            let cleanedText =
                text.trimmingCharacters(
                    in: .whitespacesAndNewlines
                )

            if !cleanedText.isEmpty {

                try await store?.processTranscript(
                    cleanedText
                )

                lastTranscriptAt = Date()
            }

            try fileManager.removeItem(
                at: url
            )

            processedSegments += 1
            refreshQueueCount()
            lastError = nil

        } catch {

            lastError =
                "Processing failed: \(error.localizedDescription)"

            /*
             Keep failed audio on disk.
             It can be retried later.
            */
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
                $0.pathExtension.lowercased() == "m4a"
            }
            .count
    }

    private func observeAudioSession() {

        NotificationCenter.default.addObserver(
            forName:
                AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in

            Task { @MainActor in

                guard let self else {
                    return
                }

                guard
                    let raw =
                        notification.userInfo?[
                            AVAudioSessionInterruptionTypeKey
                        ] as? UInt,

                    let type =
                        AVAudioSession.InterruptionType(
                            rawValue: raw
                        )
                else {
                    return
                }

                switch type {

                case .began:

                    if self.shouldRun {
                        self.status = .recovering
                    }

                case .ended:

                    if self.shouldRun {
                        self.recover()
                    }

                @unknown default:
                    break
                }
            }
        }

        NotificationCenter.default.addObserver(
            forName:
                AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in

            Task { @MainActor in

                guard let self else {
                    return
                }

                if self.shouldRun &&
                    self.recorder?.isRecording != true {

                    self.recover()
                }
            }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(
        _ recorder: AVAudioRecorder,
        error: Error?
    ) {

        Task { @MainActor [weak self] in

            guard let self else {
                return
            }

            self.recover(
                error ??
                self.recordingError(
                    5,
                    "An audio encoding error occurred."
                )
            )
        }
    }

    private func recordingError(
        _ code: Int,
        _ message: String
    ) -> NSError {

        NSError(
            domain: "WorkMIND.Recording",
            code: code,
            userInfo: [
                NSLocalizedDescriptionKey:
                    message
            ]
        )
    }
}
