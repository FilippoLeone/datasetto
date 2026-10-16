import { normalizeRoles } from '../core/roles.js';
import { parseJson, type DB } from '../db/index.js';
import type { RoleName } from '../types.js';

/** Terms beyond this are ignored (bounds the cost of one query). */
export const MAX_SEARCH_TERMS = 8;
/** Longest query accepted, in characters. */
export const MAX_SEARCH_QUERY_LENGTH = 200;
/** Page size bounds for one search call. */
export const SEARCH_DEFAULT_LIMIT = 25;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_MAX_OFFSET = 1000;
/** Tokens around the match in a snippet. */
const SNIPPET_TOKENS = 14;

// Highlight markers used inside snippets. Messages never contain these: the
// message schema strips control characters before anything is stored.
const MARK_START = '\u0001';
const MARK_END = '\u0002';

export interface SnippetPart {
  text: string;
  /** This part matched a search term. */
  match: boolean;
}

export interface SearchHit {
  id: string;
  channelId: string;
  authorId: string | null;
  authorName: string;
  authorAvatarUrl: string | null;
  roles: RoleName[];
  isSuperuser: boolean;
  ts: number;
  snippet: SnippetPart[];
}

export interface SearchParams {
  query: string;
  /** Channels the caller may read; only these are searched. */
  channelIds: readonly string[];
  authorId?: string | null;
  limit?: number;
  offset?: number;
}

export interface SearchPage {
  results: SearchHit[];
  total: number;
  hasMore: boolean;
}

interface HitRow {
  id: string;
  channel_id: string;
  account_id: string | null;
  author_name: string;
  roles: string;
  is_superuser: number;
  created_at: number;
  avatar_url: string | null;
  snippet: string;
}

const TERM_PATTERN = /"([^"]*)"|(\S+)/g;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Turn what the user typed into an FTS5 MATCH expression that can only ever be
 * a conjunction of phrases. Every term is emitted as a quoted string (inner
 * quotes cannot survive: only letters and digits are kept), so FTS operators
 * (AND, OR, NOT, NEAR), column filters (`col:`), parentheses, `^`, `+`, `-` and
 * stray quotes are matched as plain words or dropped. Text inside double quotes
 * stays one phrase; the last unquoted term matches as a prefix so results show
 * up while typing. Returns null when nothing searchable is left.
 */
export const compileFtsQuery = (raw: string): string | null => {
  const matches = Array.from(raw.slice(0, MAX_SEARCH_QUERY_LENGTH).matchAll(TERM_PATTERN));
  const clauses: string[] = [];
  matches.forEach((match, index) => {
    const quoted = match[1] !== undefined;
    const words = (match[1] ?? match[2] ?? '').match(WORD_PATTERN) ?? [];
    if (words.length === 0) return;
    const phrase = '"' + words.join(' ') + '"';
    const last = index === matches.length - 1;
    clauses.push(!quoted && last ? phrase + '*' : phrase);
  });
  if (clauses.length === 0) return null;
  return clauses.slice(0, MAX_SEARCH_TERMS).join(' ');
};

/** Split a snippet with highlight markers into plain and matching parts. */
export const parseSnippet = (raw: string): SnippetPart[] => {
  const parts: SnippetPart[] = [];
  let buffer = '';
  let inMatch = false;
  const flush = () => {
    if (buffer) parts.push({ text: buffer, match: inMatch });
    buffer = '';
  };
  for (const char of raw) {
    if (char === MARK_START) {
      flush();
      inMatch = true;
    } else if (char === MARK_END) {
      flush();
      inMatch = false;
    } else {
      buffer += char;
    }
  }
  flush();
  return parts;
};

/**
 * Full-text search over `messages` through the FTS5 index of migration 9. The
 * caller decides which channels may be searched; this class never looks at
 * permissions itself.
 */
export class SearchService {
  private readonly stmts;

  constructor(db: DB) {
    // Both statements share the WHERE clause; keep them in step.
    const where = `
      WHERE messages_fts MATCH @match
        AND m.deleted_at IS NULL
        AND m.channel_id IN (SELECT value FROM json_each(@channels))
        AND (@author IS NULL OR m.account_id = @author)
    `;
    this.stmts = {
      hits: db.prepare(`
        SELECT m.id, m.channel_id, m.account_id, m.author_name, m.roles, m.is_superuser, m.created_at,
               a.avatar_url,
               snippet(messages_fts, 0, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS snippet
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        LEFT JOIN accounts a ON a.id = m.account_id
        ${where}
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT @limit OFFSET @offset
      `),
      count: db.prepare(`
        SELECT COUNT(*) AS n
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        ${where}
      `),
    };
  }

  search(params: SearchParams): SearchPage {
    const match = compileFtsQuery(params.query);
    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? SEARCH_DEFAULT_LIMIT)), SEARCH_MAX_LIMIT);
    const offset = Math.min(Math.max(0, Math.trunc(params.offset ?? 0)), SEARCH_MAX_OFFSET);
    if (!match || params.channelIds.length === 0) return { results: [], total: 0, hasMore: false };

    const bind = {
      match,
      channels: JSON.stringify(params.channelIds),
      author: params.authorId ?? null,
      limit,
      offset,
    };
    const rows = this.stmts.hits.all(bind) as HitRow[];
    const total = Number((this.stmts.count.get(bind) as { n: number }).n);
    return {
      results: rows.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        authorId: row.account_id,
        authorName: row.author_name,
        authorAvatarUrl: row.avatar_url,
        roles: normalizeRoles(parseJson<string[]>(row.roles, [])),
        isSuperuser: Boolean(row.is_superuser),
        ts: row.created_at,
        snippet: parseSnippet(row.snippet),
      })),
      total,
      hasMore: offset + rows.length < total,
    };
  }
}
