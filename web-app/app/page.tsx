"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ---------- Types ----------

type Priority = "high" | "medium" | "low";
type TaskStatus = "pending" | "done";

type Task = {
  id: string;
  title: string;
  scheduledTime?: string;
  priority: Priority;
  status: TaskStatus;
};

type Target =
  | {
      mode: "by_index" | "by_match" | "all" | null;
      index?: number;
      match_query?: string;
    }
  | null;

type Intent = {
  operation: "create" | "delete" | "update" | "filter" | "noop";
  target: Target;
  data: {
    title?: string;
    scheduledTime?: string;
    priority?: Priority;
    status?: TaskStatus;
  };
};

type Filter = {
  priority?: Priority;
  search?: string;
} | null;

// ---------- Helpers ----------

function sortTasks(tasks: Task[]): Task[] {
  const order: Record<Priority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return [...tasks].sort((a, b) => {
    const diff = order[a.priority] - order[b.priority];
    if (diff !== 0) return diff;

    if (a.scheduledTime && b.scheduledTime)
      return a.scheduledTime.localeCompare(b.scheduledTime);

    if (a.scheduledTime && !b.scheduledTime) return -1;
    if (!a.scheduledTime && b.scheduledTime) return 1;

    return 0;
  });
}

function formatTime(iso?: string): string {
  if (!iso) return "Not scheduled";
  const [d, t] = iso.split("T");
  return `${d} ${t?.slice(0, 5)}`;
}

function normalizeIndex(rawIndex: number, tasks: Task[]): number | null {
  const n = tasks.length;
  if (n === 0) return null;

  if (rawIndex >= 1 && rawIndex <= n) return rawIndex - 1;

  const s = String(rawIndex);
  if (s.length > 1) {
    const firstDigit = parseInt(s[0], 10);
    if (firstDigit >= 1 && firstDigit <= n) return firstDigit - 1;
  }

  return null;
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\b[Cc]ars?\s+(\d+)\b/g, "task $1");
}

function matchesTitleFuzzy(title: string, query: string): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return false;

  const parts = q.split(" ").filter(Boolean);
  return parts.some((w) => t.includes(w));
}

function getVisibleTasks(tasks: Task[], filter: Filter): Task[] {
  let result = [...tasks];
  if (filter?.priority) result = result.filter((t) => t.priority === filter.priority);
  return sortTasks(result);
}

// ---------- CRUD helpers ----------

function applyIntent(tasks: Task[], intent: Intent): Task[] {
  switch (intent.operation) {
    case "create":
      return [
        ...tasks,
        {
          id: crypto.randomUUID(),
          title: intent.data.title ?? "Untitled task",
          scheduledTime: intent.data.scheduledTime,
          priority: intent.data.priority ?? "low",
          status: intent.data.status ?? "pending",
        },
      ];

    case "delete":
      return deleteByTarget(tasks, intent.target);

    case "update":
      return updateByTarget(tasks, intent.target, intent.data);

    default:
      return tasks;
  }
}

function deleteByTarget(tasks: Task[], target: Target): Task[] {
  if (!target) return tasks;

  if (target.mode === "by_index" && target.index != null) {
    const idx = normalizeIndex(target.index, tasks);
    if (idx == null) return tasks;
    return tasks.filter((_, i) => i !== idx);
  }

  if (target.mode === "by_match" && target.match_query) {
    return tasks.filter((t) => !matchesTitleFuzzy(t.title, target.match_query!));
  }

  if (target.mode === "all") return [];

  return tasks;
}

function updateByTarget(tasks: Task[], target: Target, data: Intent["data"]): Task[] {
  if (!target) return tasks;

  const apply = (t: Task): Task => ({
    ...t,
    title: data.title ?? t.title,
    scheduledTime: data.scheduledTime ?? t.scheduledTime,
    priority: data.priority ?? t.priority,
    status: data.status ?? t.status,
  });

  if (target.mode === "by_index" && target.index != null) {
    const idx = normalizeIndex(target.index, tasks);
    if (idx == null) return tasks;
    return tasks.map((t, i) => (i === idx ? apply(t) : t));
  }

  if (target.mode === "by_match" && target.match_query) {
    let done = false;
    return tasks.map((t) => {
      if (!done && matchesTitleFuzzy(t.title, target.match_query!)) {
        done = true;
        return apply(t);
      }
      return t;
    });
  }

  return tasks;
}

// ---------- Remapping ----------

function remapIntentForUI(intent: Intent, tasks: Task[], filter: Filter): Intent {
  if (!intent.target || intent.target.mode !== "by_index") return intent;
  if (intent.target.index == null) return intent;

  const visible = getVisibleTasks(tasks, filter);
  const uiIndex = intent.target.index - 1;

  if (uiIndex < 0 || uiIndex >= visible.length) return { ...intent, operation: "noop" };

  const taskId = visible[uiIndex].id;
  const actualIndex = tasks.findIndex((t) => t.id === taskId);
  if (actualIndex === -1) return intent;

  return {
    ...intent,
    target: {
      ...intent.target,
      index: actualIndex + 1,
    },
  };
}

// ---------- Component ----------

export default function HomePage() {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

  const [tasks, setTasks] = useState<Task[]>([
    {
      id: "1",
      title: "Fix payment gateway bug",
      scheduledTime: "2025-11-16T10:00:00Z",
      priority: "high",
      status: "pending",
    },
    {
      id: "2",
      title: "File quarterly compliances",
      scheduledTime: "2025-11-17T09:00:00Z",
      priority: "medium",
      status: "pending",
    },
    {
      id: "3",
      title: "Clean up analytics dashboard",
      priority: "low",
      status: "done",
    },
  ]);

  const [filter, setFilter] = useState<Filter>(null);
  const [lastHeardText, setLastHeardText] = useState<string | null>(null);
  const [lastActionSummary, setLastActionSummary] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  const recognitionRef = useRef<any>(null);

  // ---------- Hotkey toggle ----------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        listening ? stopListening() : startListening();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [listening]);

  // ---------- SpeechRecognition ----------

  useEffect(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SR) {
      setSpeechSupported(false);
      return;
    }

    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;

    rec.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          processTranscript(event.results[i][0].transcript.trim());
        }
      }
    };

    rec.onerror = () => {
      try {
        rec.stop();
      } catch {}
      setListening(false);
    };

    recognitionRef.current = rec;
  }, []);

  function startListening() {
    recognitionRef.current?.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  async function sendToPython(text: string) {
    setLastHeardText(text);
    setLastActionSummary("Processing...");

    try {
      const res = await fetch(`${API_BASE}/parse-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      const data = await res.json();
      const rawIntent: Intent = data.intent;

      setTasks((prev) => {
        const resolved = remapIntentForUI(rawIntent, prev, filter);
        return applyIntent(prev, resolved);
      });

      setLastActionSummary(`AI action: ${rawIntent.operation}`);
    } catch (err) {
      setLastActionSummary("Backend error");
    }
  }

  function processTranscript(text: string) {
    const cleaned = normalizeTranscriptText(text);
    stopListening();
    sendToPython(cleaned);
    setLastHeardText(text);
  }

  const visibleTasks = useMemo(() => getVisibleTasks(tasks, filter), [tasks, filter]);

  const currentPriorityFilter = filter?.priority ?? null;

  // ---------- UI ----------

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-50">
      {/* content omitted for brevity — same UI layout as before */}
    </div>
  );
}
