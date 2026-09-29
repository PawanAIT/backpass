import path from "node:path";

import { emptyInteractionSignals, interactionSignals } from "../../interaction.js";
import { SELF_SESSION_SENTINEL } from "../../sentinel.js";
import { home, listDirs, readJsonFile, statOrNull } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * opencode: ~/.local/share/opencode/opencode.db (sqlite)
 *
 *   project(id, worktree)             - one row per project root
 *   session(id, project_id, directory, title, time_created)
 *   message(id, session_id, data)     - data is JSON: {role, model, time, ...}
 *   part(id, message_id, session_id, data) - data is JSON: {type: text|tool|reasoning|...}
 *
 * Listing returns `session.directory`, deleted worktrees included, for the caller's
 * shared association tiers. Older opencode versions used file storage under `storage/`;
 * that layout is handled as a fallback so long-lived machines still yield transcripts.
 *
 * acpx drives opencode, so backpass's own analysis and synthesis calls land in this
 * store under the repo's cwd. There is no transcript file for `../self.js` to read, so
 * the listing query reads each session's first user text part and the row is marked
 * `self` when it opens with the sentinel every backpass prompt starts with. Ancestors
 * are checked without the listing cutoff so delegated work cannot re-enter the corpus
 * when its backpass-originated parent ages out of the discovery window. A session
 * with no messages at all, such as the one each agent probe creates, is not listed.
 */

export const name = "opencode";
export const sqliteBacked = true;

export function storeRoot() {
  return home(".local", "share", "opencode");
}

export function dbPath() {
  return path.join(storeRoot(), "opencode.db");
}

function tableHasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function hasTables(db, ...names) {
  const check = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  return names.every((name) => check.get(name) !== undefined);
}

/** The earliest user text part, skipping malformed JSON and non-text parts. */
const FIRST_USER_PART = `(SELECT pt.data
     FROM message m
     JOIN part pt ON pt.message_id = m.id
    WHERE m.session_id = s.id
      AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'user'
      AND CASE WHEN json_valid(pt.data) THEN json_extract(pt.data, '$.type') END = 'text'
    ORDER BY m.time_created, m.id, pt.id
    LIMIT 1)`;

export async function discover({ cutoffMs }) {
  const db = await openReadOnly(dbPath());
  if (!db) return legacyDiscover({ cutoffMs });

  try {
    const parentSelect = tableHasColumn(db, "session", "parent_id") ? ", s.parent_id AS parent_id" : "";
    const firstUserSelect = hasTables(db, "message", "part") ? `, ${FIRST_USER_PART} AS first_user_part` : "";
    // Unused probes have no messages; attachment conversations need not have user text.
    const recordedFilter = hasTables(db, "message")
      ? " AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)"
      : "";
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.directory AS directory, s.title AS title,
                s.time_created AS time_created, s.time_updated AS time_updated,
                p.worktree AS worktree${parentSelect}${firstUserSelect}
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id
          WHERE (? IS NULL OR s.time_updated >= ?)${recordedFilter}`,
      )
      .all(cutoffMs ?? null, cutoffMs ?? 0);

    const ancestorParts =
      parentSelect && firstUserSelect
        ? db.prepare(`WITH RECURSIVE ancestors(id) AS (
            VALUES (?)
            UNION
            SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id
             WHERE s.parent_id IS NOT NULL
          )
          SELECT ${FIRST_USER_PART} AS first_user_part
            FROM session s JOIN ancestors a ON s.id = a.id`)
        : null;

    return rows.map((row) => ({
      key: `opencode:${row.id}`,
      id: row.id,
      path: dbPath(),
      cwd: row.directory,
      gitRoot: row.worktree || null,
      gitBranch: null,
      remotes: [],
      title: row.title || null,
      startedAt: Number(row.time_created) || null,
      mtimeMs: Number(row.time_updated) || Number(row.time_created) || 0,
      bytes: 0,
      model: null,
      extra: { sessionId: row.id },
      interactionSignals: row.parent_id ? interactionSignals({ parentId: row.parent_id }) : emptyInteractionSignals(),
      self:
        opensWithSentinel(safeJsonParse(row.first_user_part)?.text) ||
        Boolean(
          row.parent_id &&
          ancestorParts
            ?.all(row.parent_id)
            .some((ancestor) => opensWithSentinel(safeJsonParse(ancestor.first_user_part)?.text)),
        ),
    }));
  } finally {
    db.close();
  }
}

function opensWithSentinel(text) {
  return typeof text === "string" && text.startsWith(SELF_SESSION_SENTINEL);
}

export async function read(ref) {
  const db = await openReadOnly(dbPath());
  if (!db) return legacyRead();

  try {
    const sessionId = ref.extra?.sessionId || ref.id;
    const messages = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionId);
    const parts = db
      .prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionId);

    const partsByMessage = new Map();
    for (const part of parts) {
      if (!partsByMessage.has(part.message_id)) partsByMessage.set(part.message_id, []);
      partsByMessage.get(part.message_id).push(safeJsonParse(part.data));
    }

    const events = [];
    let model = null;

    for (const message of messages) {
      const data = safeJsonParse(message.data) || {};
      const role = data.role === "user" ? "user" : "assistant";
      model = model || data.modelID || data.model?.modelID || null;

      const texts = [];
      for (const part of partsByMessage.get(message.id) || []) {
        if (!part) continue;
        if (part.type === "text" && part.text) {
          texts.push(part.text);
        } else if (part.type === "tool") {
          events.push({
            kind: "tool",
            name: part.tool || part.name,
            input: part.state?.input ?? part.input,
            result: part.state?.output ?? part.output,
            status: part.state?.status,
          });
        }
        // reasoning / step-start / step-finish / patch / file parts carry no loss signal.
      }
      if (texts.length) events.push({ kind: "message", role, text: texts.join("\n") });
    }

    return { events, model };
  } finally {
    db.close();
  }
}

/** Pre-sqlite opencode kept JSON files under storage/. Best-effort, never fatal. */
function legacyDiscover({ cutoffMs }) {
  const projectsDir = path.join(storeRoot(), "storage", "project");
  const out = [];
  for (const dir of listDirs(projectsDir)) {
    const meta = readJsonFile(path.join(dir, "project.json"));
    const stat = statOrNull(dir);
    if (!meta?.worktree || !stat) continue;
    if (cutoffMs && stat.mtimeMs < cutoffMs) continue;
    out.push({
      key: `opencode-legacy:${dir}`,
      id: path.basename(dir),
      path: dir,
      cwd: meta.worktree,
      remotes: [],
      startedAt: stat.birthtimeMs || stat.mtimeMs,
      mtimeMs: stat.mtimeMs,
      bytes: 0,
      extra: { legacy: true },
      interactionSignals: emptyInteractionSignals(),
    });
  }
  return out;
}

function legacyRead() {
  // The legacy layout stores messages per project in a shape that changed across
  // releases; rather than guess, report an empty trace so the run stays fail-soft.
  return { events: [], model: null };
}
