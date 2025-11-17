import os
import json
from datetime import date

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

# ---------- Setup ----------

load_dotenv()  # load .env if present

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
  raise RuntimeError("OPENAI_API_KEY is not set")

client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI(title="Adi Voice To-Do Backend")

# CORS so frontend (localhost or Vercel) can call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # for prod you can restrict to your Vercel URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Models ----------

class ParseRequest(BaseModel):
    text: str


# ---------- Helpers ----------

def build_system_prompt() -> str:
    today_str = date.today().isoformat()
    return f"""
You are an intent parser for a voice-first to-do list application.

TODAY'S DATE: {today_str}

User speaks natural language commands, e.g.:

- "Show me all high priority tasks"
- "Create a task to fix the bugs tomorrow at 3pm"
- "Delete the task about compliances"
- "Push the analytics task to next Monday"
- "Mark the third task as done"
- "Delete task 2"

Return a SINGLE JSON OBJECT with this shape:

{{
  "operation": "create" | "update" | "delete" | "filter" | "noop",
  "target": {{
    "mode": "by_index" | "by_match" | "all" | null,
    "index": number | null,
    "match_query": string | null
  }} | null,
  "data": {{
    "title": string | null,
    "scheduledTime": string | null,
    "priority": "high" | "medium" | "low" | null,
    "status": "pending" | "done" | null
  }}
}}

Rules:

1. If the user is creating a task:
   - operation = "create"
   - target = null
   - data.title = a short, meaningful summary (not just repeating the command)
   - If they mention time or date, convert to ISO 8601 in UTC, e.g. "2025-11-18T09:00:00Z".
   - If they say "tomorrow", "next Monday", etc, interpret relative to TODAY'S DATE above.
   - If priority not clearly specified, set data.priority = "low".
   - status defaults to "pending" unless clearly done/completed.

2. If they delete a specific task by number like "delete the 3rd task" or "delete task 2":
   - operation = "delete"
   - target.mode = "by_index"
   - target.index = that 1-based index (integer)
   - data can be empty (all fields null).

3. If they delete by description like "delete the task about compliances":
   - operation = "delete"
   - target.mode = "by_match"
   - target.match_query = short phrase to search in titles
   - target.index = null

4. If they update one task, e.g. "mark task 2 as done", "push the bug fix task to tomorrow":
   - operation = "update"
   - Pick either by_index or by_match same as above.
   - Fill only the fields in data that should change.
   - If they just say "mark task 2 as done", then:
       data.status = "done"
       other fields null.

5. If they only want to filter or show tasks, e.g. "show all high priority tasks":
   - You can set operation = "filter"
   - But for now, just use:
       operation = "noop"
       target = null
       data fields null
   The frontend will handle filtering locally by reusing the spoken text.

6. If you truly cannot understand or it's not about tasks at all:
   - operation = "noop"
   - target = null
   - all data fields null.

Important:
- ALWAYS respond with valid JSON, no comments, no trailing commas.
- Do NOT wrap JSON in backticks or text like "Here is the JSON".
- scheduledTime must be either a valid ISO-8601 string like "2025-11-18T09:00:00Z" or null.
"""


# ---------- Routes ----------

@app.get("/")
def root():
    return {"status": "ok", "message": "Adi voice to-do backend running"}

@app.post("/parse-intent")
async def parse_intent(body: ParseRequest):
    """
    Takes raw text from the frontend and returns a structured intent
    that the frontend will use to perform CRUD on the in-memory task list.
    """
    user_text = body.text.strip()
    print("Received text from frontend:", user_text)

    try:
        system_prompt = build_system_prompt()

        completion = client.chat.completions.create(
            model="gpt-4o-mini",  # or gpt-4.1-mini, gpt-5-mini etc.
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            temperature=0,
        )

        raw = completion.choices[0].message.content
        print("Raw model output:", raw)

        intent = json.loads(raw)

        # Basic sanity defaults / cleanup
        data = intent.get("data", {})
        if data.get("priority") is None:
            data["priority"] = "low"  # default low
        intent["data"] = data

        return {"intent": intent}

    except Exception as e:
        print("Error in /parse-intent:", e)
        raise HTTPException(status_code=500, detail="LLM parsing failed")
