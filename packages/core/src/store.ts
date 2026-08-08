import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  byRank,
  incomingWins,
  type Card,
  type ChangeSet,
  type Column,
  type EntityKind,
  type Repo,
} from "@kybird/shared";

/**
 * 로컬 스토어.
 *
 * 서버가 진실이지만 이건 캐시가 아니라 **작업 사본**이다. 오프라인에서
 * 여기에 쓰고, 나중에 서버로 밀어올린다.
 *
 * 마크다운이 아니라 SQLite 인 이유는 brief.md 4장 참고 — 마크다운을 싱크
 * 단위로 삼으면 seed 문서에 기록된 그 지옥이 재현된다. 사람이 읽을 마크다운은
 * 여기서 뽑아내는 export 다.
 *
 * 외래키를 켜지 않는다. pull 이 페이지 단위로 쪼개지면 카드가 자기 컬럼보다
 * 먼저 도착할 수 있는데, 그때마다 실패하면 동기화가 진행되지 않는다.
 * 무결성은 서버가 지킨다.
 */

/** `columns` 는 SQL 예약어와 헷갈리기 쉬워서 테이블명을 따로 둔다. */
const TABLE: Record<EntityKind, string> = {
  repos: "repos",
  columns: "board_columns",
  cards: "cards",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  path      TEXT,
  gitRemote TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS board_columns (
  id        TEXT PRIMARY KEY,
  repoId    TEXT NOT NULL,
  title     TEXT NOT NULL,
  rank      TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id        TEXT PRIMARY KEY,
  repoId    TEXT NOT NULL,
  columnId  TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL DEFAULT '',
  rank      TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

/*
 * LWW 에서 진 로컬 값을 여기 남긴다.
 * 혼자 쓰는 시스템이라 드물지만, 드물게 일어나는 일이 조용히 사라지는 게
 * 제일 나쁘다. brief.md 4장.
 */
CREATE TABLE IF NOT EXISTS conflicts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,
  entityId  TEXT NOT NULL,
  reason    TEXT NOT NULL,
  payload   TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_columns_repo ON board_columns(repoId);
CREATE INDEX IF NOT EXISTS idx_cards_repo    ON cards(repoId);
CREATE INDEX IF NOT EXISTS idx_cards_column  ON cards(columnId);
CREATE INDEX IF NOT EXISTS idx_repos_dirty   ON repos(dirty);
CREATE INDEX IF NOT EXISTS idx_columns_dirty ON board_columns(dirty);
CREATE INDEX IF NOT EXISTS idx_cards_dirty   ON cards(dirty);
`;

type Row = Record<string, unknown>;

export type ConflictRecord = {
  id: number;
  kind: EntityKind;
  entityId: string;
  reason: string;
  payload: string;
  createdAt: number;
};

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 여러 쓰기를 한 트랜잭션으로 묶는다. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- meta ----

  get cursor(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  set cursor(value: number) {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('cursor', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(value));
  }

  /**
   * 스토어를 비운다. 로그아웃하거나 다른 계정으로 갈아탈 때 쓴다 —
   * 커서만 0으로 돌리면 남의 데이터가 섞인다.
   */
  reset(): void {
    this.transaction(() => {
      for (const table of Object.values(TABLE)) this.db.prepare(`DELETE FROM ${table}`).run();
      this.db.prepare("DELETE FROM conflicts").run();
      this.db.prepare("DELETE FROM meta").run();
    });
  }

  // ---- 읽기 ----

  getRepo(id: string): Repo | null {
    return this.one<Repo>("repos", id);
  }

  getColumn(id: string): Column | null {
    return this.one<Column>("columns", id);
  }

  getCard(id: string): Card | null {
    return this.one<Card>("cards", id);
  }

  private one<T>(kind: EntityKind, id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? (strip(row) as T) : null;
  }

  /** 살아있는(삭제되지 않은) 레포 전부. */
  listRepos(): Repo[] {
    const rows = this.db
      .prepare("SELECT * FROM repos WHERE deletedAt IS NULL ORDER BY name")
      .all() as Row[];
    return rows.map((r) => strip(r) as Repo);
  }

  listColumns(repoId: string): Column[] {
    const rows = this.db
      .prepare("SELECT * FROM board_columns WHERE repoId = ? AND deletedAt IS NULL")
      .all(repoId) as Row[];
    return (rows.map((r) => strip(r) as Column)).sort(byRank);
  }

  listCards(columnId: string): Card[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE columnId = ? AND deletedAt IS NULL")
      .all(columnId) as Row[];
    return (rows.map((r) => strip(r) as Card)).sort(byRank);
  }

  listCardsByRepo(repoId: string): Card[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE repoId = ? AND deletedAt IS NULL")
      .all(repoId) as Row[];
    return (rows.map((r) => strip(r) as Card)).sort(byRank);
  }

  // ---- 로컬 쓰기 (dirty 로 표시된다) ----

  putRepo(repo: Repo): void {
    this.db
      .prepare(
        `INSERT INTO repos (id, name, path, gitRemote, updatedAt, deletedAt, dirty)
         VALUES (@id, @name, @path, @gitRemote, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, path = excluded.path, gitRemote = excluded.gitRemote,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(repo);
  }

  putColumn(column: Column): void {
    this.db
      .prepare(
        `INSERT INTO board_columns (id, repoId, title, rank, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @title, @rank, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, title = excluded.title, rank = excluded.rank,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(column);
  }

  putCard(card: Card): void {
    this.db
      .prepare(
        `INSERT INTO cards (id, repoId, columnId, title, body, rank, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @columnId, @title, @body, @rank, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, columnId = excluded.columnId, title = excluded.title,
           body = excluded.body, rank = excluded.rank, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(card);
  }

  // ---- 동기화용 ----

  /** 아직 서버에 못 올린 로컬 변경분. */
  pending(): ChangeSet {
    const dirty = <T>(kind: EntityKind): T[] =>
      (this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE dirty = 1`).all() as Row[]).map(
        (r) => strip(r) as T,
      );
    return {
      repos: dirty<Repo>("repos"),
      columns: dirty<Column>("columns"),
      cards: dirty<Card>("cards"),
    };
  }

  /**
   * 밀어올리기에 성공한 행의 dirty 를 내린다.
   *
   * `updatedAt` 을 같이 대조하는 게 핵심이다 — 네트워크 왕복 중에 사용자가
   * 같은 행을 또 고쳤다면 그 편집은 아직 안 올라간 것이므로 dirty 를
   * 내리면 안 된다.
   */
  clearDirty(kind: EntityKind, id: string, pushedUpdatedAt: number): void {
    this.db
      .prepare(`UPDATE ${TABLE[kind]} SET dirty = 0 WHERE id = ? AND updatedAt = ?`)
      .run(id, pushedUpdatedAt);
  }

  /**
   * 서버에서 받은 행을 반영한다.
   *
   * 로컬이 dirty 이고 LWW 에서 이기면 덮어쓰지 않는다 — 다음 push 때
   * 올라갈 값이라 여기서 뭉개면 사용자 편집이 사라진다.
   */
  applyRemote(kind: EntityKind, incoming: Repo | Column | Card): "applied" | "kept-local" {
    const existing = this.one<Repo | Column | Card>(kind, incoming.id);
    if (existing) {
      const localDirty = this.isDirty(kind, incoming.id);
      if (localDirty && !incomingWins(incoming, existing)) return "kept-local";
    }

    const write = { ...incoming } as Row;
    const columns = Object.keys(write);
    const placeholders = columns.map((c) => `@${c}`).join(", ");
    const updates = columns.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
    this.db
      .prepare(
        `INSERT INTO ${TABLE[kind]} (${columns.join(", ")}, dirty)
         VALUES (${placeholders}, 0)
         ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}, dirty = 0`,
      )
      .run(write);
    return "applied";
  }

  isDirty(kind: EntityKind, id: string): boolean {
    const row = this.db.prepare(`SELECT dirty FROM ${TABLE[kind]} WHERE id = ?`).get(id) as
      | { dirty: number }
      | undefined;
    return row?.dirty === 1;
  }

  // ---- 충돌 보관 ----

  recordConflict(kind: EntityKind, entityId: string, reason: string, payload: unknown): void {
    this.db
      .prepare(
        "INSERT INTO conflicts (kind, entityId, reason, payload, createdAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(kind, entityId, reason, JSON.stringify(payload), Date.now());
  }

  listConflicts(): ConflictRecord[] {
    return this.db
      .prepare("SELECT * FROM conflicts ORDER BY createdAt DESC")
      .all() as ConflictRecord[];
  }

  clearConflicts(): void {
    this.db.prepare("DELETE FROM conflicts").run();
  }
}

/** 로컬 전용 컬럼(`dirty`)을 떼어내 프로토콜 모양으로 되돌린다. */
function strip(row: Row): Row {
  const { dirty: _dirty, ...rest } = row;
  return rest;
}
