// adapters/openclaw.mjs — the OpenClaw source, exposed through the common
// adapter interface (see adapters/index.mjs, adapters/claude.mjs). Produces the
// exact COMMON VIZ SHAPE that parse-session.mjs / session-parser.mjs emit, so
// every downstream viz module works unchanged.
//
// ============================================================================
//  SCHEMA STATUS: BUILT TO SPEC — UNVERIFIED AGAINST A LIVE INSTALL.
//  OpenClaw is not installed on the machine this was authored on (2026-08-12).
//  Everything below is transcribed from the official docs —
//    https://docs.openclaw.ai/reference/session-management-compaction
//  — not observed from a real ~/.openclaw. The docs describe the *persistence
//  model* (fields, entry types, the tree) but NOT the physical SQL table or
//  column names, so this adapter:
//    · locates its tables by probing sqlite_master (name heuristics), and
//    · reads every field through a coalescing view that accepts the documented
//      camelCase name, a snake_case variant, and a JSON-blob body column.
//  Mappings marked `needs-real-data` are the guesses to re-validate first once
//  a genuine store exists. Nothing is invented: where OpenClaw records no data
//  (subagents, hooks, harness version) the output is empty/null, not faked.
//
//  STORE LAYOUT (per docs) — note the per-AGENT level; a Gateway host can hold
//  many agents, and every one of them has its own store:
//    ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite   canonical
//    ~/.openclaw/agents/<agentId>/sessions/*.jsonl              legacy transcripts
//    ~/.openclaw/agents/<agentId>/sessions/sessions.json        legacy index
//
//  The SQLite DB holds TWO persistence layers:
//   (1) SESSION ROWS — a mutable key/value store, sessionKey -> SessionEntry:
//       sessionId (id of the CURRENT transcript), sessionStartedAt,
//       lastInteractionAt (real user activity; excludes heartbeat/cron),
//       updatedAt, archivedAt?, pinnedAt?, token counters inputTokens /
//       outputTokens / totalTokens / contextTokens (all "best-effort reporting
//       values" per the docs), compactionCount, memoryFlushAt,
//       memoryFlushCompactionCount.
//   (2) TRANSCRIPT EVENTS — an APPEND-ONLY TREE. Every entry has id + parentId.
//       Entry types: session | message | custom_message | custom | compaction
//       (+ branch_summary, which the docs list as branch-navigation metadata).
//
//  MAPPING to the common vocabulary:
//    session header      -> meta.cwd, meta.startedAt; parentSession -> meta.parentSession (lineage)
//    message user        -> 'user'
//    assistant text      -> 'say'
//    assistant reasoning -> 'thinking'
//    assistant tool call -> 'tool_call' (tool name + one-line args preview)
//    toolResult          -> 'tool_result' (paired to its call; error flag + result chars)
//    compaction          -> a ctx point at tokensBefore, then a 'compaction' event
//    contextTokens etc.  -> contextCurve tail sample + meta.peakContext
//    custom_message      -> 'say' ONLY when it actually carries text (it enters model context)
//    custom              -> SKIPPED (docs: persists WITHOUT model visibility)
//    branch_summary      -> SKIPPED (metadata about branch navigation, not turn content)
//    compactionCount     -> sanity-checked against the compaction events found; warns on mismatch
//    memoryFlushAt / memoryFlushCompactionCount -> intentionally unmapped (no viz vocabulary for them)
//
//  WHY compaction is special here: `tokensBefore` states the context size
//  IMMEDIATELY BEFORE the collapse. That is a measured number, not an inference
//  — so we emit a contextCurve point at tokensBefore at the compaction's own
//  timestamp, and the tower then collapses by the TRUE amount. (Claude sessions
//  can only approximate this from the last pre-compaction usage sample.)
//
//  READ-ONLY w.r.t. ~/.openclaw, and never writes transcript content anywhere.
//  Each agent's SQLite store is opened with { readOnly: true } and there is no
//  read-write fallback: if the read-only open fails, openDb() logs the reason
//  and returns null, and the adapter degrades to that agent's legacy JSONL rows
//  (or throws a clear error) instead of escalating to a writable handle. A
//  read-write handle would itself mutate the store — creating -wal/-shm
//  sidecars, replaying a hot journal on open, checkpointing/removing the WAL on
//  close — with no write statement ever issued, so it is never opened. Nothing
//  in this adapter issues a write statement either.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// node:sqlite is a built-in but experimental module (Node >= 22.5). Guard the
// import so a Node build without it — or with the flag disabled — degrades
// gracefully instead of throwing at import time. When it's null the SQLite path
// is skipped entirely and only the legacy-JSONL fallback remains usable.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // no node:sqlite here — sqlite-backed discover/parse degrade to no-ops.
}

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const AGENTS_DIR = join(OPENCLAW_DIR, 'agents');
const DB_BASENAME = 'openclaw-agent.sqlite';
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // lastInteractionAt this recent => "live"

// ---------------------------------------------------------------------------
// small shared helpers (mirror the trimming/labelling in session-parser.mjs)
// ---------------------------------------------------------------------------

const clean = (s, n = 96) => {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Normalize a timestamp of unknown shape (ISO / epoch s / epoch ms) to ms. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v >= 1e12) return v;        // already millis
    if (v >= 1e9) return v * 1000;  // epoch seconds
    return v;                       // small/relative — take as-is
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

/** First non-null value across several candidate keys (schema is unverified). */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] != null) return obj[k];
  return undefined;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Diagnostics. Malformed stores must never hang or throw — they warn and skip.
 * When a `sink` array is supplied (tests, callers that want to inspect) the
 * message is collected instead of printed, so suites stay quiet.
 */
function warn(msg, sink) {
  if (Array.isArray(sink)) { sink.push(msg); return; }
  if (!process.env.CSPACE_QUIET) console.warn(`openclaw adapter: ${msg}`);
}

/**
 * A coalescing accessor over "the entry as JSON body" + "the entry as SQL
 * columns". OpenClaw's physical schema is unknown, so a transcript row might be
 * (id, parentId, type, data JSON) or fully exploded into columns — this reads
 * both, JSON body first.
 */
function viewOf(body, row) {
  return (...keys) => pick(body, ...keys) ?? pick(row, ...keys);
}

/** Parse a value that may be a JSON string, an object, or absent. */
function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  return null;
}

/** Content may be a string, a JSON-encoded string, a block array, or an object. */
function contentBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') {
    const t = content.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      const parsed = asObject(t);
      if (parsed) return contentBlocks(parsed);
    }
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c))
      .filter((c) => c && typeof c === 'object');
  }
  if (typeof content === 'object') return [content];
  return [];
}

const blockText = (b) => {
  const v = b?.text ?? b?.thinking ?? b?.reasoning ?? b?.summary ?? b?.content;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('');
  return '';
};

const TEXT_BLOCK = /^(text|output_text|say)$/i;
const THINK_BLOCK = /^(thinking|reasoning|redacted_thinking|thought)$/i;
const CALL_BLOCK = /^(tool_use|toolUse|tool_call|toolCall|function_call)$/i;

/** Normalize one assistant tool-call block / toolCalls[] item. */
function normalizeCall(c, i) {
  const name = c?.name ?? c?.toolName ?? c?.tool_name ?? c?.function?.name ?? '?';
  let args = c?.input ?? c?.args ?? c?.arguments ?? c?.function?.arguments ?? c?.parameters;
  if (typeof args === 'string') {
    const parsed = asObject(args);
    args = parsed ?? args;
  }
  const id = c?.id ?? c?.toolCallId ?? c?.tool_call_id ?? c?.callId ?? c?.call_id ?? `call_${i}`;
  return { id, name: String(name), args: args ?? {} };
}

/** One-line label for a tool call — same field priority as the other adapters. */
function labelForArgs(args) {
  if (typeof args === 'string') return clean(args, 80);
  if (!args || typeof args !== 'object') return '';
  const v = args.command ?? args.cmd ?? args.file_path ?? args.filePath ?? args.pattern ??
            args.query ?? args.url ?? args.path ?? args.prompt ?? '';
  if (Array.isArray(v)) return clean(v.join(' '), 80);
  return clean(typeof v === 'string' ? v : '', 80);
}

// ---------------------------------------------------------------------------
// synchronous streaming line reader (same technique as adapters/codex.mjs:
// transcripts can embed base64 attachments and exceed Node's max string length,
// so never slurp the file — read byte chunks and split on LF at the byte level.
// A multibyte UTF-8 char never straddles a newline, so per-line toString is safe.)
// ---------------------------------------------------------------------------
function forEachLineSync(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20); // 1 MiB
    let leftover = Buffer.alloc(0);
    let bytes;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const data = leftover.length
        ? Buffer.concat([leftover, chunk.subarray(0, bytes)])
        : Buffer.from(chunk.subarray(0, bytes)); // copy: chunk is reused
      let start = 0, nl;
      while ((nl = data.indexOf(0x0a, start)) !== -1) {
        let end = nl;
        if (end > start && data[end - 1] === 0x0d) end--; // strip CR
        if (end > start) onLine(data.toString('utf8', start, end));
        start = nl + 1;
      }
      leftover = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
    if (leftover.length) {
      let end = leftover.length;
      if (end > 0 && leftover[end - 1] === 0x0d) end--;
      if (end > 0) onLine(leftover.toString('utf8', 0, end));
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// entry normalization
// ---------------------------------------------------------------------------
//
// A "normalized entry" is the adapter's internal, storage-agnostic node:
//   { id, parentId, type, ms, sessionId, seq, get }
// where get() is the coalescing view over the entry's JSON body + SQL columns.
// Both the SQLite and legacy-JSONL paths produce these, so linearization and
// shape assembly live in exactly one place.

const BODY_KEYS = ['data', 'json', 'entry', 'payload', 'body', 'value', 'content_json'];

// Keys that mark a blob column as "this is the entry", not some unrelated JSON.
// Deliberately broad: a session header carries cwd/timestamp but no role, and a
// compaction carries tokensBefore but no content.
const ENTRY_HINTS = ['id', 'type', 'role', 'parentId', 'parent_id', 'content', 'message',
  'cwd', 'timestamp', 'tokensBefore', 'tokens_before', 'firstKeptEntryId', 'usage', 'toolName', 'text'];
const SESSION_HINTS = ['sessionId', 'session_id', 'sessionKey', 'sessionStartedAt', 'lastInteractionAt',
  'updatedAt', 'contextTokens', 'inputTokens', 'outputTokens', 'totalTokens', 'compactionCount',
  'archivedAt', 'pinnedAt'];

const looksLike = (o, hints) => !!o && !Array.isArray(o) && hints.some((k) => o[k] !== undefined);

function normalizeEntry(row, seq) {
  // The row may BE the entry (JSONL) or wrap it in a blob column (SQLite).
  let body = row;
  for (const k of BODY_KEYS) {
    const cand = asObject(row?.[k]);
    if (looksLike(cand, ENTRY_HINTS)) { body = cand; break; }
  }
  const get = viewOf(body === row ? null : body, row);
  const rawId = get('id', 'entryId', 'entry_id', 'uuid');
  const rawParent = get('parentId', 'parent_id', 'parentUuid', 'parent_uuid');
  return {
    id: rawId != null ? String(rawId) : null,
    parentId: rawParent != null ? String(rawParent) : null,
    type: String(get('type', 'entryType', 'entry_type', 'kind') ?? 'message'),
    ms: toMs(get('timestamp', 'ts', 'createdAt', 'created_at', 'time', 'at')),
    sessionId: (() => { const v = get('sessionId', 'session_id', 'transcriptId', 'transcript_id'); return v != null ? String(v) : null; })(),
    seq: Number.isFinite(Number(row?._rid)) ? Number(row._rid) : seq,
    get,
    body: body === row ? row : body,
  };
}

// ---------------------------------------------------------------------------
// THE HARD PART — TREE LINEARIZATION
// ---------------------------------------------------------------------------
//
// The transcript is a TREE, not a list. A rewind/fork creates a SIBLING branch
// off a shared parent, so the raw entry set contains paths the session
// abandoned. C-Space needs ONE ordered timeline, and showing an abandoned
// branch would misrepresent what the session actually did.
//
// Resolution, stated explicitly:
//   1. Index entries by id (duplicate ids: first wins, later ones warned+dropped).
//   2. Compute each entry's depth by walking parentId upward, memoized.
//   3. Candidate leaves = entries no other entry claims as a parent.
//   4. ACTIVE LEAF = the candidate with the greatest depth. TIE-BREAK, in order:
//        (a) latest timestamp, then (b) highest storage sequence (rowid / JSONL
//        line order), then (c) lexicographically greatest id — so the choice is
//        deterministic even on a store with no usable timestamps.
//   5. Walk parentId from that leaf to the root, then REVERSE => the active path.
//   6. Everything not on that path is an abandoned branch and is ignored.
//
// Malformed data must not hang or throw:
//   · cycles — a `seen` set on every upward walk (depth + path) breaks out and warns;
//   · orphaned parentId — the walk stops at the dangling node, treating it as a
//     root, and warns; the reachable suffix is still rendered.
function linearize(entries, { warnings } = {}) {
  const byId = new Map();
  const anonymous = []; // entries with no id at all can't take part in the tree
  for (const e of entries) {
    if (e.id == null) { anonymous.push(e); continue; }
    if (byId.has(e.id)) { warn(`duplicate transcript entry id ${e.id} — keeping the first`, warnings); continue; }
    byId.set(e.id, e);
  }
  if (anonymous.length) {
    warn(`${anonymous.length} transcript entr${anonymous.length === 1 ? 'y' : 'ies'} without an id — excluded from the tree`, warnings);
  }
  if (byId.size === 0) return anonymous.slice().sort(bySeq); // degenerate: no ids at all

  // A transcript with ids but NO resolvable parent links is not a tree — it's a
  // flat log (some legacy exports drop parentId). There is no branching to
  // resolve, so storage order IS the timeline; leaf-picking would otherwise
  // reduce the whole session to its last entry.
  const linked = [...byId.values()].some((e) => e.parentId != null && byId.has(e.parentId));
  if (!linked) return [...byId.values()].sort(bySeq);

  // ---- depth, memoized, cycle- and orphan-safe -----------------------------
  const depth = new Map();
  const depthOf = (e) => {
    if (depth.has(e.id)) return depth.get(e.id);
    let d = 0;
    let cur = e;
    const seen = new Set([e.id]);
    while (cur.parentId != null) {
      const parent = byId.get(cur.parentId);
      if (!parent) { // orphan: dangling parentId — treat this node as a root
        warn(`entry ${cur.id} references missing parent ${cur.parentId} — treating it as a root`, warnings);
        break;
      }
      if (seen.has(parent.id)) { // cycle
        warn(`parent cycle detected at entry ${parent.id} — truncating the walk`, warnings);
        break;
      }
      if (depth.has(parent.id)) { d += depth.get(parent.id) + 1; cur = null; break; }
      seen.add(parent.id);
      d++;
      cur = parent;
    }
    depth.set(e.id, d);
    return d;
  };
  for (const e of byId.values()) depthOf(e);

  // ---- leaves --------------------------------------------------------------
  const claimed = new Set();
  for (const e of byId.values()) if (e.parentId != null && byId.has(e.parentId)) claimed.add(e.parentId);
  const leaves = [...byId.values()].filter((e) => !claimed.has(e.id));
  if (!leaves.length) { // only possible if EVERY node is inside a cycle
    warn('no leaf entry found (transcript is fully cyclic) — falling back to storage order', warnings);
    return [...byId.values()].sort(bySeq);
  }

  // ---- active leaf: deepest, then most recent, then latest stored ----------
  leaves.sort((a, b) => {
    const dd = (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0);
    if (dd) return dd;
    const tt = (b.ms ?? -Infinity) - (a.ms ?? -Infinity);
    if (tt) return tt;
    const ss = (b.seq ?? 0) - (a.seq ?? 0);
    if (ss) return ss;
    return String(b.id).localeCompare(String(a.id));
  });
  const active = leaves[0];
  if (leaves.length > 1) {
    warn(`${leaves.length - 1} abandoned branch leaf/leaves ignored (active leaf ${active.id}, depth ${depth.get(active.id)})`, warnings);
  }

  // ---- walk to the root, then reverse -------------------------------------
  const path = [];
  const seen = new Set();
  let cur = active;
  while (cur) {
    if (seen.has(cur.id)) { warn(`cycle while walking to root at ${cur.id} — stopping`, warnings); break; }
    seen.add(cur.id);
    path.push(cur);
    if (cur.parentId == null) break;
    const parent = byId.get(cur.parentId);
    if (!parent) break; // orphan root — already warned during depth computation
    cur = parent;
    if (path.length > byId.size) { warn('path longer than the entry set — aborting the walk', warnings); break; }
  }
  path.reverse();
  return path;
}

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);

// ---------------------------------------------------------------------------
// shape assembly — one ordered active path -> the COMMON VIZ SHAPE
// ---------------------------------------------------------------------------
function buildShape({ sessionId, agentId = null, entries = [], session = {}, warnings } = {}) {
  const path = linearize(entries, { warnings });

  const events = [];
  const contextCurve = [];
  const compactions = [];
  const toolStats = new Map();      // name -> { count, errors, chars }
  const openToolCalls = new Map();  // call id -> { name, t }

  let userTurns = 0, assistantTurns = 0, thinkingBlocks = 0;
  let cwd = null, model = null, version = null, parentSession = null;

  const stamped = path.filter((e) => e.ms != null).map((e) => e.ms);
  // sessionStartedAt is the documented session origin; the header entry's own
  // timestamp usually matches it. Prefer the earliest evidence we actually have.
  const rowStart = toMs(pick(session, 'sessionStartedAt', 'session_started_at', 'createdAt', 'created_at'));
  let t0 = stamped.length ? Math.min(...stamped) : null;
  if (rowStart != null && (t0 == null || rowStart < t0)) t0 = rowStart;
  const tEnd = stamped.length ? Math.max(...stamped) : null;
  const rel = (ms) => (t0 != null && ms != null ? (ms - t0) / 1000 : 0);
  let lastT = 0;

  const pushCtx = (t, ctx, parts = {}) => {
    contextCurve.push({
      t,
      ctx: Math.max(0, num(ctx)),
      cacheRead: num(parts.cacheRead),
      cacheWrite: num(parts.cacheWrite),
      fresh: num(parts.fresh),
      out: num(parts.out),
    });
  };

  for (const e of path) {
    const t = e.ms != null ? rel(e.ms) : lastT;
    lastT = t;
    const get = e.get;
    const type = String(e.type ?? '').toLowerCase();

    // ---- session header --------------------------------------------------
    if (type === 'session' || type === 'session_header' || type === 'header') {
      cwd = cwd ?? (typeof get('cwd', 'workingDirectory', 'working_dir') === 'string' ? get('cwd', 'workingDirectory', 'working_dir') : null);
      // parentSession is the LINEAGE pointer: this transcript continues another
      // one (post-compaction successor, branch export, resumed session). Recorded
      // on meta so the fleet view can chain sessions; it is NOT itself a compaction
      // event — real compactions are their own entries, and inventing one here
      // would double-count them.
      const ps = get('parentSession', 'parent_session', 'parentSessionId', 'parent_session_id');
      if (ps != null && parentSession == null) parentSession = typeof ps === 'object' ? (pick(ps, 'sessionId', 'id') ?? null) : String(ps);
      const v = get('version', 'appVersion', 'gatewayVersion');
      if (version == null && v != null) version = String(v);
      const m = get('model', 'modelId', 'model_id');
      if (model == null && m != null) model = String(m);
      continue;
    }

    // ---- extension state that never reaches the model --------------------
    if (type === 'custom') {
      // Docs: "extension state persisting without model visibility". It is not
      // conversation and never occupies context, so it is deliberately SKIPPED
      // rather than mapped to a viz kind — showing it would inflate turn counts
      // with data the model never saw.
      continue;
    }

    // ---- branch-navigation metadata --------------------------------------
    if (type === 'branch_summary' || type === 'branchsummary') {
      // Docs list this as persisted metadata written when navigating branches.
      // The active path already excludes abandoned branches, so summarizing them
      // here would reintroduce exactly what linearization removed. SKIPPED.
      continue;
    }

    // ---- compaction ------------------------------------------------------
    if (type === 'compaction') {
      const tokensBefore = num(get('tokensBefore', 'tokens_before'));
      const firstKept = get('firstKeptEntryId', 'first_kept_entry_id') ?? null;
      // tokensBefore is a GIFT: the measured context size immediately before the
      // collapse. Emitting it as a ctx point at the compaction's own timestamp
      // makes the tower collapse by the TRUE amount instead of an inferred one.
      if (tokensBefore > 0) pushCtx(t, tokensBefore, { fresh: tokensBefore });
      compactions.push({ t, tokensBefore: tokensBefore || null, firstKeptEntryId: firstKept != null ? String(firstKept) : null });
      events.push({ t, kind: 'compaction' });
      continue;
    }

    // ---- extension message that DOES enter model context ------------------
    if (type === 'custom_message' || type === 'custommessage') {
      // Docs: "extension-injected content entering model context". It occupies
      // context and the model reads it, so it earns a 'say' — but ONLY when it
      // genuinely carries text. A payload-only custom_message (state blob, no
      // prose) is skipped rather than rendered as an empty assistant turn.
      const text = contentBlocks(get('content', 'text', 'message')).map(blockText).join('');
      if (text.trim()) {
        assistantTurns++;
        events.push({ t, kind: 'say', chars: text.length, preview: clean(text), side: false });
      }
      continue;
    }

    // ---- message: user / assistant / toolResult --------------------------
    if (type !== 'message' && type !== 'msg') continue; // unknown type: skip (forward-compatible)

    const roleRaw = get('role', 'messageRole', 'message_role', 'sender');
    const role = String(roleRaw ?? '').toLowerCase();
    const rawContent = get('content', 'text', 'message', 'parts');
    const nested = asObject(rawContent);
    const content = nested && !Array.isArray(nested) && nested.content != null ? nested.content : rawContent;

    if (role === 'user' || role === 'human') {
      const text = contentBlocks(content).map(blockText).join('');
      userTurns++;
      events.push({ t, kind: 'user', chars: text.length, preview: clean(text) });
      continue;
    }

    if (role === 'toolresult' || role === 'tool_result' || role === 'tool') {
      const id = get('toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id', 'callId', 'call_id');
      const key = id != null ? String(id) : null;
      const open = key != null ? openToolCalls.get(key) : undefined;
      const name = open?.name ?? (get('toolName', 'tool_name', 'name') != null ? String(get('toolName', 'tool_name', 'name')) : 'tool');
      const text = contentBlocks(get('content', 'result', 'output', 'text')).map(blockText).join('');
      const chars = text.length;
      const errRaw = get('isError', 'is_error', 'error', 'failed');
      const isErr = errRaw === true || errRaw === 1 || errRaw === '1' || errRaw === 'true' ||
                    String(get('status') ?? '').toLowerCase() === 'error';
      const st = toolStats.get(name) ?? { count: 0, errors: 0, chars: 0 };
      st.chars += chars;
      if (isErr) st.errors++;
      // A result with no matching call still registers its tool, so the tool
      // table never silently drops work (count stays 0 — we saw no call).
      if (!toolStats.has(name)) toolStats.set(name, st);
      events.push({ t, kind: 'tool_result', tool: name, id: key, chars, err: isErr, dur: open ? t - open.t : 0, side: false });
      if (key != null) openToolCalls.delete(key);
      continue;
    }

    if (role === 'assistant' || role === 'model' || role === '') {
      const m = get('model', 'modelId', 'model_id');
      if (model == null && m != null) model = String(m);

      // ctx sample, when the entry carries usage at all. OpenClaw's docs specify
      // token counters only at the SESSION level, so per-entry usage is
      // needs-real-data: read defensively, and if it is absent the curve simply
      // stays sparse (compaction points + the session tail) instead of being
      // filled with invented numbers.
      const entryCtx = num(get('contextTokens', 'context_tokens'));
      const usage = asObject(get('usage', 'tokenUsage', 'token_usage', 'tokens'));
      if (usage || entryCtx > 0) {
        const cacheRead = num(pick(usage, 'cache_read_input_tokens', 'cacheReadInputTokens', 'cachedInputTokens', 'cached_input_tokens'));
        const cacheWrite = num(pick(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheWriteInputTokens'));
        const fresh = num(pick(usage, 'input_tokens', 'inputTokens', 'promptTokens'));
        const out = num(pick(usage, 'output_tokens', 'outputTokens', 'completionTokens'));
        const ctx = entryCtx > 0 ? entryCtx : cacheRead + cacheWrite + fresh;
        if (ctx > 0 || out > 0) pushCtx(t, ctx, { cacheRead, cacheWrite, fresh, out });
      }

      const blocks = contentBlocks(content);
      let countedTurn = false;
      for (const b of blocks) {
        const bt = String(b?.type ?? (typeof b?.text === 'string' ? 'text' : '')).trim();
        if (THINK_BLOCK.test(bt)) {
          thinkingBlocks++;
          events.push({ t, kind: 'thinking', chars: blockText(b).length, side: false });
        } else if (CALL_BLOCK.test(bt)) {
          const c = normalizeCall(b, events.length);
          const st = toolStats.get(c.name) ?? { count: 0, errors: 0, chars: 0 };
          st.count++; toolStats.set(c.name, st);
          openToolCalls.set(String(c.id), { name: c.name, t });
          events.push({ t, kind: 'tool_call', tool: c.name, id: String(c.id), label: labelForArgs(c.args), side: false });
        } else if (TEXT_BLOCK.test(bt) || bt === '') {
          const text = blockText(b);
          if (text) {
            if (!countedTurn) { assistantTurns++; countedTurn = true; }
            events.push({ t, kind: 'say', chars: text.length, preview: clean(text), side: false });
          }
        }
        // any other block type carries no viz signal — ignored, not faked
      }

      // reasoning / tool calls may also live in dedicated fields beside content
      const think = get('reasoning', 'thinking', 'thought');
      if (typeof think === 'string' && think.trim()) {
        thinkingBlocks++;
        events.push({ t, kind: 'thinking', chars: think.length, side: false });
      }
      const calls = get('toolCalls', 'tool_calls');
      const callArr = Array.isArray(calls) ? calls : (Array.isArray(asObject(calls)) ? asObject(calls) : []);
      for (const [i, raw] of callArr.entries()) {
        const c = normalizeCall(raw, i);
        const st = toolStats.get(c.name) ?? { count: 0, errors: 0, chars: 0 };
        st.count++; toolStats.set(c.name, st);
        openToolCalls.set(String(c.id), { name: c.name, t });
        events.push({ t, kind: 'tool_call', tool: c.name, id: String(c.id), label: labelForArgs(c.args), side: false });
      }
      continue;
    }

    // unknown role: skipped, timeline stays monotonic
  }

  // ---- session-level token counters ---------------------------------------
  // contextTokens is the CURRENT context size for the session, so it belongs at
  // the tail of the curve. inputTokens/outputTokens/totalTokens are cumulative
  // usage, not context size — they are used only as a last-resort peak floor
  // when nothing else measured the context, and are flagged needs-real-data.
  const sessCtx = num(pick(session, 'contextTokens', 'context_tokens'));
  const durS = t0 != null && tEnd != null ? (tEnd - t0) / 1000 : 0;
  if (sessCtx > 0) pushCtx(durS, sessCtx, { fresh: sessCtx });
  contextCurve.sort((a, b) => a.t - b.t);

  const curvePeak = contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0);
  let peakContext = Math.max(curvePeak, sessCtx);
  if (peakContext === 0) {
    const inTok = num(pick(session, 'inputTokens', 'input_tokens'));
    const outTok = num(pick(session, 'outputTokens', 'output_tokens'));
    const total = num(pick(session, 'totalTokens', 'total_tokens'));
    peakContext = Math.max(total, inTok + outTok); // coarse upper bound; needs-real-data
  }

  events.sort((a, b) => a.t - b.t);

  // ---- compactionCount sanity check ---------------------------------------
  const declared = pick(session, 'compactionCount', 'compaction_count');
  if (declared != null && num(declared) !== compactions.length) {
    warn(
      `compactionCount mismatch for session ${sessionId}: row says ${num(declared)}, ` +
      `active path contains ${compactions.length}. Compactions on abandoned branches ` +
      `are excluded by design, so a higher row count is expected after a rewind.`,
      warnings,
    );
  }

  const tools = Object.fromEntries([...toolStats.entries()].sort((a, b) => b[1].count - a[1].count));
  const toolCalls = [...toolStats.values()].reduce((a, s) => a + s.count, 0);

  return {
    meta: {
      sessionId: sessionId ?? null,
      cwd,
      model,
      version,
      startedAt: t0 != null ? new Date(t0).toISOString() : null,
      durationS: Math.round(durS),
      userTurns, assistantTurns, thinkingBlocks,
      hookEvents: 0,        // OpenClaw documents no hook concept
      toolCalls,
      peakContext,
      // extras (additive; every canonical key above is still present)
      agentId,
      parentSession,        // lineage: the transcript this one continues, if any
    },
    tools,
    contextCurve,
    subagents: [],          // no subagent/spawn concept in the documented model
    compactions,
    events,
  };
}

// ---------------------------------------------------------------------------
// SQLite path
// ---------------------------------------------------------------------------

// Open an agent's store READ-ONLY, or return null. There is deliberately no
// read-write retry: a read-write SQLite handle mutates the store even when no
// write statement is issued (it can create -wal/-shm sidecars, roll back a hot
// journal on open, and checkpoint/delete the WAL on close). A failed open
// therefore degrades to that agent's legacy JSONL rows (or a clear throw in
// parse()) rather than escalating to a writable handle.
function openDb(path) {
  if (!DatabaseSync || !path || !existsSync(path)) return null;
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

const SAFE_NAME = /^[A-Za-z0-9_]+$/;

function tableNames(db) {
  const rows = allRows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')") ?? [];
  return rows
    .map((r) => r.name)
    .filter((n) => typeof n === 'string' && SAFE_NAME.test(n) && !n.startsWith('sqlite_'))
    // FTS/shadow tables mirror real content — never read them
    .filter((n) => !/_(fts|content|data|idx|docsize|config|segdir|segments|stat)$/i.test(n));
}

/**
 * The docs name the two persistence LAYERS but not their tables, so locate them
 * by name. Explicit candidates first, then a pattern fallback. needs-real-data.
 */
function findTables(db) {
  const names = tableNames(db);
  const has = (n) => names.find((x) => x.toLowerCase() === n);
  const sessions =
    has('sessions') ?? has('session_entries') ?? has('sessionentries') ?? has('session_rows') ??
    has('session_store') ?? has('sessionstore') ?? has('session') ??
    names.find((n) => /session/i.test(n) && !/(transcript|entries|events|messages|history)/i.test(n)) ?? null;
  const transcript =
    has('transcript_entries') ?? has('transcriptentries') ?? has('transcript_events') ??
    has('transcript') ?? has('entries') ?? has('events') ?? has('messages') ?? has('history') ??
    names.find((n) => /(transcript|entr|event|message|history)/i.test(n) && n !== sessions) ?? null;
  return { sessions, transcript, names };
}

/** SessionEntry rows may be exploded columns or a sessionKey/value JSON pair. */
function normalizeSessionRow(row) {
  let body = row;
  for (const k of [...BODY_KEYS, 'session', 'sessionEntry', 'session_entry']) {
    const cand = asObject(row?.[k]);
    if (looksLike(cand, SESSION_HINTS)) { body = cand; break; }
  }
  const get = viewOf(body === row ? null : body, row);
  const sessionKey = get('sessionKey', 'session_key', 'key', 'id');
  const sessionId = get('sessionId', 'session_id', 'transcriptId', 'transcript_id');
  const out = {
    sessionKey: sessionKey != null ? String(sessionKey) : null,
    sessionId: sessionId != null ? String(sessionId) : (sessionKey != null ? String(sessionKey) : null),
  };
  for (const [k, ...aliases] of [
    ['sessionStartedAt', 'session_started_at', 'createdAt', 'created_at'],
    ['lastInteractionAt', 'last_interaction_at'],
    ['updatedAt', 'updated_at'],
    ['archivedAt', 'archived_at'],
    ['pinnedAt', 'pinned_at'],
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['totalTokens', 'total_tokens'],
    ['contextTokens', 'context_tokens'],
    ['compactionCount', 'compaction_count'],
    ['memoryFlushAt', 'memory_flush_at'],
    ['memoryFlushCompactionCount', 'memory_flush_compaction_count'],
  ]) {
    const v = get(k, ...aliases);
    if (v != null) out[k] = v;
  }
  return out;
}

function readSessionRows(db, table) {
  if (!table || !SAFE_NAME.test(table)) return [];
  const rows = allRows(db, `SELECT * FROM "${table}"`) ?? [];
  return rows.map(normalizeSessionRow).filter((s) => s.sessionId != null || s.sessionKey != null);
}

function readTranscriptEntries(db, table, sessionId, { warnings } = {}) {
  if (!table || !SAFE_NAME.test(table)) return [];
  // Prefer a server-side filter when a session column exists…
  for (const col of ['sessionId', 'session_id', 'transcriptId', 'transcript_id']) {
    const rows = allRows(db, `SELECT rowid AS _rid, * FROM "${table}" WHERE "${col}" = ? ORDER BY rowid ASC`, String(sessionId));
    if (rows && rows.length) return rows.map((r, i) => normalizeEntry(r, i));
  }
  // …otherwise read the table and scope in JS (the session id may live inside
  // the JSON body, or the table may hold a single transcript with no such column).
  let rows = allRows(db, `SELECT rowid AS _rid, * FROM "${table}" ORDER BY rowid ASC`);
  if (rows == null) rows = allRows(db, `SELECT * FROM "${table}"`) ?? [];
  const all = rows.map((r, i) => normalizeEntry(r, i));
  const scoped = all.filter((e) => e.sessionId == null || e.sessionId === String(sessionId));
  if (!scoped.length && all.length) {
    warn(`no transcript entries matched session ${sessionId} in table ${table}`, warnings);
  }
  return scoped;
}

// ---------------------------------------------------------------------------
// agent enumeration
// ---------------------------------------------------------------------------

function agentPaths(agentId) {
  const dir = join(AGENTS_DIR, agentId);
  return {
    agentId,
    dir,
    dbPath: join(dir, 'agent', DB_BASENAME),
    sessionsDir: join(dir, 'sessions'),
    indexPath: join(dir, 'sessions', 'sessions.json'),
  };
}

/** Every ~/.openclaw/agents/<agentId>/ that actually holds a store. */
function listAgents() {
  let ents;
  try { ents = readdirSync(AGENTS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = agentPaths(e.name);
    if (existsSync(p.dbPath) || existsSync(p.sessionsDir)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// legacy path: sessions.json index + per-session .jsonl transcripts
// ---------------------------------------------------------------------------
//
// Used when no SQLite DB exists (older installs, imports/exports, archives).
// Same output shape — the tree lives in the JSONL too, so it goes through the
// identical normalize -> linearize -> buildShape pipeline.

/** sessions.json may be an array, a sessionKey->entry map, or {sessions:[…]}. */
function parseLegacyIndex(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  let list = [];
  if (Array.isArray(doc)) list = doc;
  else if (doc && typeof doc === 'object') {
    if (Array.isArray(doc.sessions)) list = doc.sessions;
    else if (doc.sessions && typeof doc.sessions === 'object') {
      list = Object.entries(doc.sessions).map(([k, v]) => ({ sessionKey: k, ...(v && typeof v === 'object' ? v : {}) }));
    } else {
      list = Object.entries(doc).map(([k, v]) => ({ sessionKey: k, ...(v && typeof v === 'object' ? v : {}) }));
    }
  }
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => normalizeSessionRow(x))
    .filter((s) => s.sessionId != null || s.sessionKey != null);
}

/** One legacy .jsonl transcript -> normalized entries (streamed, never slurped). */
function parseLegacyTranscript(pathOrText, { isText = false } = {}) {
  const entries = [];
  let i = 0;
  const onLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; } // malformed line: skip, keep going
    if (o && typeof o === 'object') entries.push(normalizeEntry(o, i++));
  };
  if (isText) for (const l of String(pathOrText).split(/\r?\n/)) onLine(l);
  else forEachLineSync(pathOrText, onLine);
  return entries;
}

// sessionId / sessionKey come OUT OF THE STORE (sessions.json), so they are
// untrusted input as far as this process is concerned: they must never be able
// to steer a filesystem path. A transcript basename is a flat id — allow only
// [A-Za-z0-9._-], reject a leading dot, and cap the length. Anything else (a
// separator, "..", a drive letter, a NUL, a URL) is refused, not sanitized.
const SAFE_TRANSCRIPT_KEY = /^[A-Za-z0-9._-]+$/;

function isSafeTranscriptKey(key) {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > 128) return false;
  if (key.startsWith('.')) return false;
  return SAFE_TRANSCRIPT_KEY.test(key);
}

function legacyTranscriptPath(p, s) {
  for (const key of [s.sessionId, s.sessionKey]) {
    if (key == null || key === '') continue;
    const name = String(key);
    if (!isSafeTranscriptKey(name)) {
      warn(`ignoring session key with unsafe characters (not used in a path): ${clean(name, 40)}`);
      continue;
    }
    const file = join(p.sessionsDir, `${name}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function legacyRows(p) {
  const rows = [];
  const seen = new Set();

  if (existsSync(p.indexPath)) {
    let idx = [];
    try { idx = parseLegacyIndex(readFileSync(p.indexPath, 'utf8')); } catch { idx = []; }
    for (const s of idx) {
      const file = legacyTranscriptPath(p, s);
      const st = file ? safeStat(file) : null;
      const id = s.sessionId ?? s.sessionKey;
      if (file) seen.add(file);
      rows.push({
        id,
        sessionKey: s.sessionKey ?? null,
        agentId: p.agentId,
        source: 'openclaw',
        project: projectLabel(p.agentId, s),
        // Carry the index's SessionEntry through to parse(). The legacy transcript
        // has no session row to re-read (unlike the SQLite path, where parse()
        // fetches it again), so without this the token counters we just read here
        // are thrown away and the session parses with peakContext 0 and no curve
        // tail. Counters only — no transcript content rides along.
        session: s,
        path: file ?? undefined,
        ref: `openclaw:${p.agentId}:${id}`,
        mtime: toMs(pick(s, 'lastInteractionAt', 'updatedAt', 'sessionStartedAt')) ?? (st ? st.mtimeMs : 0),
        sizeMB: st ? +(st.size / (1024 * 1024)).toFixed(3) : 0,
        active: isActive(pick(s, 'lastInteractionAt', 'updatedAt')),
        legacy: true,
      });
    }
  }

  // transcripts present on disk but absent from (or without) the index
  let files = [];
  try { files = readdirSync(p.sessionsDir).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
  for (const f of files) {
    const file = join(p.sessionsDir, f);
    if (seen.has(file)) continue;
    const st = safeStat(file);
    const id = basename(f, '.jsonl');
    rows.push({
      id,
      sessionKey: null,
      agentId: p.agentId,
      source: 'openclaw',
      project: projectLabel(p.agentId, null),
      path: file,
      ref: `openclaw:${p.agentId}:${id}`,
      mtime: st ? st.mtimeMs : 0,
      sizeMB: st ? +(st.size / (1024 * 1024)).toFixed(3) : 0,
      active: false,
      legacy: true,
    });
  }
  return rows;
}

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

const isActive = (v) => {
  const ms = toMs(v);
  return ms != null ? Date.now() - ms < ACTIVE_WINDOW_MS : false;
};

/**
 * The `project` field carries the agentId so the fleet view can tell one agent
 * from another (a Gateway host may run many). A session title/key, when the row
 * has one, is appended for human legibility.
 */
function projectLabel(agentId, session) {
  const extra = session ? (pick(session, 'title', 'name', 'sessionKey') ?? null) : null;
  const label = extra != null && String(extra) !== String(agentId) ? `${agentId}/${clean(String(extra), 32)}` : String(agentId);
  return clean(`openclaw:${label}`, 60);
}

/** discover() rows for one agent's SQLite store (also used by tests via _internal). */
function discoverFromDb(db, agentId, dbPath) {
  const { sessions } = findTables(db);
  if (!sessions) return [];
  const rows = readSessionRows(db, sessions);
  return rows.map((s) => {
    const id = s.sessionId ?? s.sessionKey;
    const mtime = toMs(pick(s, 'lastInteractionAt', 'updatedAt', 'sessionStartedAt')) ?? 0;
    const total = num(pick(s, 'totalTokens')) || (num(pick(s, 'inputTokens')) + num(pick(s, 'outputTokens')));
    return {
      id: String(id),
      sessionKey: s.sessionKey,
      agentId,
      source: 'openclaw',
      project: projectLabel(agentId, s),
      dbPath: dbPath ?? null,
      ref: `openclaw:${agentId}:${id}`,
      mtime,
      // The docs expose no on-disk per-session size; estimate from the token
      // totals (~4 bytes/token) so the fleet view can scale rows. needs-real-data.
      sizeMB: +((total * 4) / (1024 * 1024)).toFixed(3),
      active: isActive(pick(s, 'lastInteractionAt')),
      archived: pick(s, 'archivedAt') != null,
      pinned: pick(s, 'pinnedAt') != null,
    };
  });
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

const openclaw = {
  id: 'openclaw',
  label: 'OpenClaw',

  // Is an OpenClaw store present on THIS machine? True when ANY agent directory
  // holds either the canonical SQLite DB or a legacy sessions/ directory.
  storeExists() {
    if (!existsSync(AGENTS_DIR)) return false;
    return listAgents().length > 0;
  },

  // One row per session across ALL agents, each tagged source:'openclaw' and
  // carrying its agentId (both as a field and inside `project`). SQLite is
  // authoritative per agent; the legacy index/JSONL is consulted only when that
  // agent has no readable DB — so a half-migrated fleet still lists completely.
  discover() {
    const out = [];
    for (const p of listAgents()) {
      let handled = false;
      if (existsSync(p.dbPath) && DatabaseSync) {
        const db = openDb(p.dbPath);
        if (db) {
          try {
            const rows = discoverFromDb(db, p.agentId, p.dbPath);
            out.push(...rows);
            handled = rows.length > 0;
          } catch {
            // corrupt/unexpected store for this agent — fall through to legacy
          } finally {
            try { db.close(); } catch { /* ignore */ }
          }
        }
      }
      if (!handled && existsSync(p.sessionsDir)) {
        try { out.push(...legacyRows(p)); } catch { /* skip this agent */ }
      }
    }
    out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return out;
  },

  // Produce the COMMON VIZ SHAPE for one session.
  //   entry = a discover() row, or any of:
  //     { path }            a legacy .jsonl transcript (index metadata optional)
  //     { db, id }          an already-open DatabaseSync (used by the test suite
  //                         so it never touches ~/.openclaw). Not closed here.
  //     { agentId, id }     resolve the agent's canonical DB and read it
  //     { dbPath, id }      read that DB directly
  parse(entry) {
    if (!entry) throw new Error('openclaw.parse: entry is required');
    const warnings = Array.isArray(entry.warnings) ? entry.warnings : undefined;

    // ---- legacy JSONL transcript ------------------------------------------
    if (entry.path && String(entry.path).endsWith('.jsonl')) {
      const entries = parseLegacyTranscript(entry.path);
      const session = entry.session ?? legacySessionMeta(entry);
      return buildShape({
        sessionId: entry.id ?? basename(String(entry.path), '.jsonl'),
        agentId: entry.agentId ?? null,
        entries,
        session,
        warnings,
      });
    }

    // ---- SQLite ------------------------------------------------------------
    const injected = !!entry.db;
    const dbPath = entry.dbPath ?? (entry.agentId ? agentPaths(entry.agentId).dbPath : null);
    const db = entry.db ?? openDb(dbPath);
    if (!db) {
      throw new Error('openclaw.parse: no readable OpenClaw DB (node:sqlite unavailable, or store missing)');
    }
    try {
      const { sessions, transcript } = findTables(db);
      const rows = sessions ? readSessionRows(db, sessions) : [];
      const want = entry.id != null ? String(entry.id) : null;
      const key = entry.sessionKey != null ? String(entry.sessionKey) : null;
      const session =
        rows.find((s) => (key != null && s.sessionKey === key)) ??
        rows.find((s) => want != null && (s.sessionId === want || s.sessionKey === want)) ??
        (rows.length === 1 ? rows[0] : null) ??
        {};
      // The session ROW is the authority on which transcript is current: the
      // documented sessionId points at the live transcript for that sessionKey.
      const sessionId = session.sessionId ?? want ?? key;
      if (sessionId == null) throw new Error('openclaw.parse: entry.id (or entry.sessionKey) is required for the SQLite path');
      if (!transcript) warn(`no transcript table found in ${dbPath ?? 'the provided DB'}`, warnings);
      const entries = transcript ? readTranscriptEntries(db, transcript, sessionId, { warnings }) : [];
      return buildShape({
        sessionId: String(sessionId),
        agentId: entry.agentId ?? null,
        entries,
        session,
        warnings,
      });
    } finally {
      if (!injected) { try { db.close(); } catch { /* ignore */ } }
    }
  },
};

/** Pull the session-level counters a legacy discover() row already carried. */
function legacySessionMeta(entry) {
  const out = {};
  for (const k of ['sessionStartedAt', 'lastInteractionAt', 'updatedAt', 'contextTokens',
    'inputTokens', 'outputTokens', 'totalTokens', 'compactionCount']) {
    if (entry?.[k] != null) out[k] = entry[k];
  }
  return out;
}

// Exposed for tests (tests/openclaw.test.mjs) — lets a suite build shapes from
// an in-memory DatabaseSync or literal JSONL text without touching ~/.openclaw.
export const _internal = {
  DatabaseSync,
  AGENTS_DIR,
  DB_BASENAME,
  buildShape,
  linearize,
  normalizeEntry,
  normalizeSessionRow,
  parseLegacyIndex,
  parseLegacyTranscript,
  legacyRows,
  discoverFromDb,
  findTables,
  readSessionRows,
  readTranscriptEntries,
  agentPaths,
  listAgents,
  toMs,
  labelForArgs,
  contentBlocks,
  projectLabel,
};

export default openclaw;
