// session-parser.mjs — incremental Claude Code session JSONL parser.
// Shared by the batch CLI (parse-session.mjs) and the live tail server.
// feed(line) returns an ordered array of viz items:
//   events   — same shapes the viz consumes (kind: user|say|thinking|tool_call|
//              tool_result|spawn|despawn|compaction|hook|queued)
//   ctx      — {kind:'ctx', t, ctx, cacheRead, cacheWrite, fresh, out}
// Aggregates (tools, meta, counters) accumulate on the instance.

const clean = (s, n = 96) => {
  if (typeof s !== 'string') return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

export class SessionParser {
  constructor(sessionId) {
    this.meta = { sessionId, cwd: null, model: null, version: null };
    this.toolStats = new Map();
    this.openToolCalls = new Map();
    this.subagents = [];
    this.t0 = null;
    this.tEnd = null;
    this.lastT = 0;
    this.userTurns = 0; this.assistantTurns = 0; this.thinkingBlocks = 0; this.hookEvents = 0;
  }

  rel(ms) { return (ms - this.t0) / 1000; }

  /** parse one raw JSONL line; returns ordered viz items (possibly empty) */
  feed(raw) {
    if (!raw || !raw.trim()) return [];
    let line;
    try { line = JSON.parse(raw); } catch { return []; }
    const ms = Date.parse(line.timestamp ?? '');
    if (!Number.isNaN(ms)) { if (this.t0 === null) this.t0 = ms; this.tEnd = ms; }
    if (this.t0 === null) return [];
    const t = !Number.isNaN(ms) ? this.rel(ms) : this.lastT;
    this.lastT = t;
    if (line.cwd && !this.meta.cwd) this.meta.cwd = line.cwd;
    if (line.version && !this.meta.version) this.meta.version = line.version;

    const out = [];
    const sidechain = !!line.isSidechain;

    if (line.type === 'queue-operation') {
      if (line.operation === 'enqueue') out.push({ t, kind: 'queued', preview: clean(line.content) });
      return out;
    }

    if (line.type === 'summary' || line.isCompactSummary ||
        (line.type === 'system' && /compact/i.test(line.subtype ?? ''))) {
      out.push({ t, kind: 'compaction' });
      return out;
    }

    if (line.type === 'attachment' && line.attachment?.hookEvent) {
      this.hookEvents++;
      out.push({ t, kind: 'hook', name: line.attachment.hookName ?? line.attachment.hookEvent, err: (line.attachment.exitCode ?? 0) !== 0 });
      return out;
    }

    if (line.type === 'assistant' && line.message) {
      const m = line.message;
      if (m.model && !this.meta.model) this.meta.model = m.model;
      const u = m.usage;
      if (u && !sidechain) {
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const fresh = u.input_tokens ?? 0;
        out.push({ kind: 'ctx', t, ctx: cacheRead + cacheWrite + fresh, cacheRead, cacheWrite, fresh, out: u.output_tokens ?? 0 });
      }
      const content = Array.isArray(m.content) ? m.content : [];
      let counted = false;
      for (const block of content) {
        if (block.type === 'thinking') {
          this.thinkingBlocks++;
          out.push({ t, kind: 'thinking', chars: (block.thinking ?? '').length, side: sidechain });
        } else if (block.type === 'text') {
          if (!counted && !sidechain) { this.assistantTurns++; counted = true; }
          out.push({ t, kind: 'say', chars: (block.text ?? '').length, preview: clean(block.text), side: sidechain });
        } else if (block.type === 'tool_use') {
          const name = block.name ?? '?';
          const st = this.toolStats.get(name) ?? { count: 0, errors: 0, chars: 0 };
          st.count++; this.toolStats.set(name, st);
          this.openToolCalls.set(block.id, { name, t });
          const isSpawn = name === 'Task' || name === 'Agent';
          const label = isSpawn
            ? clean(block.input?.description ?? block.input?.prompt ?? 'subagent', 60)
            : clean(block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? block.input?.query ?? block.input?.url ?? '', 80);
          out.push({ t, kind: 'tool_call', tool: name, id: block.id, label, side: sidechain });
          if (isSpawn) {
            this.subagents.push({ id: block.id, label, type: block.input?.subagent_type ?? 'general', spawnT: t, endT: null });
            out.push({ t, kind: 'spawn', id: block.id, label, type: block.input?.subagent_type ?? 'general' });
          }
        }
      }
      return out;
    }

    if (line.type === 'user' && line.message) {
      const content = Array.isArray(line.message.content) ? line.message.content : null;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const open = this.openToolCalls.get(block.tool_use_id);
            const isErr = !!block.is_error;
            let chars = 0;
            if (typeof block.content === 'string') chars = block.content.length;
            else if (Array.isArray(block.content)) for (const c of block.content) chars += (c.text ?? '').length;
            if (open) {
              const st = this.toolStats.get(open.name);
              if (st) { st.chars += chars; if (isErr) st.errors++; }
              out.push({ t, kind: 'tool_result', tool: open.name, id: block.tool_use_id, chars, err: isErr, dur: t - open.t, side: sidechain });
              const sa = this.subagents.find(s => s.id === block.tool_use_id);
              if (sa) { sa.endT = t; out.push({ t, kind: 'despawn', id: block.tool_use_id }); }
              this.openToolCalls.delete(block.tool_use_id);
            }
          } else if (block.type === 'text' && !line.isMeta && !sidechain) {
            this.userTurns++;
            out.push({ t, kind: 'user', chars: (block.text ?? '').length, preview: clean(block.text) });
          }
        }
      } else if (typeof line.message.content === 'string' && !line.isMeta && !sidechain) {
        this.userTurns++;
        out.push({ t, kind: 'user', chars: line.message.content.length, preview: clean(line.message.content) });
      }
      return out;
    }

    return out;
  }

  durationS() {
    return this.t0 !== null && this.tEnd !== null ? (this.tEnd - this.t0) / 1000 : 0;
  }

  snapshotMeta() {
    return {
      ...this.meta,
      startedAt: this.t0 ? new Date(this.t0).toISOString() : null,
      durationS: Math.round(this.durationS()),
      userTurns: this.userTurns, assistantTurns: this.assistantTurns,
      thinkingBlocks: this.thinkingBlocks, hookEvents: this.hookEvents,
      toolCalls: [...this.toolStats.values()].reduce((a, s) => a + s.count, 0),
    };
  }

  toolsObject() {
    return Object.fromEntries([...this.toolStats.entries()].sort((a, b) => b[1].count - a[1].count));
  }
}

export const cleanPreview = clean;
