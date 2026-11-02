import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { parseEvent, type RuntimeEvent } from "@hina/core";
import {
  type MessageLogEntry,
  type MessageLogPage,
  type MessageLogQuery,
  type MessageProcessing,
  parseLogQuery,
  parseProcessing,
} from "@hina/logs";

export interface MessageLogStore {
  append(event: RuntimeEvent): void;
  query(query: MessageLogQuery): MessageLogPage;
  find(sequence: number): MessageLogEntry | undefined;
  subscribe(listener: () => void): () => void;
  recordProcessing(event: RuntimeEvent, processing: MessageProcessing): void;
  close(): void;
}

interface StoredMessage {
  sequence: number;
  received_at: string;
  event_json: string;
  processing_json: string | null;
  processing_version: number;
}

function privateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("消息日志必须是私有普通文件");
}

export class SQLiteMessageLogStore implements MessageLogStore {
  private readonly db: Database;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    path: string,
    readonly capacity = 10_000,
    private readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw new RangeError("消息日志容量无效");
    if (path !== ":memory:") privateFile(path);
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 1000");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      if (!version || ![0, 1, 2].includes(version.user_version))
        throw new Error("消息日志版本不受支持");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          account TEXT NOT NULL,
          conversation TEXT NOT NULL,
          event_id TEXT NOT NULL,
          category TEXT NOT NULL,
          content_kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          text TEXT NOT NULL,
          received_at TEXT NOT NULL,
          event_json TEXT NOT NULL,
          UNIQUE(channel, account, conversation, event_id)
        );
        CREATE INDEX IF NOT EXISTS messages_source ON messages(channel, sequence);
        CREATE INDEX IF NOT EXISTS messages_category ON messages(category, sequence);
      `);
      if (version.user_version < 2)
        this.db.transaction(() => {
          this.db.exec("ALTER TABLE messages ADD COLUMN processing_json TEXT");
          this.db.exec(
            "ALTER TABLE messages ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 0",
          );
          this.db.exec("PRAGMA user_version = 2");
        })();
      this.prune();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  append(input: RuntimeEvent): void {
    const event = parseEvent(input);
    const receivedAt = new Date(this.now()).toISOString();
    const inserted = this.db.transaction(() => {
      const result = this.db
        .query(`
        INSERT INTO messages(channel, account, conversation, event_id, category, content_kind, actor, text, received_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, account, conversation, event_id) DO NOTHING
      `)
        .run(
          event.origin.channelId,
          event.origin.accountId,
          event.conversationId,
          event.id,
          event.conversationType ?? "unknown",
          event.content.type === "text" ? "text" : event.content.text.trim() ? "mixed" : "image",
          event.actorId,
          event.content.text,
          receivedAt,
          JSON.stringify(event),
        );
      if (result.changes > 0) this.prune();
      return result.changes > 0;
    })();
    if (inserted) for (const listener of this.listeners) listener();
  }

  private prune(): void {
    this.db
      .query(`DELETE FROM messages WHERE sequence NOT IN (
      SELECT sequence FROM messages ORDER BY sequence DESC LIMIT ?
    )`)
      .run(this.capacity);
  }

  query(input: MessageLogQuery): MessageLogPage {
    // 即使由进程内调用，也复用 HTTP 的边界约束，避免无界查询。
    const params = new URLSearchParams(
      Object.entries(input).map(([key, value]) => [key, String(value)]),
    );
    const query = parseLogQuery(params);
    return this.db.transaction(() => {
      const latest =
        this.db
          .query<{ value: number }, []>("SELECT COALESCE(MAX(sequence), 0) AS value FROM messages")
          .get()?.value ?? 0;
      const snapshot = Math.min(query.snapshot ?? latest, latest);
      const escapedSearch = query.search.replace(/[\\%_]/g, "\\$&");
      const filter = `(? = '' OR channel = ?) AND (? = 'all' OR category = ?) AND (? = 'all' OR content_kind = ? OR (? = 'media' AND content_kind IN ('image', 'mixed'))) AND (
        ? = '' OR text LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\'
        OR conversation LIKE ? ESCAPE '\\' OR event_id LIKE ? ESCAPE '\\')`;
      const values = [
        query.channel,
        query.channel,
        query.category,
        query.category,
        query.contentType,
        query.contentType,
        query.contentType,
        query.search,
        ...Array.from({ length: 4 }, () => `%${escapedSearch}%`),
      ];
      const count = (condition: string, args: (string | number)[]) =>
        this.db
          .query<{ value: number }, (string | number)[]>(
            `SELECT COUNT(*) AS value FROM messages WHERE ${condition}`,
          )
          .get(...args)?.value ?? 0;
      const matchedCount = count(`sequence <= ? AND ${filter}`, [snapshot, ...values]);
      const newCount = count(`sequence > ? AND ${filter}`, [snapshot, ...values]);
      const pageCount = Math.max(1, Math.ceil(matchedCount / query.pageSize));
      const page = Math.min(query.page, pageCount);
      const rows = this.db
        .query<StoredMessage, (string | number)[]>(`
        SELECT sequence, received_at, event_json, processing_json, processing_version FROM messages WHERE sequence <= ? AND ${filter}
        ORDER BY sequence DESC LIMIT ? OFFSET ?
      `)
        .all(snapshot, ...values, query.pageSize, (page - 1) * query.pageSize);
      const messages = rows.map((row) => this.entry(row));
      return {
        messages,
        matchedCount,
        retainedCount: count("1 = 1", []),
        newCount,
        snapshot,
        page,
        pageSize: query.pageSize,
        pageCount,
        capacity: this.capacity,
        channels: this.db
          .query<{ channel: string }, []>(
            "SELECT DISTINCT channel FROM messages ORDER BY channel LIMIT 100",
          )
          .all()
          .map((row) => row.channel),
      };
    })();
  }

  find(sequence: number): MessageLogEntry | undefined {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError("消息序号无效");
    const row = this.db
      .query<StoredMessage, [number]>(
        "SELECT sequence, received_at, event_json, processing_json, processing_version FROM messages WHERE sequence = ?",
      )
      .get(sequence);
    return row ? this.entry(row) : undefined;
  }

  private entry(row: StoredMessage): MessageLogEntry {
    const event = parseEvent(JSON.parse(row.event_json));
    const received = parseEvent({ ...event, timestamp: row.received_at });
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1)
      throw new Error("消息日志序号损坏");
    if (!Number.isSafeInteger(row.processing_version) || row.processing_version < 0)
      throw new Error("消息处理版本损坏");
    return {
      ...event,
      sequence: row.sequence,
      receivedAt: received.timestamp,
      processingVersion: row.processing_version,
      ...(row.processing_json === null
        ? {}
        : { processing: parseProcessing(JSON.parse(row.processing_json)) }),
    };
  }

  recordProcessing(event: RuntimeEvent, processing: MessageProcessing): void {
    const result = this.db
      .query(
        "UPDATE messages SET processing_json = ?, processing_version = processing_version + 1 WHERE channel = ? AND account = ? AND conversation = ? AND event_id = ?",
      )
      .run(
        JSON.stringify(parseProcessing(processing)),
        event.origin.channelId,
        event.origin.accountId,
        event.conversationId,
        event.id,
      );
    if (result.changes > 0) for (const listener of this.listeners) listener();
  }

  interruptPending(): void {
    const rows = this.db
      .query<StoredMessage, []>(
        "SELECT sequence, received_at, event_json, processing_json, processing_version FROM messages WHERE processing_json IS NOT NULL",
      )
      .all();
    for (const row of rows) {
      const entry = this.entry(row);
      const processing = entry.processing;
      if (
        !processing ||
        !["deciding", "generating", "generated", "sending"].includes(processing.status)
      )
        continue;
      this.recordProcessing(entry, {
        status: "failed",
        stage:
          processing.status === "sending"
            ? "send"
            : processing.status === "generated"
              ? "policy"
              : processing.status === "deciding"
                ? "decision"
                : "model",
        code: processing.status === "sending" ? "delivery_unconfirmed" : "interrupted",
        ...("response" in processing ? { response: processing.response } : {}),
        ...(processing.decision ? { decision: processing.decision } : {}),
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.db.close();
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error("消息日志已关闭");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
