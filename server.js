import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "40mb" }));

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENROUTER_API_KEY;
const CHAT = process.env.WORKMIND_MODEL || "openai/gpt-oss-20b";
const STT =
  process.env.WORKMIND_TRANSCRIBE_MODEL || "openai/whisper-large-v3";

/* ---------------- FRONTEND ---------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------------- OPENROUTER ---------------- */

async function post(apiPath, body) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY is not configured");

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

/* ---------------- SCHEMA ---------------- */

const itemProperties = {
  id: { type: ["string", "null"] },
  title: { type: "string" },
  owner: { type: ["string", "null"] },
  due: { type: ["string", "null"] },
  reason: { type: "string" },
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1
  }
};

const schema = {
  type: "object",
  properties: {
    myTasks: {
      type: "array",
      items: {
        type: "object",
        properties: itemProperties,
        required: [
          "id",
          "title",
          "owner",
          "due",
          "reason",
          "confidence"
        ],
        additionalProperties: false
      }
    },

    teamTasks: {
      type: "array",
      items: {
        type: "object",
        properties: itemProperties,
        required: [
          "id",
          "title",
          "owner",
          "due",
          "reason",
          "confidence"
        ],
        additionalProperties: false
      }
    },

    completedWork: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...itemProperties,
          matchedTaskId: {
            type: ["string", "null"]
          }
        },
        required: [
          "id",
          "title",
          "owner",
          "due",
          "reason",
          "confidence",
          "matchedTaskId"
        ],
        additionalProperties: false
      }
    },

    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          }
        },
        required: [
          "title",
          "reason",
          "confidence"
        ],
        additionalProperties: false
      }
    }
  },

  required: [
    "myTasks",
    "teamTasks",
    "completedWork",
    "notes"
  ],

  additionalProperties: false
};

/* ---------------- JSON PARSER ---------------- */

function parseModelJSON(content) {
  if (typeof content !== "string") return content;

  let cleaned = content.trim();

  console.log("WORKMIND RAW EXTRACTION RESPONSE:");
  console.log(cleaned);

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }

  throw new Error("AI returned invalid WorkMind data");
}

/* ---------------- EXTRACTION ---------------- */

async function extract(
  transcript,
  context = "",
  existingState = {}
) {
  const system = `
You are WorkMind, an operational memory assistant for a workplace supervisor.

The USER is the supervisor.

Analyze workplace conversation and maintain an accurate operational log.

Classify information into exactly four categories:

1. myTasks
Outstanding work personally owned by the USER/supervisor.

Examples:
"I'll call maintenance."
"I need to inspect Pump 12."
"I'll take care of that."

2. teamTasks
Outstanding work owned by another person.

Examples:
"Mike, inspect Pump 12."
"John is going to check the tank."
"I asked Sarah to finish the paperwork."

Set owner to the person's name when known.

3. completedWork
Work explicitly described as already completed.

Examples:
"Mike finished the inspection."
"I checked the tank already."
"John replaced the filter this morning."

If completed work clearly corresponds to an existing task,
set matchedTaskId to that existing task's id.

4. notes
Operational information worth remembering that is NOT an outstanding task
and is NOT itself completed work.

Examples:
"Pump 12 discharge pressure is low."
"The unit tripped twice this morning."
"Maintenance says the part arrives tomorrow."

IMPORTANT RULES:

- The user is a supervisor, not merely an individual task owner.
- Track BOTH the user's work and work owned by other people.
- Never convert another person's task into the user's task.
- Never treat completed work as outstanding.
- Never treat speculation as a firm task.
- Never invent an owner.
- Never invent a deadline.
- Never invent equipment, names, or details.
- Resolve references such as:
  "I'll do that"
  "Mike will handle it"
  "he finished it"
  "that's done"
using nearby context.

DEDUPLICATION:

A single real-world commitment must produce only ONE task.

If the conversation says:
"I need to inspect Pump 12"
and then clarifies
"I need to inspect the discharge valve on Pump 12 before lunch"

return ONE consolidated task such as:
"Inspect Pump 12 discharge valve"

Do not return both the broad task and its clarification.

EXISTING STATE:

Use existingState to avoid duplicates and understand updates.

If a new statement merely repeats an existing outstanding task,
do not create another task.

If work is reported complete and clearly matches an existing task,
return it in completedWork and populate matchedTaskId.

Only include items with confidence >= 0.65.

Keep titles concise and operational.

Return only valid JSON matching the supplied schema.
`;

  const result = await post("/chat/completions", {
    model: CHAT,

    messages: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content:
`PRIOR CONVERSATION CONTEXT:
${context || "(none)"}

CURRENT WORKMIND STATE:
${JSON.stringify(existingState)}

NEW TRANSCRIPT:
${transcript}`
      }
    ],

    response_format: {
      type: "json_schema",
      json_schema: {
        name: "workmind_supervisor_log",
        strict: true,
        schema
      }
    }
  });

  const content = result?.choices?.[0]?.message?.content;

  if (!content) {
    console.error(
      "FULL OPENROUTER RESPONSE:",
      JSON.stringify(result)
    );
    throw new Error("No structured model response");
  }

  const parsed = parseModelJSON(content);

  for (const key of [
    "myTasks",
    "teamTasks",
    "completedWork",
    "notes"
  ]) {
    if (!Array.isArray(parsed[key])) parsed[key] = [];

    parsed[key] = parsed[key].filter(
      x =>
        x &&
        typeof x.title === "string" &&
        typeof x.confidence === "number" &&
        x.confidence >= 0.65
    );
  }

  return parsed;
}

/* ---------------- HEALTH ---------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "5.1.0",
    mode: "Supervisor Operational Log",
    provider: "OpenRouter",
    apiKeyConfigured: Boolean(KEY),
    chatModel: CHAT,
    transcriptionModel: STT
  });
});

/* ---------------- TRANSCRIPTION ---------------- */

app.post("/api/transcribe", async (req, res) => {
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
});

/* ---------------- ANALYZE ---------------- */

app.post("/api/extract", async (req, res) => {
  try {
    const {
      transcript = "",
      context = "",
      existingState = {}
    } = req.body || {};

    if (!transcript.trim()) {
      return res.json({
        myTasks: [],
        teamTasks: [],
        completedWork: [],
        notes: []
      });
    }

    const result = await extract(
      transcript,
      context,
      existingState
    );

    res.json(result);
  } catch (error) {
    console.error(
      "EXTRACTION FAILED:",
      error.message
    );

    res.status(500).json({
      error: error.message
    });
  }
});

/* ---------------- ASK WORKMIND ---------------- */

app.post("/api/ask", async (req, res) => {
  try {
    const {
      question = "",
      transcript = "",
      state = {}
    } = req.body || {};

    const result = await post(
      "/chat/completions",
      {
        model: CHAT,
        messages: [
          {
            role: "system",
            content:
`You are WorkMind, an operational memory assistant for a workplace supervisor.

Answer only from the supplied transcript and WorkMind state.

Clearly distinguish:
- supervisor's tasks
- team tasks
- completed work
- operational notes

If the information is not recorded, say you do not have enough recorded information.`
          },
          {
            role: "user",
            content:
`TRANSCRIPT:
${transcript}

WORKMIND STATE:
${JSON.stringify(state)}

QUESTION:
${question}`
          }
        ]
      }
    );

    res.json({
      answer:
        result?.choices?.[0]?.message?.content || ""
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/* ---------------- SELF TEST ---------------- */

app.get("/api/self-test", async (req, res) => {
  if (!KEY) {
    return res.status(503).json({
      error: "OPENROUTER_API_KEY is not configured"
    });
  }

  const tests = [
    {
      name: "Supervisor self-task",
      text:
        "I need to inspect Pump 12 before lunch.",
      expect: "myTasks"
    },
    {
      name: "Team assignment",
      text:
        "Mike, inspect Pump 8 before end of shift.",
      expect: "teamTasks"
    },
    {
      name: "Completed work",
      text:
        "John already checked the tank level this morning.",
      expect: "completedWork"
    },
    {
      name: "Operational note",
      text:
        "Pump 4 discharge pressure is running low.",
      expect: "notes"
    },
    {
      name: "Hypothetical",
      text:
        "If Pump 4 acts up again maybe we should inspect the seal.",
      expect: "none"
    },
    {
      name: "Rejected assignment",
      text:
        'Manager: "Can you inspect Pump 8?" Me: "No, Mike will handle it."',
      expect: "teamTasks"
    },
    {
      name: "Duplicate clarification",
      text:
        "I need to inspect Pump 12. Specifically I need to inspect the discharge valve on Pump 12 before lunch.",
      expect: "singleMyTask"
    }
  ];

  const results = [];
  let passed = 0;

  for (const test of tests) {
    try {
      const r = await extract(test.text);

      let pass = false;

      if (test.expect === "none") {
        pass =
          r.myTasks.length === 0 &&
          r.teamTasks.length === 0 &&
          r.completedWork.length === 0;
      } else if (test.expect === "singleMyTask") {
        pass = r.myTasks.length === 1;
      } else {
        pass = r[test.expect]?.length >= 1;
      }

      if (pass) passed++;

      results.push({
        name: test.name,
        pass,
        result: r
      });
    } catch (error) {
      results.push({
        name: test.name,
        pass: false,
        error: error.message
      });
    }
  }

  res.json({
    version: "5.1.0",
    passed,
    total: tests.length,
    tests: results
  });
});

/* ---------------- SERVER ---------------- */

app.listen(PORT, () => {
  console.log(
    `WorkMind V5.1 listening on ${PORT}`
  );
});
