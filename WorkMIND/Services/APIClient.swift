import Foundation

actor APIClient {
    static let shared = APIClient()

    let baseURL = URL(string: "https://workmind-6bie.onrender.com")!

    private func post<T: Decodable, B: Encodable>(
        _ path: String,
        body: B
    ) async throws -> T {

        var request = URLRequest(
            url: baseURL.appendingPathComponent(path)
        )

        request.httpMethod = "POST"
        request.setValue(
            "application/json",
            forHTTPHeaderField: "Content-Type"
        )
        request.timeoutInterval = 60

        request.httpBody = try JSONEncoder.workMind.encode(body)

        let (data, response) =
            try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse,
              200..<300 ~= http.statusCode else {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder.workMind.decode(T.self, from: data)
    }

    func health() async throws {
        let url = baseURL.appendingPathComponent("api/health")

        let (_, response) = try await URLSession.shared.data(from: url)

        guard let http = response as? HTTPURLResponse,
              200..<300 ~= http.statusCode else {
            throw URLError(.badServerResponse)
        }
    }

    func transcribe(data: Data) async throws -> String {
        struct Body: Encodable {
            let audioBase64: String
            let format: String
        }

        let response: TranscriptionResponse = try await post(
            "api/transcribe",
            body: Body(
                audioBase64: data.base64EncodedString(),
                format: "m4a"
            )
        )

        return response.text
    }

    func extract(
        transcript: String,
        context: String,
        state: WorkState
    ) async throws -> [WorkAction] {

        struct Body: Encodable {
            let transcript: String
            let context: String
            let state: WorkState
        }

        let response: ActionEnvelope = try await post(
            "api/extract",
            body: Body(
                transcript: transcript,
                context: context,
                state: state
            )
        )

        return response.actions
    }

    func ask(
        _ question: String,
        transcript: String,
        state: WorkState
    ) async throws -> String {

        struct Body: Encodable {
            let question: String
            let transcript: String
            let state: WorkState
        }

        let response: AskResponse = try await post(
            "api/ask",
            body: Body(
                question: question,
                transcript: transcript,
                state: state
            )
        )

        return response.answer
    }
}

extension JSONEncoder {
    static var workMind: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var workMind: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
