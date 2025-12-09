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
  const priorityOrder: Record<Priority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return [...tasks].sort((a, b) => {
    const prioDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (prioDiff !== 0) return prioDiff;

    if (a.scheduledTime && b.scheduledTime)
      return a.scheduledTime.localeCompare(b.scheduledTime);

    if (a.scheduledTime && !b.scheduledTime) return -1;
    if (!a.scheduledTime && b.scheduledTime) return 1;

    return 0;
  });
}

function formatTime(iso?: string): string {
  if (!iso) return "Not scheduled";
  const [datePart, timePart] = iso.split("T");
  return `${datePart} ${timePart?.slice(0, 5)}`;
}

/** normalize numeric index from model to 0-based array index */
function normalizeIndex(rawIndex: number, tasks: Task[]): number | null {
  const n = tasks.length;
  if (n === 0) return null;

  if (rawIndex >= 1 && rawIndex <= n) return rawIndex - 1;

  const s = String(rawIndex);
  if (s.length > 1) {
    const firstDigit = parseInt(s[0], 10);
    if (firstDigit >= 1 && firstDigit <= n) {
      return firstDigit - 1;
    }
  }

  return null;
}

/** Fix misheard "cars 2" → "task 2" */
function normalizeTranscriptText(text: string): string {
  return text.replace(/\b[Cc]ars?\s+(\d+)\b/g, "task $1");
}

/** Fuzzy title matching for "delete the payment bug task" etc. */
function matchesTitleFuzzy(title: string, query: string): boolean {
  const normalizedTitle = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return false;

  const words = q.split(" ").filter(Boolean);
  return words.some((w) => normalizedTitle.includes(w));
}

/** Visible tasks (what the user sees) = filtered + sorted */
function getVisibleTasks(tasks: Task[], filter: Filter): Task[] {
  let result = [...tasks];
  if (filter?.priority) {
    result = result.filter((t) => t.priority === filter.priority);
  }
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
          priority: intent.data.priority ?? "low", // default low
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
    const q = target.match_query;
    if (!q.trim()) return tasks;

    return tasks.filter((t) => !matchesTitleFuzzy(t.title, q));
  }

  if (target.mode === "all") return [];

  return tasks;
}

function updateByTarget(
  tasks: Task[],
  target: Target,
  data: Intent["data"]
): Task[] {
  if (!target) return tasks;

  const applyUpdate = (t: Task): Task => ({
    ...t,
    title: data.title ?? t.title,
    scheduledTime: data.scheduledTime ?? t.scheduledTime,
    priority: data.priority ?? t.priority,
    status: data.status ?? t.status,
  });

  if (target.mode === "by_index" && target.index != null) {
    const idx = normalizeIndex(target.index, tasks);
    if (idx == null) return tasks;
    return tasks.map((t, i) => (i === idx ? applyUpdate(t) : t));
  }

  if (target.mode === "by_match" && target.match_query) {
    const q = target.match_query;
    if (!q.trim()) return tasks;

    let changed = false;
    return tasks.map((t) => {
      if (!changed && matchesTitleFuzzy(t.title, q)) {
        changed = true;
        return applyUpdate(t);
      }
      return t;
    });
  }

  return tasks;
}

// ---------- Remap index so "task 1" refers to visible row 1 ----------

function remapIntentForUI(intent: Intent, tasks: Task[], filter: Filter): Intent {
  if (!intent.target || intent.target.mode !== "by_index") return intent;
  if (intent.target.index == null) return intent;

  const visible = getVisibleTasks(tasks, filter);
  const uiIndex = intent.target.index - 1; // 1-based to 0-based

  if (uiIndex < 0 || uiIndex >= visible.length) {
    console.warn("UI index out of range:", intent.target.index);
    return { ...intent, operation: "noop" };
  }

  const taskId = visible[uiIndex].id;
  const realIndex = tasks.findIndex((t) => t.id === taskId);
  if (realIndex === -1) {
    console.warn("Could not map visible index to real task index");
    return intent;
  }

  return {
    ...intent,
    target: {
      ...intent.target,
      index: realIndex + 1, // back to 1-based for normalizeIndex()
    },
  };
}

// ---------- API BASE ----------

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

// ---------- Component ----------

export default function HomePage() {
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
      scheduledTime: undefined,
      priority: "low",
      status: "done",
    },
  ]);

  const [filter, setFilter] = useState<Filter>(null);
  const [lastHeardText, setLastHeardText] = useState<string | null>(null);
  const [lastActionSummary, setLastActionSummary] =
    useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  const recognitionRef = useRef<any>(null);

  // Toggle with spacebar
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

  // Setup SpeechRecognition
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
          const text = event.results[i][0].transcript.trim();
          processTranscript(text);
        }
      }
    };

    rec.onerror = (event: any) => {
      console.warn("SpeechRecognition error:", event?.error || event);
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      setListening(false);
    };

    rec.onend = () => {
      // no auto-restart; user presses Space again
    };

    recognitionRef.current = rec;
  }, []);

  function startListening() {
    if (!speechSupported) return;
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
        // remap "task 1/2/3" to the row the user actually sees
        const resolvedIntent = remapIntentForUI(rawIntent, prev, filter);
        return applyIntent(prev, resolvedIntent);
      });

      setLastActionSummary(`AI action: ${rawIntent.operation}`);
    } catch (e) {
      console.warn(e);
      setLastActionSummary("Backend error");
    }
  }

  function processTranscript(text: string) {
    console.log("Heard (raw):", text);
    const cleaned = normalizeTranscriptText(text);
    console.log("Normalized for AI:", cleaned);

    stopListening();
    sendToPython(cleaned);

    setLastHeardText(text);
  }

  const visibleTasks = useMemo(
    () => getVisibleTasks(tasks, filter),
    [tasks, filter]
  );

  const currentPriorityFilter = filter?.priority ?? null;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-50">
      <main className="flex-grow">
        <div className="mx-auto max-w-4xl px-4 py-8">
          <header className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">A.D.I To-Do Lists</h1>
              <p className="text-sm text-slate-400">
                Press <span className="font-mono">Space</span> to start/stop
                listening.
              </p>
              {!speechSupported && (
                <p className="text-xs text-red-400 mt-1">
                  Speech recognition not supported in this browser. Try Chrome
                  or Edge.
                </p>
              )}
            </div>

            <button
              onClick={() => (listening ? stopListening() : startListening())}
              className={`rounded-full px-4 py-2 text-sm font-medium ${
                listening ? "bg-red-500" : "bg-emerald-500 text-slate-900"
              }`}
            >
              {listening ? "Listening..." : "Start Listening"}
            </button>
          </header>

          {/* Last command card */}
          <section className="mb-6 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <h2 className="text-sm font-semibold text-slate-300 mb-2">
              Last command
            </h2>
            <p className="text-slate-400">
              Heard:{" "}
              <span className="text-slate-100">
                {lastHeardText ?? "None"}
              </span>
            </p>
            <p className="text-slate-400">
              Action:{" "}
              <span className="text-emerald-400">
                {lastActionSummary ?? "—"}
              </span>
            </p>
          </section>

          {/* Tasks */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-slate-300">Tasks</h2>

              {/* Priority filter buttons */}
              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setFilter(null)}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === null
                      ? "bg-slate-100 text-slate-900 border-slate-100"
                      : "border-slate-600 text-slate-300 hover:border-slate-300"
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setFilter({ priority: "high" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "high"
                      ? "bg-red-500 text-slate-50 border-red-500"
                      : "border-slate-600 text-slate-300 hover-border-slate-300"
                  }`}
                >
                  High
                </button>
                <button
                  onClick={() => setFilter({ priority: "medium" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "medium"
                      ? "bg-amber-400 text-slate-900 border-amber-400"
                      : "border-slate-600 text-slate-300 hover-border-slate-300"
                  }`}
                >
                  Medium
                </button>
                <button
                  onClick={() => setFilter({ priority: "low" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "low"
                      ? "bg-emerald-500 text-slate-900 border-emerald-500"
                      : "border-slate-600 text-slate-300 hover-border-slate-300"
                  }`}
                >
                  Low
                </button>
              </div>
            </div>

            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 text-left text-xs text-slate-400">
                    #
                  </th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">
                    Scheduled
                  </th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">
                    Priority
                  </th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((t, i) => (
                  <tr key={t.id} className="border-b border-slate-800">
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {i + 1}
                    </td>
                    <td className="px-3 py-2">{t.title}</td>
                    <td className="px-3 py-2">{formatTime(t.scheduledTime)}</td>
                    <td className="px-3 py-2 capitalize">{t.priority}</td>
                    <td className="px-3 py-2 capitalize">{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>

      <footer className="mt-auto text-center text-gray-400 text-sm border-t border-slate-800 py-4">
        <p>
          Created by <strong>Aditya Raj (aadi0032007)</strong>
        </p>
        <p>
          Email:{" "}
          <a href="mailto:ms.adityaraj@gmail.com" className="text-blue-400">
            ms.adityaraj@gmail.com
          </a>
        </p>
        <p>
          Contact:{" "}
          <a href="tel:+917543037822" className="text-blue-400">
            +91-7543037822
          </a>
        </p>
      </footer>
    </div>
  );
}