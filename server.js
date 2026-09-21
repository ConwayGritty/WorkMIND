import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "40mb" }));

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY;

const CHAT =
  process.env.WORKMIND_MODEL ||
  "openai/gpt-oss-20b";

const STT =
  process.env.WORKMIND_TRANSCRIBE_MODEL ||
  "openai/whisper-large-v3";

/* -------------------------------------------------------
   FRONTEND
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* -------------------------------------------------------
   OPENROUTER REQUEST
------------------------------------------------------- */

async function post(apiPath, body) {
  if (!KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1" + apiPath,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "WorkMind"
      },

      body: JSON.stringify(body)
    }
  );

  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    console.error("OPENROUTER ERROR");
    console.error("Path:", apiPath);
    console.error("Status:", response.status);
    console.error("Response:", text);

    throw new Error(
      json?.error?.message ||
      json?.message ||
      `OpenRouter HTTP ${response.status}`
    );
  }

  return json;
}

/* -------------------------------------------------------
   TASK SCHEMA
------------------------------------------------------- */

const schema = {
  type: "object",

  properties: {
    tasks: {
      type: "array",

      items: {
        type: "object",

        properties: {
          title: {
            type: "string"
          },

          due: {
            type: ["string", "null"]
          },

          person: {
            type: ["string", "null"]
          },

          reason: {
            type: "string"
          },

          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          }
        },

        required: [
          "title",
          "due",
          "person",
          "reason",
          "confidence"
        ],

        additionalProperties: false
      }
    }
  },

  required: ["tasks"],
  additionalProperties: false
};

/* -------------------------------------------------------
   SAFE JSON PARSER
------------------------------------------------------- */

function parseModelJSON(content) {
  if (typeof content !== "string") {
    return content;
  }

  let cleaned = content.trim();

  console.log("WORKMIND RAW EXTRACTION RESPONSE:");
  console.log(cleaned);

  // Remove Markdown code fences if the model adds them.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // First try parsing the response directly.
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to recovery below.
  }

  // If the model included text around the JSON,
  // attempt to recover the JSON object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    const possibleJSON = cleaned.slice(start, end + 1);

    try {
      return JSON.parse(possibleJSON);
    } catch (error) {
      console.error("JSON recovery failed:", error.message);
    }
  }

  console.error("WORKMIND JSON PARSE FAILED");
  console.error("Raw response:", content);

  throw new Error("AI returned invalid task data");
}

/* -------------------------------------------------------
   TASK EXTRACTION
------------------------------------------------------- */

async function extract(
  transcript,
  context = "",
  existingTasks = []
) {
  const system = `
You are WorkMind, a workplace commitment detector.

Your job is to identify outstanding tasks that the USER personally owns.

INCLUDE:
- Work directly assigned to the user.
- Requests the user explicitly accepts.
- Explicit promises made by the user.
- Explicit self-commitments made by the user.

EXCLUDE:
- Tasks assigned to other people.
- Requests the user rejects.
- Hypothetical tasks.
- Suggestions.
- Casual discussion.
- Tasks already completed.
- Duplicate tasks.

Resolve phrases such as "I'll do that" using nearby conversational context.

Never invent:
- deadlines
- people
- equipment
- task details

Only return a task when confidence is at least 0.65.

Return valid JSON matching the provided schema.
`;

  const result = await post(
    "/chat/completions",
    {
      model: CHAT,

      messages: [
        {
          role: "system",
          content: system
        },

        {
          role: "user",
          content:
`PRIOR CONTEXT:
${context || "(none)"}

EXISTING TASKS:
${JSON.stringify(existingTasks)}

NEW TRANSCRIPT:
${transcript}`
        }
      ],

      response_format: {
        type: "json_schema",

        json_schema: {
          name: "workmind_tasks",
          strict: true,
          schema
        }
      }
    }
  );

  const content =
    result?.choices?.[0]?.message?.content;

  if (!content) {
    console.error(
      "FULL OPENROUTER RESPONSE:",
      JSON.stringify(result)
    );

    throw new Error(
      "No structured model response"
    );
  }

  const parsed = parseModelJSON(content);

  if (!parsed || !Array.isArray(parsed.tasks)) {
    console.error(
      "INVALID WORKMIND TASK RESPONSE:",
      parsed
    );

    throw new Error(
      "AI response did not contain a valid task list"
    );
  }

  // Extra protection:
  // never allow low-confidence tasks through.
  parsed.tasks = parsed.tasks.filter(task => {
    return (
      task &&
      typeof task.title === "string" &&
      typeof task.confidence === "number" &&
      task.confidence >= 0.65
    );
  });

  return parsed;
}

/* -------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "5.0.1",
    provider: "OpenRouter",
    apiKeyConfigured: Boolean(KEY),
    chatModel: CHAT,
    transcriptionModel: STT
  });
});

/* -------------------------------------------------------
   AUDIO TRANSCRIPTION
------------------------------------------------------- */

app.post(
  "/api/transcribe",
  async (req, res) => {
    try {
      const {
        audioBase64,
        format = "webm"
      } = req.body || {};

      if (!audioBase64) {
        return res.status(400).json({
          error: "audioBase64 required"
        });
      }

      console.log(
        `Transcribing audio: format=${format}, base64Length=${audioBase64.length}`
      );

      const result = await post(
        "/audio/transcriptions",
        {
          model: STT,

          input_audio: {
            data: audioBase64,
            format
          }
        }
      );

      console.log(
        "TRANSCRIPTION SUCCESS:",
        result?.text || "(empty)"
      );

      res.json({
        text: result?.text || "",
        usage: result?.usage || null
      });

    } catch (error) {
      console.error(
        "TRANSCRIPTION FAILED:",
        error.message
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------------------------------
   TASK EXTRACTION ENDPOINT
------------------------------------------------------- */

app.post(
  "/api/extract",
  async (req, res) => {
    try {
      const {
        transcript = "",
        context = "",
        existingTasks = []
      } = req.body || {};

      if (!transcript.trim()) {
        return res.json({
          tasks: []
        });
      }

      console.log(
        "EXTRACTING TASKS FROM TRANSCRIPT:"
      );

      console.log(transcript);

      const result = await extract(
        transcript,
        context,
        existingTasks
      );

      console.log(
        "TASK EXTRACTION SUCCESS:",
        JSON.stringify(result)
      );

      res.json(result);

    } catch (error) {
      console.error(
        "TASK EXTRACTION FAILED:",
        error.message
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------------------------------
   ASK WORKMIND
------------------------------------------------------- */

app.post(
  "/api/ask",
  async (req, res) => {
    try {
      const {
        question = "",
        transcript = "",
        tasks = []
      } = req.body || {};

      const result = await post(
        "/chat/completions",
        {
          model: CHAT,

          messages: [
            {
              role: "system",
              content:
                "Answer only from the supplied WorkMind transcript and task list. If the answer is absent, say you do not have enough recorded information."
            },

            {
              role: "user",

              content:
`TRANSCRIPT:
${transcript}

TASKS:
${JSON.stringify(tasks)}

QUESTION:
${question}`
            }
          ]
        }
      );

      res.json({
        answer:
          result?.choices?.[0]?.message?.content ||
          ""
      });

    } catch (error) {
      console.error(
        "ASK WORKMIND FAILED:",
        error.message
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------------------------------
   BENCHMARK TESTS
------------------------------------------------------- */

const cases = [
  [
    "accepted assignment",
    'Supervisor: "Please inspect Pump 12 before lunch." User: "Yep, I will do that."',
    1
  ],

  [
    "rejected request",
    'Supervisor: "Can you inspect Pump 8?" User: "No, ask Mike."',
    0
  ],

  [
    "coworker owns it",
    'Supervisor: "Mike, replace the filter before 3." User: "Sounds good."',
    0
  ],

  [
    "pronoun commitment",
    'Supervisor: "We need the turnaround paperwork submitted today." User: "I will do that after lunch."',
    1
  ],

  [
    "hypothetical",
    'User: "If Pump 4 acts up again, maybe we should inspect the seal."',
    0
  ],

  [
    "already completed",
    'User: "I already checked the tank level this morning."',
    0
  ],

  [
    "self commitment",
    'User: "I need to call maintenance about Valve 7 before end of shift."',
    1
  ]
];

/* -------------------------------------------------------
   SELF TEST
------------------------------------------------------- */

app.get(
  "/api/self-test",
  async (req, res) => {
    if (!KEY) {
      return res.status(503).json({
        apiKeyConfigured: false,
        error:
          "OPENROUTER_API_KEY is not configured"
      });
    }

    try {
      const ping = await post(
        "/chat/completions",
        {
          model: CHAT,

          messages: [
            {
              role: "user",
              content:
                "Reply exactly WORKMIND_OK"
            }
          ],

          max_tokens: 20
        }
      );

      const connectivity =
        (
          ping?.choices?.[0]?.message?.content ||
          ""
        ).includes("WORKMIND_OK");

      let passed = 0;
      const output = [];

      for (const [
        name,
        text,
        expected
      ] of cases) {

        try {
          const result =
            await extract(text);

          const count =
            result.tasks?.length || 0;

          const ok = expected
            ? count >= 1
            : count === 0;

          if (ok) {
            passed++;
          }

          output.push({
            name,
            expectedTasks: expected,
            actualTasks: count,
            pass: ok,
            tasks: result.tasks
          });

        } catch (error) {
          output.push({
            name,
            expectedTasks: expected,
            pass: false,
            error: error.message
          });
        }
      }

      res.json({
        apiKeyConfigured: true,

        modelConnectivity:
          connectivity,

        benchmark: {
          passed,
          total: cases.length,
          cases: output
        }
      });

    } catch (error) {
      console.error(
        "SELF TEST FAILED:",
        error.message
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(
    `WorkMind V5.0.1 listening on ${PORT}`
  );
});
