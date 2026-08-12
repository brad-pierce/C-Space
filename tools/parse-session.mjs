#!/usr/bin/env node
// parse-session.mjs — stream a Claude Code session JSONL into a viz-ready session.json
// Usage: node tools/parse-session.mjs <path-to-session.jsonl> [out.json]

import { createReadStream } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { FLAGSHIP_FILE, ensureDataDir } from './cspace-paths.mjs';

const src = process.argv[2];
// Default output is the flagship slot in the OUT-OF-REPO store (see
// tools/cspace-paths.mjs) — parsed transcripts never land in the source tree.
const out = process.argv[3] ?? FLAGSHIP_FILE;
if (!process.argv[3]) ensureDataDir();
if (!src) { console.error('usage: parse-session.mjs <session.jsonl> [out.json]'); process.exit(1); }

const rl = createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });

const events = [];            // flat ordered timeline
const toolStats = new Map();  // name -> {count, errors, chars}
const contextCurve = [];      // {t, ctx, cacheRead, cacheWrite, fresh, out}
const subagents = [];         // {id, label, type, spawnT, endT, sidechain}
const compactions = [];       // {t}
const openToolCalls = new Map(); // tool_use id -> {name, t, agent}
let meta = { sessionId: basename(src, '.jsonl'), cwd: null, model: null, version: null };
let t0 = null, tEnd = null;
let userTurns = 0, assistantTurns = 0, thinkingBlocks = 0, hookEvents = 0;

const clean = (s, n = 96) => {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const ts = (line) => {
  const d = Date.parse(line.timestamp ?? '');
  return Number.isNaN(d) ? null : d;
};
const rel = (ms) => (ms - t0) / 1000;

for await (const raw of rl) {
  if (!raw.trim()) continue;
  let line;
  try { line = JSON.parse(raw); } catch { continue; }
  const ms = ts(line);
  if (ms !== null) { if (t0 === null) t0 = ms; tEnd = ms; }
  if (t0 === null) continue;
  const t = ms !== null ? rel(ms) : (events.length ? events[events.length - 1].t : 0);
  if (line.cwd && !meta.cwd) meta.cwd = line.cwd;
  if (line.version && !meta.version) meta.version = line.version;

  const sidechain = !!line.isSidechain;

  if (line.type === 'queue-operation') {
    if (line.operation === 'enqueue') {
      events.push({ t, kind: 'queued', preview: clean(line.content) });
    }
    continue;
  }

  if (line.type === 'summary' || line.isCompactSummary ||
      (line.type === 'system' && /compact/i.test(line.subtype ?? ''))) {
    compactions.push({ t });
    events.push({ t, kind: 'compaction' });
    continue;
  }

  if (line.type === 'attachment' && line.attachment?.hookEvent) {
    hookEvents++;
    events.push({
      t, kind: 'hook', name: line.attachment.hookName ?? line.attachment.hookEvent,
      err: (line.attachment.exitCode ?? 0) !== 0,
    });
    continue;
  }

  if (line.type === 'assistant' && line.message) {
    const m = line.message;
    if (m.model && !meta.model) meta.model = m.model;
    const u = m.usage;
    if (u && !sidechain) {
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const fresh = u.input_tokens ?? 0;
      contextCurve.push({ t, ctx: cacheRead + cacheWrite + fresh, cacheRead, cacheWrite, fresh, out: u.output_tokens ?? 0 });
    }
    const content = Array.isArray(m.content) ? m.content : [];
    let counted = false;
    for (const block of content) {
      if (block.type === 'thinking') {
        thinkingBlocks++;
        events.push({ t, kind: 'thinking', chars: (block.thinking ?? '').length, side: sidechain });
      } else if (block.type === 'text') {
        if (!counted && !sidechain) { assistantTurns++; counted = true; }
        events.push({ t, kind: 'say', chars: (block.text ?? '').length, preview: clean(block.text), side: sidechain });
      } else if (block.type === 'tool_use') {
        const name = block.name ?? '?';
        const st = toolStats.get(name) ?? { count: 0, errors: 0, chars: 0 };
        st.count++; toolStats.set(name, st);
        openToolCalls.set(block.id, { name, t });
        const isSpawn = name === 'Task' || name === 'Agent';
        const label = isSpawn
          ? clean(block.input?.description ?? block.input?.prompt ?? 'subagent', 60)
          : clean(block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? block.input?.query ?? block.input?.url ?? '', 80);
        events.push({ t, kind: 'tool_call', tool: name, id: block.id, label, side: sidechain });
        if (isSpawn) {
          subagents.push({ id: block.id, label, type: block.input?.subagent_type ?? 'general', spawnT: t, endT: null });
          events.push({ t, kind: 'spawn', id: block.id, label });
        }
      }
    }
    continue;
  }

  if (line.type === 'user' && line.message) {
    const content = Array.isArray(line.message.content) ? line.message.content : null;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const open = openToolCalls.get(block.tool_use_id);
          const isErr = !!block.is_error;
          let chars = 0;
          if (typeof block.content === 'string') chars = block.content.length;
          else if (Array.isArray(block.content)) for (const c of block.content) chars += (c.text ?? '').length;
          if (open) {
            const st = toolStats.get(open.name);
            if (st) { st.chars += chars; if (isErr) st.errors++; }
            const dur = t - open.t;
            events.push({ t, kind: 'tool_result', tool: open.name, id: block.tool_use_id, chars, err: isErr, dur, side: sidechain });
            const sa = subagents.find(s => s.id === block.tool_use_id);
            if (sa) { sa.endT = t; events.push({ t, kind: 'despawn', id: block.tool_use_id }); }
            openToolCalls.delete(block.tool_use_id);
          }
        } else if (block.type === 'text' && !line.isMeta && !sidechain) {
          userTurns++;
          events.push({ t, kind: 'user', chars: (block.text ?? '').length, preview: clean(block.text) });
        }
      }
    } else if (typeof line.message.content === 'string' && !line.isMeta && !sidechain) {
      userTurns++;
      events.push({ t, kind: 'user', chars: line.message.content.length, preview: clean(line.message.content) });
    }
    continue;
  }
}

// close any dangling subagents at session end
const durS = t0 !== null && tEnd !== null ? (tEnd - t0) / 1000 : 0;
for (const s of subagents) if (s.endT === null) s.endT = durS;

events.sort((a, b) => a.t - b.t);

const result = {
  meta: {
    ...meta,
    startedAt: t0 ? new Date(t0).toISOString() : null,
    durationS: Math.round(durS),
    userTurns, assistantTurns, thinkingBlocks, hookEvents,
    toolCalls: [...toolStats.values()].reduce((a, s) => a + s.count, 0),
    peakContext: contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0),
  },
  tools: Object.fromEntries([...toolStats.entries()].sort((a, b) => b[1].count - a[1].count)),
  contextCurve,
  subagents,
  compactions,
  events,
};

writeFileSync(out, JSON.stringify(result));
const kb = (JSON.stringify(result).length / 1024).toFixed(0);
console.log(`wrote ${out} (${kb} KB) — ${events.length} events, ${result.meta.toolCalls} tool calls, ${subagents.length} subagents, ${compactions.length} compactions, ${Math.round(durS / 60)} min session, peak ctx ${result.meta.peakContext}`);
console.log('tools:', [...toolStats.entries()].map(([n, s]) => `${n}:${s.count}`).join(' '));
