import { useEffect, useState } from "react";
import {
  ingestText,
  searchNotes,
  buildContext,
  getNote,
  setAuthTokenGetter,
} from "@workspace/api-client-react";

type Pane = "ingest" | "search" | "context" | "note";

const API_KEY_STORAGE_KEY = "memory.inspector.apiKey";

function readStoredKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

let currentKey = readStoredKey();
setAuthTokenGetter(() => currentKey || null);

function setApiKey(value: string) {
  currentKey = value;
  try {
    if (value) {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function ApiKeyBar() {
  const [value, setValue] = useState<string>(() => readStoredKey());
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setApiKey(value);
  }, [value]);

  return (
    <div className="flex gap-2 items-center mb-3">
      <label className="text-xs font-mono text-neutral-600 shrink-0">
        API key
      </label>
      <input
        type={revealed ? "text" : "password"}
        className="flex-1 border border-neutral-300 px-2 py-1 text-sm font-mono"
        placeholder="MEMORY_API_KEY (sent as Bearer token)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="text-xs font-mono border border-neutral-300 px-2 py-1 hover:border-neutral-500"
      >
        {revealed ? "hide" : "show"}
      </button>
      <button
        type="button"
        onClick={() => setValue("")}
        className="text-xs font-mono border border-neutral-300 px-2 py-1 hover:border-neutral-500"
      >
        clear
      </button>
    </div>
  );
}

function Section({
  id,
  title,
  active,
  onClick,
}: {
  id: Pane;
  title: string;
  active: Pane;
  onClick: (p: Pane) => void;
}) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`px-3 py-1.5 text-sm border rounded-sm font-mono ${
        active === id
          ? "bg-black text-white border-black"
          : "bg-white text-black border-neutral-300 hover:border-neutral-500"
      }`}
    >
      {title}
    </button>
  );
}

function JsonOut({ value }: { value: unknown }) {
  return (
    <pre className="text-xs bg-neutral-50 border border-neutral-200 rounded-sm p-3 overflow-auto whitespace-pre-wrap break-words max-h-[60vh]">
      {value === undefined ? "" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function IngestPanel() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [author, setAuthor] = useState("");
  const [out, setOut] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setErr(null);
    try {
      const res = await ingestText({
        text,
        source: source || null,
        author: author || null,
      });
      setOut(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          className="border border-neutral-300 px-2 py-1 text-sm font-mono"
          placeholder="source (optional)"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <input
          className="border border-neutral-300 px-2 py-1 text-sm font-mono"
          placeholder="author (optional)"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
      </div>
      <textarea
        className="w-full border border-neutral-300 px-2 py-1 text-sm font-mono h-40"
        placeholder="Paste raw text to ingest..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        onClick={submit}
        disabled={loading || !text.trim()}
        className="bg-black text-white text-sm px-3 py-1.5 disabled:opacity-50 font-mono"
      >
        {loading ? "ingesting..." : "POST /api/ingest/text"}
      </button>
      {err && <div className="text-xs text-red-600 font-mono">{err}</div>}
      <JsonOut value={out} />
    </div>
  );
}

function SearchPanel() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(10);
  const [out, setOut] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setErr(null);
    try {
      const res = await searchNotes({ query, limit });
      setOut(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          className="flex-1 border border-neutral-300 px-2 py-1 text-sm font-mono"
          placeholder="query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          type="number"
          className="w-20 border border-neutral-300 px-2 py-1 text-sm font-mono"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value) || 10)}
        />
        <button
          onClick={submit}
          disabled={loading || !query.trim()}
          className="bg-black text-white text-sm px-3 py-1.5 disabled:opacity-50 font-mono"
        >
          {loading ? "..." : "POST /api/search"}
        </button>
      </div>
      {err && <div className="text-xs text-red-600 font-mono">{err}</div>}
      <JsonOut value={out} />
    </div>
  );
}

function ContextPanel() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const [synthesize, setSynthesize] = useState(false);
  const [out, setOut] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setErr(null);
    try {
      const res = await buildContext({ query, limit, synthesize });
      setOut(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input
          className="flex-1 border border-neutral-300 px-2 py-1 text-sm font-mono"
          placeholder="query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          type="number"
          className="w-20 border border-neutral-300 px-2 py-1 text-sm font-mono"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value) || 8)}
        />
        <label className="text-xs font-mono flex items-center gap-1">
          <input
            type="checkbox"
            checked={synthesize}
            onChange={(e) => setSynthesize(e.target.checked)}
          />
          synthesize
        </label>
        <button
          onClick={submit}
          disabled={loading || !query.trim()}
          className="bg-black text-white text-sm px-3 py-1.5 disabled:opacity-50 font-mono"
        >
          {loading ? "..." : "POST /api/context/build"}
        </button>
      </div>
      {err && <div className="text-xs text-red-600 font-mono">{err}</div>}
      <JsonOut value={out} />
    </div>
  );
}

function NotePanel() {
  const [id, setId] = useState("");
  const [out, setOut] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setErr(null);
    try {
      const res = await getNote(id);
      setOut(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          className="flex-1 border border-neutral-300 px-2 py-1 text-sm font-mono"
          placeholder="note uuid"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <button
          onClick={submit}
          disabled={loading || !id.trim()}
          className="bg-black text-white text-sm px-3 py-1.5 disabled:opacity-50 font-mono"
        >
          {loading ? "..." : "GET /api/notes/:id"}
        </button>
      </div>
      {err && <div className="text-xs text-red-600 font-mono">{err}</div>}
      <JsonOut value={out} />
    </div>
  );
}

function App() {
  const [active, setActive] = useState<Pane>("ingest");
  return (
    <div className="min-h-screen bg-white text-black p-4 max-w-5xl mx-auto font-sans">
      <header className="mb-4 border-b border-neutral-300 pb-3">
        <h1 className="text-xl font-bold font-mono">memory inspector</h1>
        <p className="text-xs text-neutral-500 font-mono">
          test panel for the memory subsystem &mdash; raw JSON in, raw JSON out
        </p>
      </header>
      <ApiKeyBar />
      <nav className="flex gap-2 mb-4 flex-wrap">
        <Section id="ingest" title="1. ingest" active={active} onClick={setActive} />
        <Section id="search" title="2. search" active={active} onClick={setActive} />
        <Section id="context" title="3. context" active={active} onClick={setActive} />
        <Section id="note" title="4. note" active={active} onClick={setActive} />
      </nav>
      {active === "ingest" && <IngestPanel />}
      {active === "search" && <SearchPanel />}
      {active === "context" && <ContextPanel />}
      {active === "note" && <NotePanel />}
    </div>
  );
}

export default App;
