// adapters/hermes.mjs — the Hermes source, exposed through the common adapter
// interface (see adapters/index.mjs and adapters/claude.mjs). Produces the exact
// COMMON VIZ SHAPE that parse-session.mjs emits, so every downstream viz module
// works unchanged.
//
// ============================================================================
//  SCHEMA STATUS: BUILT TO SPEC — UNVERIFIED AGAINST A LIVE DB.
//  Hermes is not installed on the machine this was authored on. The SQLite
//  schema below is transcribed from the official Hermes docs, not observed from
//  a real ~/.hermes/state.db, so column-name and role-value assumptions are
//  read defensively (multiple fallbacks per field). Re-validate every mapping
//  marked `needs-real-data` once a genuine store is available.
//
//  Canonical store (per docs): SQLite DB at ~/.hermes/state.db
//    table "sessions"  : id, source platform, user id, model name, title,
//                        system_prompt snapshot, token counts (input/output),
//                        parent_session_id (set on /compress children),
//                        timestamps (created/updated).
//    table "messages"  : session_id, role, content, tool_calls, tool_name(s),
//                        token_count, timestamps; plus a "messages_fts" FTS
//                        mirror we never read.
//  Deprecated fallback : legacy JSONL at ~/.hermes/sessions/*.jsonl, one
//                        OpenAI-ish object per line (created_at/role/content/
//                        tool_calls/tool_call_id).
//
//  Role -> viz kind mapping:
//    user                        -> user
//    assistant (text)            -> say
//    assistant (tool_calls)      -> tool_call  (+ tool_result on the reply)
//    tool / tool result          -> tool_result
//    reasoning                   -> thinking
//    per-message token_count &   -> ctx items + peakContext
//      session in/out totals
//    /compress child (parent_    -> compaction event at the lineage boundary
//      session_id present)
//
//  READ-ONLY w.r.t. ~/.hermes. state.db is opened with { readOnly: true } and
//  there is no read-write fallback: if the read-only open fails, openDb() logs
//  the reason and returns null, and the adapter degrades to the legacy JSONL
//  path (or throws a clear error) instead of escalating to a writable handle.
//  A read-write handle would itself mutate the store — creating -wal/-shm
//  sidecars, replaying a hot journal on open, checkpointing/removing the WAL on
//  close — with no write statement ever issued, so it is never opened.
//  Nothing in this adapter issues a write statement either.
// ============================================================================

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// node:sqlite is a built-in but experimental module (Node >= 22.5). Guard the
// import so a Node build without it — or with the flag disabled — degrades
// gracefully instead of throwing at import time. When it's null, the SQLite
// path is skipped and only the legacy-JSONL fallback (if present) is usable.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // no node:sqlite here — sqlite-backed discover/parse degrade to no-ops.
}

const HERMES_DIR = join(homedir(), '.hermes');
const DB_PATH = join(HERMES_DIR, 'state.db');
const LEGACY_DIR = join(HERMES_DIR, 'sessions');

// ---------------------------------------------------------------------------
// small shared helpers (mirrors the trimming/labeling in session-parser.mjs)
// ---------------------------------------------------------------------------

const clean = (s, n = 96) => {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

// Diagnostics. A malformed or unopenable store must never hang or throw here —
// it warns once and the caller degrades. CSPACE_QUIET silences it for suites.
function warn(msg) {
  if (!process.env.CSPACE_QUIET) console.warn(`hermes adapter: ${msg}`);
}

// Normalize a timestamp of unknown shape (ISO string, epoch seconds, or epoch
// millis) to epoch millis, or null when unparseable.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v >= 1e12) return v;         // already millis
    if (v >= 1e9) return v * 1000;   // epoch seconds
    return v;                        // small/relative — take as-is
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

// Coalesce over several possible column names (schema is unverified).
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] != null) return row[k];
  return undefined;
};

// Content may be a plain string or a JSON-encoded string (either a bare string,
// an OpenAI-style parts array [{type:'text',text}], or {text}). Return plain text.
function contentToText(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') {
    // already-structured (e.g. legacy JSONL parsed object)
    return structuredToText(raw);
  }
  const s = raw;
  const t = s.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try { return structuredToText(JSON.parse(t)); } catch { /* not JSON */ }
  }
  return s;
}

function structuredToText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
  }
  if (typeof v === 'object') return v.text ?? '';
  return String(v);
}

// tool_calls is a JSON-encoded array (OpenAI-ish). Each entry may be shaped
// {id, name, input} or {id, type, function:{name, arguments}}. Normalize.
function parseToolCalls(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try { arr = JSON.parse(t); } catch { return []; }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((c, i) => {
    const name = c?.name ?? c?.function?.name ?? c?.tool_name ?? '?';
    let args = c?.input ?? c?.arguments ?? c?.function?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* leave string */ } }
    const id = c?.id ?? c?.tool_call_id ?? `call_${i}`;
    return { id, name, args: args ?? {} };
  });
}

// Best-effort one-line label for a tool call, same field priority as the
// Claude/CLI parsers.
function labelForArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return clean(
    args.command ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.path ?? '',
    80,
  );
}

// ---------------------------------------------------------------------------
// core: build the COMMON VIZ SHAPE from an ordered list of normalized messages
// ---------------------------------------------------------------------------
//
// A "normalized message" is { role, text, toolCalls[], toolName, toolCallId,
// isError, tokens, ms }. Both the SQLite and legacy-JSONL paths produce these,
// so the assembly lives in one place.

function buildShape({ sessionId, model, msgs, parentSessionId, sessionInputTokens, sessionOutputTokens }) {
  const events = [];
  const contextCurve = [];
  const toolStats = new Map();
  const openToolCalls = new Map(); // tool_call id -> { name, t }

  let userTurns = 0, assistantTurns = 0, thinkingBlocks = 0;
  let cumTokens = 0;

  const stamped = msgs.filter((m) => m.ms != null);
  const t0 = stamped.length ? Math.min(...stamped.map((m) => m.ms)) : null;
  const tEnd = stamped.length ? Math.max(...stamped.map((m) => m.ms)) : null;
  const rel = (ms) => (t0 != null && ms != null ? (ms - t0) / 1000 : 0);
  let lastT = 0;

  // /compress lineage boundary: this session was born from a parent via
  // compression, so mark a compaction at its very start (best-effort — the true
  // boundary is between the parent's tail and this child's head). needs-real-data.
  if (parentSessionId) events.push({ t: 0, kind: 'compaction' });

  for (const m of msgs) {
    const t = m.ms != null ? rel(m.ms) : lastT;
    lastT = t;
    const role = String(m.role ?? '').toLowerCase();
    const tokens = Number(m.tokens) || 0;
    cumTokens += tokens;

    if (role === 'user') {
      const text = contentToText(m.text);
      userTurns++;
      events.push({ t, kind: 'user', chars: text.length, preview: clean(text) });
      continue;
    }

    if (role === 'reasoning' || role === 'thinking') {
      const text = contentToText(m.text);
      thinkingBlocks++;
      events.push({ t, kind: 'thinking', chars: text.length, side: false });
      // reasoning still consumes context
      contextCurve.push({ t, ctx: cumTokens, cacheRead: 0, cacheWrite: 0, fresh: tokens, out: tokens });
      continue;
    }

    if (role === 'assistant') {
      // context sample at each assistant turn (mirrors the Claude adapter's
      // one-ctx-per-assistant cadence). No cache accounting in Hermes -> 0/0.
      contextCurve.push({ t, ctx: cumTokens, cacheRead: 0, cacheWrite: 0, fresh: tokens, out: tokens });

      const text = contentToText(m.text);
      if (text) {
        assistantTurns++;
        events.push({ t, kind: 'say', chars: text.length, preview: clean(text), side: false });
      }
      const calls = m.toolCalls?.length ? m.toolCalls : parseToolCalls(m.rawToolCalls);
      for (const c of calls) {
        const st = toolStats.get(c.name) ?? { count: 0, errors: 0, chars: 0 };
        st.count++; toolStats.set(c.name, st);
        openToolCalls.set(c.id, { name: c.name, t });
        events.push({ t, kind: 'tool_call', tool: c.name, id: c.id, label: labelForArgs(c.args), side: false });
      }
      continue;
    }

    if (role === 'tool' || role === 'tool_result') {
      const text = contentToText(m.text);
      const id = m.toolCallId;
      const open = id != null ? openToolCalls.get(id) : undefined;
      const name = open?.name ?? m.toolName ?? 'tool';
      const st = toolStats.get(name) ?? { count: 0, errors: 0, chars: 0 };
      const chars = text.length;
      st.chars += chars;
      if (m.isError) st.errors++;
      if (!toolStats.has(name)) toolStats.set(name, st); // ensure a result with no prior call still registers
      events.push({
        t, kind: 'tool_result', tool: name, id: id ?? null, chars,
        err: !!m.isError, dur: open ? t - open.t : 0, side: false,
      });
      if (id != null) openToolCalls.delete(id);
      continue;
    }

    // unknown role: skip but keep timeline monotonic
  }

  events.sort((a, b) => a.t - b.t);

  const durS = t0 != null && tEnd != null ? (tEnd - t0) / 1000 : 0;
  const curvePeak = contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0);
  const totalsPeak = (Number(sessionInputTokens) || 0) + (Number(sessionOutputTokens) || 0);
  const peakContext = Math.max(curvePeak, totalsPeak);

  const tools = Object.fromEntries([...toolStats.entries()].sort((a, b) => b[1].count - a[1].count));
  const toolCalls = [...toolStats.values()].reduce((a, s) => a + s.count, 0);
  const compactions = events.filter((e) => e.kind === 'compaction').map((e) => ({ t: e.t }));

  return {
    meta: {
      sessionId,
      cwd: null,               // Hermes docs expose no working dir
      model: model ?? null,
      version: null,           // no harness-version field in the schema
      startedAt: t0 != null ? new Date(t0).toISOString() : null,
      durationS: Math.round(durS),
      userTurns, assistantTurns, thinkingBlocks,
      hookEvents: 0,           // Hermes has no hook concept
      toolCalls,
      peakContext,
    },
    tools,
    contextCurve,
    subagents: [],             // no subagent/spawn concept in the Hermes schema
    compactions,
    events,
  };
}

// ---------------------------------------------------------------------------
// SQLite path
// ---------------------------------------------------------------------------

// Open the Hermes store READ-ONLY, or return null. There is deliberately no
// read-write retry: a read-write SQLite handle mutates the store even with no
// write statement issued (it can create -wal/-shm sidecars, roll back a hot
// journal on open, and checkpoint/delete the WAL on close). A failed open
// therefore degrades to the legacy-JSONL path (or a clear throw in parse())
// rather than escalating to a writable handle.
function openDb(path = DB_PATH) {
  if (!DatabaseSync) return null;
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    warn(`read-only open of ${path} failed (${err?.message ?? err}); not retrying read-write — falling back to the legacy JSONL path`);
    return null;
  }
}

function allRows(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return null; }
}

function readMessages(db, sessionId) {
  // Prefer a rowid tiebreak for stable ordering; fall back if the table is
  // WITHOUT ROWID / FTS-backed and rowid isn't selectable.
  let rows = allRows(db,
    'SELECT rowid AS _rid, * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    sessionId);
  if (rows == null) {
    rows = allRows(db,
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
      sessionId) ?? [];
  }
  return rows.map((r) => normalizeDbMessage(r));
}

function normalizeDbMessage(r) {
  const isErrRaw = pick(r, 'is_error', 'error', 'is_err');
  return {
    role: pick(r, 'role'),
    text: pick(r, 'content', 'text', 'body'),
    rawToolCalls: pick(r, 'tool_calls', 'toolCalls'),
    toolName: pick(r, 'tool_name', 'tool_names', 'name'),
    toolCallId: pick(r, 'tool_call_id', 'tool_use_id', 'call_id'),
    isError: isErrRaw === 1 || isErrRaw === true || isErrRaw === '1' || isErrRaw === 'true',
    tokens: Number(pick(r, 'token_count', 'tokens', 'token_total') ?? 0) || 0,
    ms: toMs(pick(r, 'created_at', 'timestamp', 'ts', 'time', 'updated_at')),
  };
}

function sessionRow(db, sessionId) {
  const rows = allRows(db, 'SELECT * FROM sessions WHERE id = ? LIMIT 1', sessionId);
  return rows && rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// legacy JSONL path (deprecated fallback)
// ---------------------------------------------------------------------------

function parseLegacyJsonl(text) {
  const msgs = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    msgs.push({
      role: o.role,
      text: o.content,
      rawToolCalls: o.tool_calls,
      toolName: o.tool_name ?? o.name,
      toolCallId: o.tool_call_id ?? o.tool_use_id,
      isError: o.is_error === true,
      tokens: Number(o.token_count ?? o.tokens ?? 0) || 0,
      ms: toMs(o.created_at ?? o.timestamp ?? o.ts),
    });
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

const hermes = {
  id: 'hermes',
  label: 'Hermes',

  // Is Hermes's store present on THIS machine? True if the canonical DB exists,
  // or (deprecated) a legacy JSONL session dir is present.
  storeExists() {
    return existsSync(DB_PATH) || existsSync(LEGACY_DIR);
  },

  // List readable sessions, newest first-ish (index.mjs re-sorts by mtime).
  // SQLite is authoritative; legacy JSONL is only consulted when the DB is
  // absent (or node:sqlite is unavailable).
  discover() {
    if (existsSync(DB_PATH) && DatabaseSync) {
      const db = openDb();
      if (db) {
        try {
          const rows = allRows(db, 'SELECT * FROM sessions') ?? [];
          return rows.map((r) => {
            const id = pick(r, 'id', 'session_id');
            const inTok = Number(pick(r, 'input_tokens', 'token_count_input', 'tokens_input') ?? 0) || 0;
            const outTok = Number(pick(r, 'output_tokens', 'token_count_output', 'tokens_output') ?? 0) || 0;
            const updated = toMs(pick(r, 'updated_at', 'created_at', 'timestamp'));
            const title = pick(r, 'title');
            const platform = pick(r, 'source_platform', 'source', 'platform');
            return {
              id,
              source: 'hermes',
              project: clean(title ?? platform ?? 'hermes', 60) || 'hermes',
              ref: `hermes:${id}`,
              mtime: updated ?? 0,
              // rough byte estimate from token totals (~4 bytes/token); the docs
              // expose no on-disk per-session size. needs-real-data.
              sizeMB: +(((inTok + outTok) * 4) / (1024 * 1024)).toFixed(3),
              active: updated != null ? (Date.now() - updated) < 5 * 60 * 1000 : false,
            };
          }).filter((row) => row.id != null);
        } finally {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    }

    // legacy JSONL fallback
    if (existsSync(LEGACY_DIR)) {
      let files = [];
      try { files = readdirSync(LEGACY_DIR).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
      return files.map((f) => {
        const path = join(LEGACY_DIR, f);
        let st; try { st = statSync(path); } catch { st = null; }
        return {
          id: f.replace(/\.jsonl$/, ''),
          source: 'hermes',
          project: 'hermes',
          path,
          mtime: st ? st.mtimeMs : 0,
          sizeMB: st ? +(st.size / (1024 * 1024)).toFixed(3) : 0,
          active: false,
        };
      });
    }

    return [];
  },

  // Produce the COMMON VIZ SHAPE for one session.
  //   entry = a discover() row, or any { id, path?, db? }.
  //   - entry.db     : an open DatabaseSync to read from (used by the self-test
  //                    so it never touches ~/.hermes). Not closed here.
  //   - entry.path   : a legacy JSONL file to parse instead of the DB.
  //   - entry.id     : session id to query in the DB.
  parse(entry) {
    if (!entry) throw new Error('hermes.parse: entry is required');

    // legacy JSONL file
    if (entry.path && entry.path.endsWith('.jsonl')) {
      const text = readFileSync(entry.path, 'utf8');
      const msgs = parseLegacyJsonl(text);
      return buildShape({ sessionId: entry.id ?? entry.path, model: null, msgs });
    }

    // SQLite (either an injected db or the canonical store)
    const injected = !!entry.db;
    const db = entry.db ?? openDb();
    if (!db) {
      throw new Error('hermes.parse: no readable Hermes DB (node:sqlite unavailable or store missing)');
    }
    try {
      const id = entry.id;
      if (id == null) throw new Error('hermes.parse: entry.id is required for the SQLite path');
      const srow = sessionRow(db, id) ?? {};
      const msgs = readMessages(db, id);
      return buildShape({
        sessionId: id,
        model: pick(srow, 'model_name', 'model'),
        msgs,
        parentSessionId: pick(srow, 'parent_session_id', 'parent_id'),
        sessionInputTokens: pick(srow, 'input_tokens', 'token_count_input', 'tokens_input'),
        sessionOutputTokens: pick(srow, 'output_tokens', 'token_count_output', 'tokens_output'),
      });
    } finally {
      if (!injected) { try { db.close(); } catch { /* ignore */ } }
    }
  },
};

// Exposed for the test suite (tests/hermes.test.mjs) — lets it build a shape
// from an in-memory DB without going through the ~/.hermes store.
export const _internal = { buildShape, parseLegacyJsonl, toMs, parseToolCalls, contentToText, DatabaseSync };

export default hermes;
