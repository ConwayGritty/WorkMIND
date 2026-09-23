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

    // MARK: - Start

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
            try beginContinuousRecording()

        } catch {
            shouldRun = false

            recorder?.stop()
            recorder = nil

            deactivateAudioSession()

            lastError =
                "Recording start failed: \(error.localizedDescription)"

            status = .stopped
        }
    }

    // MARK: - Stop

    func stop() {

        guard shouldRun else {
            return
        }

        shouldRun = false

        /*
         Stopping finalizes the M4A file.

         Once finalized, the worker can safely upload
         and process it.
        */
        recorder?.stop()
        recorder = nil

        deactivateAudioSession()

        refreshQueueCount()

        status = .stopped

        /*
         Give the worker an immediate opportunity
         to process the completed recording.
        */
        Task { [weak self] in
            await self?.processNext()
        }
    }

    // MARK: - Audio Session

    private func activateAudioSession() throws {

        let session = AVAudioSession.sharedInstance()

        /*
         This is intentionally a recording-only session.

         With the "audio" background mode enabled in the
         app's Info.plist, an actively recording app can
         continue its audio session while backgrounded.
        */
        try session.setCategory(
            .record,
            mode: .default,
            options: []
        )

        try session.setActive(
            true,
            options: []
        )
    }

    private func deactivateAudioSession() {

        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    // MARK: - Continuous Recording

    private func beginContinuousRecording() throws {

        guard shouldRun else {
            return
        }

        let filename =
            "recording-\(Date().timeIntervalSince1970)-\(UUID().uuidString).m4a"

        let url =
            queueDirectory.appendingPathComponent(
                filename
            )

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
                1,
                "The recorder could not prepare."
            )
        }

        /*
         IMPORTANT:

         record() has NO duration.

         The recorder therefore remains active until
         WorkMIND explicitly stops it or iOS interrupts
         the audio session.
        */
        guard newRecorder.record() else {
            throw recordingError(
                2,
                "The recorder could not start."
            )
        }

        recorder = newRecorder

        status = .recording
        lastError = nil
    }

    // MARK: - Finished Recording

    nonisolated func audioRecorderDidFinishRecording(
        _ recorder: AVAudioRecorder,
        successfully flag: Bool
    ) {

        Task { @MainActor [weak self] in

            guard let self else {
                return
            }

            /*
             Ignore the normal finish caused by the user
             pressing Stop.
            */
            guard self.shouldRun else {
                self.refreshQueueCount()
                return
            }

            self.recorder = nil
            self.refreshQueueCount()

            if flag {

                /*
                 Recording ended unexpectedly even though
                 WorkMIND is supposed to be running.

                 Restart it.
                */
                self.recover()

            } else {

                self.recover(
                    self.recordingError(
                        3,
                        "Recording ended unexpectedly."
                    )
                )
            }
        }
    }

    // MARK: - Recovery

    private func recover(
        _ error: Error? = nil
    ) {

        if let error {
            lastError =
                "Recording interrupted: \(error.localizedDescription)"
        }

        guard shouldRun else {
            status = .stopped
            return
        }

        status = .recovering
        restartCount += 1

        recorder?.stop()
        recorder = nil

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

                try beginContinuousRecording()

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

    // MARK: - Processing Worker

    private func startWorker() {

        worker?.cancel()

        worker = Task { [weak self] in

            while !Task.isCancelled {

                await self?.processNext()

                try? await Task.sleep(
                    for: .seconds(3)
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
         Never touch the file currently being recorded.

         AVAudioRecorder needs to finalize the M4A
         container before we upload it.
        */
        if url == recorder?.url {
            return
        }

        do {

            let data =
                try Data(contentsOf: url)

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
             Keep the recording on disk.

             It will be retried instead of discarded.
            */
            try? await Task.sleep(
                for: .seconds(8)
            )
        }
    }

    // MARK: - Queue

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

    // MARK: - Interruptions

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
        )

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

                /*
                 Only recover if recording genuinely
                 stopped after the route change.
                */
                if self.shouldRun &&
                    self.recorder?.isRecording != true {

                    self.recover()
                }
            }
        )
    }

    // MARK: - Encoding Error

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
                    4,
                    "An audio encoding error occurred."
                )
            )
        }
    }

    // MARK: - Error Helper

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
