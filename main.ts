// mend: one patch tool for every AI edit format. SPEC.md is the whole contract:
// it applies unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
// V4A patches and JSON tool calls to a tree of text files, changing every file or
// none. Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Matching (SPEC.md section 5) finds old lines O at the first of three tiers with an
// occurrence: tier 0 exact, tier 1 trailing spaces/tabs ignored, tier 2 leading and
// trailing spaces/tabs ignored; `--strict` tries tier 0 only. Context lines are
// written as the file's own matched lines; at tier 2 the other new lines are
// re-indented from O's first line's leading whitespace to the file's.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface Model {
  lines: string[];
  eol: boolean;
  br: string;
}

function toModel(text: string): Model {
  if (text === '') return { lines: [], eol: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, eol, br };
}

function fromModel(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

/** One line compared at a tier (section 5): 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions where O occurs in lines at a tier, at or after `from`; an end-of-file occurrence only when asked. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (section 5), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` line. */
type BodyKind = 'ctx' | 'del' | 'add' | 'esc';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

/** The old lines of a body: its context and `-` lines, in body order. */
function oldLines(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
}

/**
 * The lines a body writes in place of matched lines O at position `pos`: a context
 * line is the file's own matched line; at tier 2 every other line is re-indented
 * from O's first line's leading whitespace to the file's (section 5). With no O
 * (a pure insertion) the `+` lines are written as they are.
 */
function replacementLines(body: BodyLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  if (o.length === 0) {
    for (const b of body) if (b.kind === 'add') out.push(b.text);
    return out;
  }
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0]!);
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi] ?? b.text);
      oi += 1;
    } else if (b.kind === 'del') {
      oi += 1;
    } else if (b.kind === 'add') {
      let line = b.text;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
      out.push(line);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6). */
function lastCtxOrAddHasBackslash(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'esc';
}


/* ---------------- unified diffs (SPEC.md section 6) ---------------- */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  pair: boolean; // a ---/+++ pair named the paths
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function unifiedPath(s: string): string {
  return s.split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path. */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function parseGit(line: string): { old: string; new: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { old: x, new: y };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false; // cur has had no hunk yet: its header is still open
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const blankSection = (): Section => ({
    oldPath: null,
    newPath: null,
    renameOld: null,
    renameNew: null,
    gitOld: null,
    gitNew: null,
    pair: false,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = blankSection();
      cur.gitOld = g.old;
      cur.gitNew = g.new;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripPrefix(unifiedPath(line.slice(4)));
      const newP = stripPrefix(unifiedPath(lines[i + 1]!.slice(4)));
      if (cur !== null && inHeader && !cur.pair) {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        cur.pair = true;
      } else {
        push();
        cur = blankSection();
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        cur.pair = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          j += 1;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'del', text: bl.slice(1) });
          j += 1;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'add', text: bl.slice(1) });
          j += 1;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'esc', text: bl.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index: and any
      // other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  push();

  return sections.map((s) => {
    let oldP: string | null;
    let newP: string | null;
    if (s.pair) {
      oldP = s.oldPath;
      newP = s.newPath;
    } else if (s.renameOld !== null || s.renameNew !== null) {
      oldP = s.renameOld ?? s.gitOld;
      newP = s.renameNew ?? s.gitNew;
    } else {
      oldP = s.gitOld;
      newP = s.gitNew;
    }
    let kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
    if (oldP === null && newP === null) kind = 'noop';
    else if (oldP === null || s.isCreate) kind = newP === null ? 'noop' : 'create';
    else if (newP === null || s.isDelete) kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';

    if (kind === 'noop') return () => {};
    if (kind === 'create') {
      const p = newP!;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noBreak = false;
        for (const h of s.hunks) {
          let lastAdd = -1;
          for (let k = 0; k < h.body.length; k++) if (h.body[k]!.kind === 'add') lastAdd = k;
          if (lastAdd >= 0) noBreak = h.body[lastAdd + 1]?.kind === 'esc';
          for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      };
    }
    if (kind === 'delete') {
      const p = oldP!;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = oldP!;
    const q = kind === 'move' ? newP! : oldP!;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (kind === 'move' && !safe(q)) throw new Fail('unsafe', q);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (kind === 'move' && tree.get(q) !== null) throw new Fail('exists', q);
      const model = toModel(before);
      let d = 0;
      for (const h of s.hunks) {
        const o = oldLines(h.body);
        if (o.length > 0) {
          const found = findTier(model.lines, o, strict, 0, false);
          if (found === null) throw new Fail('no-match', p);
          const target = h.a - 1 + d;
          let pos = found.occ[0]!;
          let best = Math.abs(pos - target);
          for (const cand of found.occ) {
            const dd = Math.abs(cand - target);
            if (dd < best) {
              best = dd;
              pos = cand;
            }
          }
          const rep = replacementLines(h.body, o, model.lines, pos, found.tier);
          const toEnd = pos + o.length === model.lines.length;
          model.lines.splice(pos, o.length, ...rep);
          if (toEnd) model.eol = !lastCtxOrAddHasBackslash(h.body);
          d += rep.length - o.length;
        } else {
          const ins = Math.max(0, Math.min(h.a + d, model.lines.length));
          const rep = replacementLines(h.body, o, model.lines, ins, 0);
          const atEnd = ins === model.lines.length;
          model.lines.splice(ins, 0, ...rep);
          if (atEnd) model.eol = !lastCtxOrAddHasBackslash(h.body);
          d += rep.length;
        }
      }
      const out = fromModel(model);
      if (kind === 'move') {
        tree.now.set(q, out);
        tree.now.set(p, null);
        tree.moves.push([p, q]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let k = i + 1;
    for (; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    let m = sep + 1;
    for (; m < lines.length; m++) {
      const t = lines[m]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = m;
        break;
      }
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, sep), nw: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = toModel(before);
    const found = findTier(model.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const f = leadingWs(model.lines[pos]!);
    const p = leadingWs(b.old[0]!);
    const rep = b.nw.map((line) => {
      if (found.tier !== 2) return line;
      if (line === '' || line.trim() === '') return line;
      if (line.startsWith(p)) return f + line.slice(p.length);
      return line;
    });
    model.lines.splice(pos, b.old.length, ...rep);
    tree.now.set(b.path, fromModel(model));
  });
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface V4aChunk {
  anchor: string | null; // null: no anchor
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();

    if (line.startsWith('*** Add File: ')) {
      const p = line.slice(14).trim();
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl !== '' && !rl.startsWith('+')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const content = raw.map((rl) => (rl === '' ? '' : rl.slice(1)));
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice(17).trim();
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = line.slice(17).trim();
      let idx = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice(13).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let eofSeen = false;
      for (; idx < raw.length; idx++) {
        const rl = raw[idx]!;
        const lineNo = i + 2 + idx;
        if (rl.startsWith('@@')) {
          if (eofSeen) throw new Exit2(`error: parse ${lineNo}`);
          cur = { anchor: rl.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (rl === '*** End of File') {
          if (eofSeen || cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          eofSeen = true;
          cur = null;
          continue;
        }
        if (rl === '' || rl.startsWith(' ') || rl.startsWith('-') || rl.startsWith('+')) {
          if (eofSeen) throw new Exit2(`error: parse ${lineNo}`);
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          const kind: BodyKind = rl === '' || rl[0] === ' ' ? 'ctx' : rl[0] === '-' ? 'del' : 'add';
          cur.body.push({ kind, text: rl === '' ? '' : rl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const model = toModel(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundAt = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              for (let q = cursor; q < model.lines.length; q++) {
                if (normLine(model.lines[q]!, t) === normLine(ch.anchor, t)) {
                  foundAt = q;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          const o = oldLines(ch.body);
          if (o.length > 0) {
            const found = findTier(model.lines, o, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.occ[0]!;
            const rep = replacementLines(ch.body, o, model.lines, pos, found.tier);
            model.lines.splice(pos, o.length, ...rep);
            cursor = pos + rep.length;
          } else {
            const ins = ch.eof ? model.lines.length : cursor;
            const rep = replacementLines(ch.body, o, model.lines, ins, 0);
            model.lines.splice(ins, 0, ...rep);
            cursor = ins + rep.length;
          }
        }
        const out = fromModel(model);
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(p, null);
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

/* ---------------- JSON edits (SPEC.md section 9) ---------------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- invocation, output and exit codes (sections 1, 2, 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // Output rows, in byte order of the paths (UTF-8); a move's row sorts by its new path.
  const rows: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A move's write happens with its pair above: the old path is removed and the new
  // one written when their rows are settled, so write moved files here.
  for (const [oldP, newP] of tree.moves) {
    if (!usedOld.has(oldP) || check) continue;
    rmSync(oldP, { force: true });
    const content = tree.now.get(newP)!;
    mkdirSync(dirname(newP), { recursive: true });
    writeFileSync(newP, content);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
