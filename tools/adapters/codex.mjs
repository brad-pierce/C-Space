// adapters/codex.mjs — the Codex (OpenAI) source, exposed through the common
// adapter interface (see adapters/index.mjs and adapters/claude.mjs). Produces
// the exact COMMON VIZ SHAPE so every downstream viz module works unchanged.
//
// Read-only w.r.t. ~/.codex — never writes to the session store.
//
// Codex rollout files live at:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl   (active tree)
//   ~/.codex/archived_sessions/rollout-<ISO>-<uuid>.jsonl     (archived, flat)
// Each line is { timestamp, type, payload }. The shapes below were verified
// against real local rollout files.
//
// SOURCE-OF-TRUTH MAP (chosen so each viz kind has exactly ONE emitter that is
// present across every rollout-format variant seen locally — no double counting):
//   user       <- event_msg.user_message         (clean user text)
//   say        <- event_msg.agent_message        (clean assistant text)
//   thinking   <- response_item.reasoning        (present even when the newer
//                                                  event_msg.agent_reasoning is
//                                                  absent; summary text -> chars)
//   tool_call  <- response_item.function_call | response_item.custom_tool_call
//   tool_result<- response_item.function_call_output | custom_tool_call_output
//   ctx        <- event_msg.token_count          (last_token_usage per request)
//   compaction <- event_msg.context_compacted
// response_item.message and event_msg.agent_reasoning are intentionally IGNORED
// because they duplicate the streams above. Codex has no subagent / hook
// analogue in the base format, so those arrays stay empty (honest, not faked).

import { openSync, readSync, closeSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CODEX = join(homedir(), '.codex');
const SESSIONS = join(CODEX, 'sessions');
const ARCHIVED = join(CODEX, 'archived_sessions');

const ACTIVE_WINDOW_MS = 60_000; // a file touched this recently is "live"

const clean = (s, n = 96) => {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

// ---------------------------------------------------------------------------
// synchronous streaming line reader.
// Codex rollouts embed base64 images inline, so a single file can exceed
// Node's max string length — readFileSync(path,'utf8') throws ERR_STRING_TOO_LONG.
// We read fixed byte chunks and split on LF at the byte level (a multibyte UTF-8
// char never straddles a newline, so per-line toString is always safe). Stays
// synchronous to match the claude/hermes parse() contract, never holds the
// whole file, and never builds one giant string.
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

// Read just the first line of a rollout (the session_meta record) without
// slurping the whole file — used by discover() to recover cwd cheaply.
function firstLineSync(path) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 16);
    let acc = Buffer.alloc(0), bytes;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      acc = Buffer.concat([acc, chunk.subarray(0, bytes)]);
      const nl = acc.indexOf(0x0a);
      if (nl !== -1) return acc.toString('utf8', 0, nl);
      if (acc.length > (1 << 20)) break; // giant first line — give up cheaply
    }
    return acc.length ? acc.toString('utf8') : '';
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// discovery helpers
// ---------------------------------------------------------------------------
function walk(dir, out) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
  }
}

// Pull the trailing UUID out of a rollout filename; fall back to the basename.
function idFromPath(path) {
  const b = basename(path, '.jsonl');
  const m = b.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : b;
}

function projectFromFirstLine(path) {
  const raw = firstLineSync(path);
  if (!raw) return null;
  try {
    const line = JSON.parse(raw);
    const cwd = line?.payload?.cwd;
    if (typeof cwd === 'string' && cwd) return basename(cwd.replace(/[\\/]+$/, ''));
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// tool label extraction
// ---------------------------------------------------------------------------
function toolLabel(argStr) {
  if (typeof argStr !== 'string' || !argStr) return '';
  let obj = null;
  try { obj = JSON.parse(argStr); } catch { /* not JSON (e.g. custom_tool_call exec script) */ }
  if (obj && typeof obj === 'object') {
    const v = obj.command ?? obj.cmd ?? obj.file_path ?? obj.path ?? obj.pattern ??
              obj.query ?? obj.url ?? obj.referenced_image_paths ?? obj.prompt;
    if (Array.isArray(v)) return clean(v.join(' '), 80);
    if (typeof v === 'string') return clean(v, 80);
    return clean(argStr, 80);
  }
  return clean(argStr, 80);
}

// Flatten a tool-output payload (string, or array of {type,text|image_url}) to
// text for a char count, and decide error-ness from exit-code chatter.
function outputToText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    let s = '';
    for (const c of output) {
      if (typeof c === 'string') s += c;
      else if (typeof c?.text === 'string') s += c.text;
    }
    return s;
  }
  return '';
}
const NONZERO_EXIT = /(?:exit(?:ed)?\s*(?:code|with code)|process exited with code)[:\s]+([1-9]\d*)/i;

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------
const codex = {
  id: 'codex',
  label: 'Codex',

  // Does the Codex store exist on THIS machine?
  storeExists() {
    return existsSync(SESSIONS) || existsSync(ARCHIVED);
  },

  // Walk both trees for rollout-*.jsonl. Each row is tagged source:'codex'.
  discover() {
    if (!this.storeExists()) return [];
    const paths = [];
    walk(SESSIONS, paths);
    walk(ARCHIVED, paths);
    const now = Date.now();
    const rows = [];
    for (const path of paths) {
      let st;
      try { st = statSync(path); } catch { continue; }
      rows.push({
        id: idFromPath(path),
        source: 'codex',
        project: projectFromFirstLine(path),
        path,
        mtime: st.mtimeMs,
        sizeMB: st.size / (1024 * 1024),
        active: now - st.mtimeMs < ACTIVE_WINDOW_MS,
      });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows;
  },

  // Produce the COMMON VIZ SHAPE for one session (a discover() row, or any
  // object carrying { id, path }). Streams the JSONL — never slurps it whole.
  parse(entry) {
    const path = entry?.path;
    if (!path) throw new Error('codex.parse: entry.path is required');

    const meta = { sessionId: entry?.id ?? idFromPath(path), cwd: null, model: null, version: null };
    const toolStats = new Map();          // name -> { count, errors, chars }
    const openToolCalls = new Map();      // call_id -> { name, t }
    const events = [];
    const contextCurve = [];
    const compactions = [];
    let t0 = null, tEnd = null, lastT = 0;
    let userTurns = 0, assistantTurns = 0, thinkingBlocks = 0;

    forEachLineSync(path, (raw) => {
      let line;
      try { line = JSON.parse(raw); } catch { return; }
      const ms = Date.parse(line.timestamp ?? '');
      if (!Number.isNaN(ms)) { if (t0 === null) t0 = ms; tEnd = ms; }
      if (t0 === null) return; // nothing anchored to a timeline yet
      const t = !Number.isNaN(ms) ? (ms - t0) / 1000 : lastT;
      lastT = t;

      const type = line.type;
      const p = line.payload || {};

      if (type === 'session_meta') {
        if (p.session_id) meta.sessionId = p.session_id;
        if (!meta.cwd && p.cwd) meta.cwd = p.cwd;
        if (!meta.version && p.cli_version) meta.version = p.cli_version;
        if (!meta.model && p.model) meta.model = p.model;
        return;
      }

      if (type === 'turn_context') {
        if (!meta.model && p.model) meta.model = p.model;
        if (!meta.cwd && p.cwd) meta.cwd = p.cwd;
        return;
      }

      if (type === 'event_msg') {
        switch (p.type) {
          case 'user_message': {
            const text = typeof p.message === 'string' ? p.message : '';
            userTurns++;
            events.push({ t, kind: 'user', chars: text.length, preview: clean(text) });
            return;
          }
          case 'agent_message': {
            const text = typeof p.message === 'string' ? p.message : '';
            assistantTurns++;
            events.push({ t, kind: 'say', chars: text.length, preview: clean(text), side: false });
            return;
          }
          case 'token_count': {
            const u = p.info?.last_token_usage;
            if (u) {
              const cacheRead = u.cached_input_tokens ?? 0;
              const cacheWrite = u.cache_write_input_tokens ?? 0;
              const inTot = u.input_tokens ?? 0; // total input, cached inclusive
              const fresh = Math.max(0, inTot - cacheRead - cacheWrite);
              contextCurve.push({
                t, ctx: cacheRead + cacheWrite + fresh, cacheRead, cacheWrite, fresh,
                out: u.output_tokens ?? 0,
              });
            }
            return;
          }
          case 'context_compacted': {
            compactions.push({ t });
            events.push({ t, kind: 'compaction' });
            return;
          }
          default:
            return; // task_started, agent_reasoning (dup), *_end telemetry, etc.
        }
      }

      if (type === 'response_item') {
        switch (p.type) {
          case 'reasoning': {
            const text = Array.isArray(p.summary)
              ? p.summary.map((s) => (typeof s?.text === 'string' ? s.text : '')).join(' ').trim()
              : '';
            thinkingBlocks++;
            events.push({ t, kind: 'thinking', chars: text.length, side: false });
            return;
          }
          case 'function_call':
          case 'custom_tool_call': {
            const name = p.name ?? '?';
            const callId = p.call_id ?? p.id ?? null;
            const st = toolStats.get(name) ?? { count: 0, errors: 0, chars: 0 };
            st.count++; toolStats.set(name, st);
            if (callId != null) openToolCalls.set(callId, { name, t });
            const argStr = p.type === 'custom_tool_call'
              ? (typeof p.input === 'string' ? p.input : '')
              : (typeof p.arguments === 'string' ? p.arguments : '');
            events.push({ t, kind: 'tool_call', tool: name, id: callId, label: toolLabel(argStr), side: false });
            return;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const callId = p.call_id ?? p.id ?? null;
            const text = outputToText(p.output);
            const chars = text.length;
            const isErr = NONZERO_EXIT.test(text);
            const open = callId != null ? openToolCalls.get(callId) : null;
            if (open) {
              const st = toolStats.get(open.name);
              if (st) { st.chars += chars; if (isErr) st.errors++; }
              events.push({ t, kind: 'tool_result', tool: open.name, id: callId, chars, err: isErr, dur: t - open.t, side: false });
              openToolCalls.delete(callId);
            } else {
              events.push({ t, kind: 'tool_result', tool: '?', id: callId, chars, err: isErr, dur: 0, side: false });
            }
            return;
          }
          default:
            return; // response_item.message duplicates event_msg user/agent text
        }
      }
      // world_state and any other record types carry no viz signal — ignored.
    });

    const durS = t0 !== null && tEnd !== null ? (tEnd - t0) / 1000 : 0;
    events.sort((a, b) => a.t - b.t);
    const peakContext = contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0);
    const toolCalls = [...toolStats.values()].reduce((a, s) => a + s.count, 0);

    return {
      meta: {
        ...meta,
        startedAt: t0 ? new Date(t0).toISOString() : null,
        durationS: Math.round(durS),
        userTurns, assistantTurns, thinkingBlocks, hookEvents: 0,
        toolCalls, peakContext,
      },
      tools: Object.fromEntries([...toolStats.entries()].sort((a, b) => b[1].count - a[1].count)),
      contextCurve,
      subagents: [],
      compactions,
      events,
    };
  },
};

export default codex;
export const _internal = { forEachLineSync, firstLineSync, toolLabel, outputToText, idFromPath };
