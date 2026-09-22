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
  process.env.WORKMIND_TRANSCRIBE_MODEL ||
  "openai/whisper-large-v3";

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------- OPENROUTER ---------- */

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
    console.error(text);

    throw new Error(
      json?.error?.message ||
      json?.message ||
      `OpenRouter HTTP ${response.status}`
    );
  }

  return json;
}

/* ---------- NORMALIZATION ---------- */

function clean(value) {
  if (value === null || value === undefined) return null;

  let s = String(value).trim();

  if (
    !s ||
    s === '""' ||
    s === "''" ||
    s.toLowerCase() === "null" ||
    s.toLowerCase() === "none" ||
    s.toLowerCase() === "n/a"
  ) {
    return null;
  }

  return s;
}

function cleanAction(a) {
  return {
    action: clean(a.action),
    targetId: clean(a.targetId),
    title: clean(a.title),
    owner: clean(a.owner),
    due: clean(a.due),
    details: clean(a.details),
    confidence:
      typeof a.confidence === "number"
        ? a.confidence
        : 0
  };
}

/* ---------- SCHEMA ---------- */

const actionSchema = {
  type: "object",

  properties: {
    action: {
      type: "string",
      enum: [
        "CREATE_MY_TASK",
        "CREATE_TEAM_TASK",
        "UPDATE_TASK",
        "REASSIGN_TASK",
        "COMPLETE_TASK",
        "CANCEL_TASK",
        "ADD_COMPLETED_WORK",
        "ADD_NOTE"
      ]
    },

    targetId: {
      type: ["string", "null"]
    },

    title: {
      type: ["string", "null"]
    },

    owner: {
      type: ["string", "null"]
    },

    due: {
      type: ["string", "null"]
    },

    details: {
      type: ["string", "null"]
    },

    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  },

  required: [
    "action",
    "targetId",
    "title",
    "owner",
    "due",
    "details",
    "confidence"
  ],

  additionalProperties: false
};

const schema = {
  type: "object",

  properties: {
    actions: {
      type: "array",
      items: actionSchema
    }
  },

  required: ["actions"],
  additionalProperties: false
};

/* ---------- JSON PARSER ---------- */

function parseModelJSON(content) {
  if (typeof content !== "string") {
    return content;
  }

  let cleaned = content
    .trim()
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
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    } catch {}
  }

  console.error("INVALID AI JSON:");
  console.error(content);

  throw new Error("AI returned invalid WorkMind data");
}

/* ---------- WORKMIND BRAIN ---------- */

async function analyzeWork(
  transcript,
  context = "",
  state = {}
) {
  const system = `
You are WorkMind V5.2.

You are an operational memory assistant for a workplace supervisor.

The USER is the supervisor.

You do NOT return a rebuilt task list.

Instead, return ACTIONS that should be applied to the CURRENT WORKMIND STATE.

AVAILABLE ACTIONS:

CREATE_MY_TASK
Create new outstanding work owned personally by the supervisor.

CREATE_TEAM_TASK
Create new outstanding work owned by another person.

UPDATE_TASK
Modify an existing task, such as changing its due time, wording, or details.

REASSIGN_TASK
Change ownership of an existing task.

COMPLETE_TASK
An existing task was actually completed.

CANCEL_TASK
An existing task was cancelled or is no longer required.
Cancellation is NOT completion.

ADD_COMPLETED_WORK
Work was already completed but does not correspond to an existing task.

ADD_NOTE
Important operational information that is not an outstanding task and is not itself a completed action.

TARGET IDs:

For UPDATE_TASK, REASSIGN_TASK, COMPLETE_TASK and CANCEL_TASK:
targetId MUST equal the ID of the matching existing task.

Never invent a targetId.

If you cannot confidently identify the existing task, do not target one.

TASK OWNERSHIP:

"I'll..." or "I need to..." generally means the supervisor owns it.

"Mike will..." or "Mike, please..." generally means Mike owns it.

Never assign another person's work to the supervisor merely because the supervisor discussed it.

UPDATES:

If an existing task says:

ID abc123
Mike
Inspect Pump 12
Due before lunch

and the user says:

"Actually Mike can do Pump 12 before end of shift."

Return:

UPDATE_TASK
targetId abc123
due "before end of shift"

Do NOT create another task.

REASSIGNMENT:

If Mike owns an existing Valve 7 task and the user says:

"Actually John will take care of Valve 7."

Return REASSIGN_TASK targeting that existing task with owner "John".

Do NOT create another task.

COMPLETION:

If the user says:

"Mike finished it."

and context clearly identifies an existing Mike task,
return COMPLETE_TASK targeting that task.

Include useful result information in details.

CANCELLATION:

"Cancel that."
"We don't need that anymore."
"Scratch the Pump 12 inspection."

Return CANCEL_TASK targeting the existing task.

Do NOT mark cancelled work completed.

COMPLETED WORK:

Statements describing actions that already occurred should be recorded as completed work when operationally useful.

Example:
"Maintenance has been notified about Pump 12."

That is completed work.

"Operations reduced Pump 12 to 70 percent."

That is also completed work because an operational action occurred.

NOTES:

Conditions, observations and states belong in ADD_NOTE.

Examples:

"Pump 12 is vibrating more than normal."

"The discharge pressure is low."

"The unit is currently at 70 percent."

DUPLICATES:

Never create a new task when the new statement is merely:
- repeating an existing task
- clarifying an existing task
- changing an existing task
- reassigning an existing task
- completing an existing task
- cancelling an existing task

Use the existing task ID.

If a broad commitment is immediately clarified:

"I need to inspect Pump 12.
Specifically the discharge valve before lunch."

create ONE task:
"Inspect Pump 12 discharge valve"
due before lunch.

MULTIPLE ACTIONS:

A single transcript may produce multiple actions.

Example:

"Pump 12 is vibrating badly.
Operations reduced it to 70 percent.
Maintenance has been notified."

Return:
ADD_NOTE for the vibration.
ADD_COMPLETED_WORK for reducing Pump 12.
ADD_COMPLETED_WORK for notifying maintenance.

Do not invent:
- names
- deadlines
- equipment
- results
- task ownership

Only return actions with confidence >= 0.65.

Keep titles concise and operational.

Use null instead of empty strings.

Return ONLY valid JSON matching the schema.
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
`PRIOR TRANSCRIPT CONTEXT:
${context || "(none)"}

CURRENT WORKMIND STATE:
${JSON.stringify(state)}

NEW TRANSCRIPT:
${transcript}`
        }
      ],

      response_format: {
        type: "json_schema",
        json_schema: {
          name: "workmind_actions",
          strict: true,
          schema
        }
      }
    }
  );

  const content =
    result?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No structured model response");
  }

  const parsed = parseModelJSON(content);

  if (!Array.isArray(parsed.actions)) {
    throw new Error(
      "AI response did not contain actions"
    );
  }

  return {
    actions: parsed.actions
      .map(cleanAction)
      .filter(
        a =>
          a.action &&
          a.confidence >= 0.65
      )
  };
}

/* ---------- HEALTH ---------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "5.2.0",
    mode: "Supervisor Event Engine",
    provider: "OpenRouter",
    apiKeyConfigured: Boolean(KEY),
    chatModel: CHAT,
    transcriptionModel: STT
  });
});

/* ---------- TRANSCRIPTION ---------- */

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

/* ---------- EXTRACTION ---------- */

app.post("/api/extract", async (req, res) => {
  try {
    const {
      transcript = "",
      context = "",
      state = {}
    } = req.body || {};

    if (!transcript.trim()) {
      return res.json({
        actions: []
      });
    }

    const result = await analyzeWork(
      transcript,
      context,
      state
    );

    console.log(
      "WORKMIND ACTIONS:",
      JSON.stringify(result)
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

/* ---------- ASK ---------- */

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

Answer strictly from the supplied WorkMind data.

The event history is important.

Use it to explain task creation, deadline changes, reassignment, completion and cancellation when relevant.

Do not invent missing information.

If information was never recorded, say so clearly.`
          },

          {
            role: "user",
            content:
`TRANSCRIPT:
${transcript}

CURRENT STATE AND EVENT HISTORY:
${JSON.stringify(state)}

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
    res.status(500).json({
      error: error.message
    });
  }
});

/* ---------- SELF TEST ---------- */

app.get("/api/self-test", async (req, res) => {
  res.json({
    ok: true,
    version: "5.2.0",
    message:
      "V5.2 event engine online. Use the interactive benchmark in the app."
  });
});

/* ---------- START ---------- */

app.listen(PORT, () => {
  console.log(
    `WorkMind V5.2 listening on ${PORT}`
  );
});
