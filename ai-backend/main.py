import os
import json
from datetime import date
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

load_dotenv()

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI()

# Allow local frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ParseRequest(BaseModel):
    text: str


@app.post("/parse-intent")
async def parse_intent(req: ParseRequest):
    user_text = req.text

    today_str = date.today().isoformat()

    system_prompt = f"""
You are an intent parser for a voice-first to-do list app.

TODAY'S DATE
- Assume that "today" is {today_str}.
- When the user says relative dates like "today", "tomorrow", "day after tomorrow",
  "next Monday", etc., you MUST convert them into an absolute calendar date
  relative to {today_str}.
- Output the date in ISO 8601 form with a time, e.g. "2025-11-16T10:00:00Z".
  If the user doesn't specify a time, you can choose a reasonable default, e.g. 09:00.

TASK MODEL
You must always respond with a single JSON object with this shape:

{{
  "operation": "create" | "update" | "delete" | "filter" | "noop",
  "target": {{
    "mode": "by_index" | "by_match" | "all" | null,
    "index": number | null,
    "match_query": string | null
  }},
  "data": {{
    "title": string | null,
    "scheduledTime": string | null,
    "priority": "high" | "medium" | "low" | null,
    "status": "pending" | "done" | null
  }}
}}

RULES

1. OPERATION DETECTION
- "create", "add", "make a task", etc. → operation = "create"
- "delete", "remove", "clear" → operation = "delete"
- "update", "change", "reschedule", "mark as done" → operation = "update"
- "show", "filter", "list" → operation = "filter"
- If you truly can't understand, use operation = "noop" and leave target/data mostly null.

2. TARGET
- If the user says "task 3", "third task", "delete the 4th task" etc.,
  set target.mode = "by_index" and target.index = that 1-based index number.
- If the user refers to a task by description, like "the task about compliances",
  set target.mode = "by_match" and target.match_query to a short phrase
  such as "compliances".
- For "delete all tasks" or "clear everything", use target.mode = "all".
- If there is no clear target (e.g. create), use target.mode = null.

3. DATA FIELDS
- title:
    * For create operations, ALWAYS provide a short, interesting, action-oriented
      title based on the command, even if the user did not give an exact title.
      Example: user says "fix the bugs in payments tomorrow" →
      title could be "Fix payment bugs in checkout".
    * For update operations, set title only if the user clearly wants to rename
      the task; otherwise leave it null.
- scheduledTime:
    * If the user clearly specifies a date/time (absolute or relative),
      convert it into an ISO string as described above.
    * If they say "tomorrow morning" and you need a time, choose something
      like 09:00.
    * If no scheduling information is present, use null.
- priority:
    * Valid values are: "high", "medium", "low".
    * If the user explicitly says priority (e.g. "high priority", "very important"),
      map that correctly.
    * If the user does NOT say a priority, **default to "low"**, not null.
- status:
    * Use "done" when the user marks something as completed.
    * Use "pending" for active tasks.
    * If not specified, leave null (the frontend will keep the old value or set pending).

OUTPUT
- You MUST return only valid JSON that matches the schema above.
- Do not include explanations or extra keys.
"""

    completion = client.chat.completions.create(
        # You can change this to "gpt-4o-mini" if you prefer
        model="gpt-4o-mini",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        temperature=0,
    )

    # With response_format=json_object, content[0].text should be a JSON string
    message = completion.choices[0].message
    content = message.content[0].text if isinstance(message.content, list) else message.content
    intent = json.loads(content)

    return {"intent": intent, "raw_model_output": intent}
