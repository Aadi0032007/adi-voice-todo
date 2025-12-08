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

type Intent = {
  operation: "create" | "update" | "delete" | "noop";
  target: {
    mode: "by_id" | null;
    task_id: string | null;
  } | null;
  data: {
    title?: string | null;
    scheduledTime?: string | null;
    priority?: Priority | null;
    status?: TaskStatus | null;
  };
};

type Filter = { priority?: Priority } | null;

// ---------- Helpers ----------

function sortTasks(tasks: Task[]): Task[] {
  const priorityOrder: Record<Priority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return [...tasks].sort((a, b) => {
    const diff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (diff !== 0) return diff;

    if (a.scheduledTime && b.scheduledTime)
      return a.scheduledTime.localeCompare(b.scheduledTime);

    if (a.scheduledTime && !b.scheduledTime) return -1;
    if (!a.scheduledTime && b.scheduledTime) return 1;

    return 0;
  });
}

function formatTime(iso?: string) {
  if (!iso) return "Not scheduled";
  const [d, t] = iso.split("T");
  return `${d} ${t?.slice(0, 5)}`;
}

function normalizeTranscriptText(text: string): string {
  // "cars 2" → "task 2"
  return text.replace(/\b[Cc]ars?\s+(\d+)\b/g, "task $1");
}

// ---------- Intent Application ----------

function applySafeIntent(tasks: Task[], intent: Intent): Task[] {
  switch (intent.operation) {
    case "create":
      return [
        ...tasks,
        {
          id: crypto.randomUUID(),
          title: intent.data.title ?? "Untitled task",
          scheduledTime: intent.data.scheduledTime ?? undefined,
          priority: intent.data.priority ?? "low",
          status: intent.data.status ?? "pending",
        },
      ];

    case "delete": {
      const tid = intent.target?.task_id;
      if (!tid) return tasks;
      return tasks.filter((t) => t.id !== tid);
    }

    case "update": {
      const tid = intent.target?.task_id;
      if (!tid) return tasks;

      return tasks.map((t) =>
        t.id === tid
          ? {
              ...t,
              title: intent.data.title ?? t.title,
              scheduledTime: intent.data.scheduledTime ?? t.scheduledTime,
              priority: intent.data.priority ?? t.priority,
              status: intent.data.status ?? t.status,
            }
          : t
      );
    }

    default:
      return tasks;
  }
}

// ---------- API Base ----------

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

  // Space toggles listening
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

  // Setup browser speech recognition
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
        body: JSON.stringify({
          text,
          tasks,
        }),
      });

      const data = await res.json();
      const intent: Intent = data.intent;

      if (!intent || intent.operation === "noop") {
        setLastActionSummary("No action (unclear)");
        return;
      }

      setTasks((prev) => applySafeIntent(prev, intent));
      setLastActionSummary(`Action: ${intent.operation}`);
    } catch (err) {
      console.error(err);
      setLastActionSummary("Backend error");
    }
  }

  function processTranscript(text: string) {
    const cleaned = normalizeTranscriptText(text);

    stopListening();
    sendToPython(cleaned);

    setLastHeardText(text);
  }

  const visibleTasks = useMemo(() => {
    let result = [...tasks];
    if (filter?.priority) {
      result = result.filter((t) => t.priority === filter.priority);
    }
    return sortTasks(result);
  }, [tasks, filter]);

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
                  Speech Recognition not supported. Use Chrome.
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

          {/* Last command */}
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

          {/* Tasks table */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">Tasks</h2>

              <div className="flex gap-2 text-xs">
                <button
                  onClick={() => setFilter(null)}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === null
                      ? "bg-slate-100 text-slate-900"
                      : "border-slate-600 text-slate-300"
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setFilter({ priority: "high" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "high"
                      ? "bg-red-500 text-white"
                      : "border-slate-600 text-slate-300"
                  }`}
                >
                  High
                </button>
                <button
                  onClick={() => setFilter({ priority: "medium" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "medium"
                      ? "bg-amber-400 text-black"
                      : "border-slate-600 text-slate-300"
                  }`}
                >
                  Medium
                </button>
                <button
                  onClick={() => setFilter({ priority: "low" })}
                  className={`rounded-full px-3 py-1 border ${
                    currentPriorityFilter === "low"
                      ? "bg-emerald-500 text-black"
                      : "border-slate-600 text-slate-300"
                  }`}
                >
                  Low
                </button>
              </div>
            </div>

            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 text-left text-xs text-slate-400">#</th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">Title</th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">Scheduled</th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">Priority</th>
                  <th className="px-3 py-2 text-left text-xs text-slate-400">Status</th>
                </tr>
              </thead>

              <tbody>
                {visibleTasks.map((t, i) => (
                  <tr key={t.id} className="border-b border-slate-800">
                    <td className="px-3 py-2 text-xs text-slate-500">{i + 1}</td>
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
