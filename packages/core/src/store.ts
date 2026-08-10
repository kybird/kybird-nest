import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  byRank,
  incomingWins,
  type Card,
  type ChangeSet,
  type Column,
  type Embedding,
  type EntityKind,
  type Repo,
  type SearchLog,
  type WikiEntry,
} from "@kybird/shared";

/** 동기화되는 모든 엔티티의 합집합. */
export type SyncableEntity = Repo | Column | Card | WikiEntry | Embedding | SearchLog;

/** 검색 결과 한 건 — 엔트리 id 와 점수. 본문은 호출부가 따로 꺼낸다. */
export type ScoredId = { id: string; score: number };

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
  wikiEntries: "wiki_entries",
  embeddings: "embeddings",
  searchLogs: "search_logs",
};

/**
 * 프로토콜에서는 문자열 배열인데 SQLite 에는 JSON 문자열로 넣는 필드들.
 * 스토어 경계에서만 변환하고 그 밖에서는 항상 배열로 다룬다.
 */
const LIST_FIELDS: Partial<Record<EntityKind, readonly string[]>> = {
  wikiEntries: ["tags"],
  searchLogs: ["resultIds", "usedIds"],
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
  isDone    INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,
  repoId       TEXT NOT NULL,
  columnId     TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  rank         TEXT NOT NULL,
  completedAt  INTEGER,
  regressCount INTEGER NOT NULL DEFAULT 0,
  updatedAt    INTEGER NOT NULL,
  deletedAt    INTEGER,
  dirty        INTEGER NOT NULL DEFAULT 0
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

/*
 * wiki 엔트리. repoId 가 NULL 이면 프로젝트 독립 지식이다.
 */
CREATE TABLE IF NOT EXISTS wiki_entries (
  id        TEXT PRIMARY KEY,
  repoId    TEXT,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  tags      TEXT NOT NULL DEFAULT '[]',
  sourceRef TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS embeddings (
  id        TEXT PRIMARY KEY,
  entryId   TEXT NOT NULL,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vector    TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS search_logs (
  id        TEXT PRIMARY KEY,
  repoId    TEXT,
  query     TEXT NOT NULL,
  scope     TEXT NOT NULL,
  strategy  TEXT NOT NULL,
  model     TEXT,
  resultIds TEXT NOT NULL DEFAULT '[]',
  usedIds   TEXT NOT NULL DEFAULT '[]',
  tookMs    INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0
);

/*
 * 키워드 검색용 전문 인덱스.
 *
 * 본문을 중복 저장하지 않으려고 content-less 로 만든다 — 검색은 rowid 만
 * 돌려주고 실제 행은 wiki_entries 에서 꺼낸다. 인덱스는 파생물이라
 * 동기화하지 않고 각 머신이 자기 것을 만든다.
 */
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'unicode61'
);

/*
 * 아직 지식으로 소화되지 않은 커밋들.
 *
 * git hook 이 여기에 넣기만 하고 즉시 끝낸다 — 훅에서 LLM 을 부르면
 * 커밋이 느려지고, 느려지면 --no-verify 로 꺼버리게 된다.
 *
 * 이 큐는 **동기화하지 않는다.** 커밋은 이 머신의 클론에만 있고, 다른
 * 머신에서 같은 해시를 소화하려 해도 그쪽 작업 디렉토리를 봐야 한다.
 */
CREATE TABLE IF NOT EXISTS ingest_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repoId      TEXT NOT NULL,
  repoPath    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  processedAt INTEGER,
  -- kind 를 키에 넣으면 post-commit 과 pre-push 가 같은 커밋을 두 번 올린다.
  -- 소화 단위는 커밋이지 훅이 아니다.
  UNIQUE(repoId, ref)
);

CREATE INDEX IF NOT EXISTS idx_queue_pending ON ingest_queue(repoId, processedAt);
CREATE INDEX IF NOT EXISTS idx_columns_repo ON board_columns(repoId);
CREATE INDEX IF NOT EXISTS idx_cards_repo    ON cards(repoId);
CREATE INDEX IF NOT EXISTS idx_cards_column  ON cards(columnId);
CREATE INDEX IF NOT EXISTS idx_repos_dirty   ON repos(dirty);
CREATE INDEX IF NOT EXISTS idx_columns_dirty ON board_columns(dirty);
CREATE INDEX IF NOT EXISTS idx_cards_dirty   ON cards(dirty);
CREATE INDEX IF NOT EXISTS idx_wiki_repo     ON wiki_entries(repoId);
CREATE INDEX IF NOT EXISTS idx_wiki_dirty    ON wiki_entries(dirty);
CREATE INDEX IF NOT EXISTS idx_emb_entry     ON embeddings(entryId);
CREATE INDEX IF NOT EXISTS idx_emb_dirty     ON embeddings(dirty);
CREATE INDEX IF NOT EXISTS idx_logs_dirty    ON search_logs(dirty);
`;

/** 로컬 스토어 스키마 버전. 모양을 바꾸면 올리고 `migrate` 에 처리를 넣는다. */
const STORE_VERSION = 3;

type Row = Record<string, unknown>;

export type IngestItem = {
  id: number;
  repoId: string;
  repoPath: string;
  kind: string;
  ref: string;
  createdAt: number;
  processedAt: number | null;
};

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

    // 스키마가 바뀌어도 CREATE TABLE IF NOT EXISTS 는 기존 테이블을 손대지 않는다.
    // 그래서 낡은 모양이 조용히 살아남는다 — 버전을 보고 먼저 정리한다.
    // SCHEMA 로 테이블을 보장한 뒤 migrate() 로 낡은 테이블에 컬럼을 추가한다
    // (ALTER TABLE 은 테이블이 있어야 한다). 단 DROP 으로 스키마를 갈아엎는
    // 마이그레이션은 SCHEMA 전에 해야 CREATE TABLE 이 빈 테이블을 다시 만든다.
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.migratePreSchema();
    this.db.exec(SCHEMA);
    this.migratePostSchema();
    this.setMeta("storeVersion", String(STORE_VERSION));
  }

  /**
   * SCHEMA 실행 전 마이그레이션 — DROP 으로 스키마를 갈아엎는 것.
   * CREATE TABLE 이 빈 테이블을 다시 만들게 하려면 여기서 해야 한다.
   */
  private migratePreSchema(): void {
    const current = Number(this.getMeta("storeVersion") ?? "1");
    if (current < 2) {
      // 유니크 키가 (repoId, kind, ref) 였다 — 같은 커밋이 두 번 큐에 올랐다.
      this.db.exec("DROP TABLE IF EXISTS ingest_queue");
    }
  }

  /**
   * SCHEMA 실행 후 마이그레이션 — 기존 테이블에 컬럼을 추가하는 것.
   * CREATE TABLE IF NOT EXISTS 는 컬럼이 빠진 낡은 테이블을 안 고치므로,
   * ALTER TABLE 로 직접 갚아준다.
   */
  private migratePostSchema(): void {
    const current = Number(this.getMeta("storeVersion") ?? "1");
    if (current < 3) {
      // 완료 추적 필드. pragma_table_info 로 있는지 먼저 본다(중복 ALTER 방지).
      this.addColumnIfMissing("board_columns", "isDone", "INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing("cards", "completedAt", "INTEGER");
      this.addColumnIfMissing("cards", "regressCount", "INTEGER NOT NULL DEFAULT 0");
    }
  }

  /** 컬럼이 없으면 ALTER TABLE ADD COLUMN. 이미 있으면 조용히 넘어간다. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
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
      this.db.prepare("DELETE FROM wiki_fts").run();
      this.db.prepare("DELETE FROM ingest_queue").run();
      this.db.prepare("DELETE FROM conflicts").run();
      this.db.prepare("DELETE FROM meta").run();
      // 스키마 버전은 데이터가 아니라 이 파일의 모양이다. 지우면 다음 열 때
      // 낡은 스토어로 오인해 마이그레이션이 다시 돈다.
      this.setMeta("storeVersion", String(STORE_VERSION));
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
    return row ? (fromDb(kind, row) as T) : null;
  }

  /** 살아있는(삭제되지 않은) 레포 전부. */
  listRepos(): Repo[] {
    const rows = this.db
      .prepare("SELECT * FROM repos WHERE deletedAt IS NULL ORDER BY name")
      .all() as Row[];
    return rows.map((r) => fromDb("repos", r) as Repo);
  }

  listColumns(repoId: string): Column[] {
    const rows = this.db
      .prepare("SELECT * FROM board_columns WHERE repoId = ? AND deletedAt IS NULL")
      .all(repoId) as Row[];
    return rows.map((r) => fromDb("columns", r) as Column).sort(byRank);
  }

  listCards(columnId: string): Card[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE columnId = ? AND deletedAt IS NULL")
      .all(columnId) as Row[];
    return rows.map((r) => fromDb("cards", r) as Card).sort(byRank);
  }

  listCardsByRepo(repoId: string): Card[] {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE repoId = ? AND deletedAt IS NULL")
      .all(repoId) as Row[];
    return rows.map((r) => fromDb("cards", r) as Card).sort(byRank);
  }

  /** 삭제된 카드(툼스톤) — 보관함 뷰용. 최근 삭제순. */
  listDeletedCardsByRepo(repoId: string): Card[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM cards WHERE repoId = ? AND deletedAt IS NOT NULL ORDER BY updatedAt DESC",
      )
      .all(repoId) as Row[];
    return rows.map((r) => fromDb("cards", r) as Card);
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
        `INSERT INTO board_columns (id, repoId, title, rank, isDone, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @title, @rank, @isDone, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, title = excluded.title, rank = excluded.rank,
           isDone = excluded.isDone, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run({ ...column, isDone: column.isDone ? 1 : 0 });
  }

  putCard(card: Card): void {
    this.db
      .prepare(
        `INSERT INTO cards (id, repoId, columnId, title, body, rank, completedAt, regressCount, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @columnId, @title, @body, @rank, @completedAt, @regressCount, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, columnId = excluded.columnId, title = excluded.title,
           body = excluded.body, rank = excluded.rank, completedAt = excluded.completedAt,
           regressCount = excluded.regressCount, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(card);
  }

  // ---- wiki ----

  getWikiEntry(id: string): WikiEntry | null {
    return this.one<WikiEntry>("wikiEntries", id);
  }

  /**
   * wiki 엔트리 목록.
   *
   * `repoId` 를 주면 그 레포 + 프로젝트 독립 지식을, 안 주면 전부 돌려준다.
   * cross-project 검색은 후자를 쓴다 — 한 유저의 레포 사이에서만 성립하는데,
   * 로컬 스토어에는 그 유저 것만 있으므로 별도 필터가 필요 없다.
   */
  listWikiEntries(repoId?: string): WikiEntry[] {
    const rows = (
      repoId === undefined
        ? this.db.prepare("SELECT * FROM wiki_entries WHERE deletedAt IS NULL").all()
        : this.db
            .prepare(
              "SELECT * FROM wiki_entries WHERE deletedAt IS NULL AND (repoId = ? OR repoId IS NULL)",
            )
            .all(repoId)
    ) as Row[];
    return rows.map((r) => fromDb("wikiEntries", r) as WikiEntry);
  }

  /**
   * 이 커밋이 이미 어떤 WikiEntry의 sourceRef로 기록됐는지 확인한다.
   *
   * 레포가 공유되면서 생긴 문제: backfill 큐는 로컬 전용이라 팀원끼리
   * "이 커밋 이미 처리했나"를 모른다. 대신 결과물(WikiEntry)은 동기화되니
   * 그걸로 대신 확인한다 — 짧은 sha(에이전트가 화면에 보이는 대로 적었을
   * 경우)와 전체 sha 둘 다 맞춰본다.
   */
  hasSourceRef(repoId: string, fullSha: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT sourceRef FROM wiki_entries WHERE deletedAt IS NULL AND sourceRef IS NOT NULL AND (repoId = ? OR repoId IS NULL)",
      )
      .all(repoId) as { sourceRef: string }[];
    return rows.some((r) => fullSha === r.sourceRef || fullSha.startsWith(r.sourceRef));
  }

  putWikiEntry(entry: WikiEntry): void {
    this.db
      .prepare(
        `INSERT INTO wiki_entries (id, repoId, title, body, kind, tags, sourceRef, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @title, @body, @kind, @tags, @sourceRef, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, title = excluded.title, body = excluded.body,
           kind = excluded.kind, tags = excluded.tags, sourceRef = excluded.sourceRef,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(toDb("wikiEntries", entry as unknown as Row));
    this.reindex(entry);
  }

  getEmbedding(entryId: string, model: string): Embedding | null {
    const row = this.db
      .prepare(
        "SELECT * FROM embeddings WHERE entryId = ? AND model = ? AND deletedAt IS NULL LIMIT 1",
      )
      .get(entryId, model) as Row | undefined;
    return row ? (fromDb("embeddings", row) as Embedding) : null;
  }

  putEmbedding(embedding: Embedding): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (id, entryId, model, dim, vector, updatedAt, deletedAt, dirty)
         VALUES (@id, @entryId, @model, @dim, @vector, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           entryId = excluded.entryId, model = excluded.model, dim = excluded.dim,
           vector = excluded.vector, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(embedding);
  }

  /** 해당 모델의 벡터를 아직 못 만든 엔트리들. */
  listEntriesWithoutEmbedding(model: string): WikiEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM wiki_entries e
         WHERE e.deletedAt IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM embeddings m
             WHERE m.entryId = e.id AND m.model = ? AND m.deletedAt IS NULL
               AND m.updatedAt >= e.updatedAt
           )`,
      )
      .all(model) as Row[];
    return rows.map((r) => fromDb("wikiEntries", r) as WikiEntry);
  }

  /** 특정 모델의 모든 벡터. 벡터 검색이 메모리로 올려서 쓴다. */
  listEmbeddings(model: string): Embedding[] {
    const rows = this.db
      .prepare("SELECT * FROM embeddings WHERE model = ? AND deletedAt IS NULL")
      .all(model) as Row[];
    return rows.map((r) => fromDb("embeddings", r) as Embedding);
  }

  putSearchLog(log: SearchLog): void {
    this.db
      .prepare(
        `INSERT INTO search_logs (id, repoId, query, scope, strategy, model, resultIds, usedIds, tookMs, updatedAt, deletedAt, dirty)
         VALUES (@id, @repoId, @query, @scope, @strategy, @model, @resultIds, @usedIds, @tookMs, @updatedAt, @deletedAt, 1)
         ON CONFLICT(id) DO UPDATE SET
           repoId = excluded.repoId, query = excluded.query, scope = excluded.scope,
           strategy = excluded.strategy, model = excluded.model,
           resultIds = excluded.resultIds, usedIds = excluded.usedIds,
           tookMs = excluded.tookMs, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 1`,
      )
      .run(toDb("searchLogs", log as unknown as Row));
  }

  getSearchLog(id: string): SearchLog | null {
    return this.one<SearchLog>("searchLogs", id);
  }

  listSearchLogs(limit = 100): SearchLog[] {
    const rows = this.db
      .prepare("SELECT * FROM search_logs WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => fromDb("searchLogs", r) as SearchLog);
  }

  // ---- 키워드 인덱스 ----

  /**
   * FTS 인덱스를 엔트리 하나에 맞춰 갱신한다.
   *
   * fts5 에는 UPSERT 가 없으니 지우고 다시 넣는다. 삭제된(툼스톤) 엔트리는
   * 넣지 않는다 — 검색 결과에 뜨면 안 되니까.
   */
  private reindex(entry: WikiEntry): void {
    this.db.prepare("DELETE FROM wiki_fts WHERE id = ?").run(entry.id);
    if (entry.deletedAt !== null) return;
    this.db
      .prepare("INSERT INTO wiki_fts (id, title, body, tags) VALUES (?, ?, ?, ?)")
      .run(entry.id, entry.title, entry.body, entry.tags.join(" "));
  }

  /** 인덱스를 통째로 다시 만든다. 인덱스는 파생물이라 언제든 버려도 된다. */
  rebuildIndex(): number {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM wiki_fts").run();
      const entries = this.listWikiEntries();
      for (const entry of entries) this.reindex(entry);
      return entries.length;
    });
  }

  /**
   * 키워드 검색. FTS5 의 bm25 순위를 그대로 쓴다.
   *
   * bm25() 는 **작을수록 좋은** 값이라 부호를 뒤집어 점수로 만든다.
   * 제목이 본문보다 중요하므로 가중치를 준다.
   */
  searchKeyword(query: string, options: { repoId?: string; limit?: number } = {}): ScoredId[] {
    const match = toMatchQuery(query);
    if (match === null) return [];

    const limit = options.limit ?? 50;
    // bm25 의 가중치는 fts5 컬럼 순서(id, title, body, tags)에 맞춘다.
    // id 는 UNINDEXED 라 0, 제목이 본문보다 무겁다.
    const select = `SELECT f.id AS id, -bm25(wiki_fts, 0.0, 10.0, 1.0, 3.0) AS score
       FROM wiki_fts f
       JOIN wiki_entries e ON e.id = f.id
       WHERE wiki_fts MATCH ? AND e.deletedAt IS NULL`;
    const ordering = " ORDER BY score DESC LIMIT ?";

    const rows =
      options.repoId === undefined
        ? this.db.prepare(select + ordering).all(match, limit)
        : this.db
            .prepare(`${select} AND (e.repoId = ? OR e.repoId IS NULL)${ordering}`)
            .all(match, options.repoId, limit);

    return rows as ScoredId[];
  }

  // ---- 동기화용 ----

  /** 아직 서버에 못 올린 로컬 변경분. */
  pending(): ChangeSet {
    const dirty = <T>(kind: EntityKind): T[] =>
      (this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE dirty = 1`).all() as Row[]).map(
        (r) => fromDb(kind, r) as T,
      );
    return {
      repos: dirty<Repo>("repos"),
      columns: dirty<Column>("columns"),
      cards: dirty<Card>("cards"),
      wikiEntries: dirty<WikiEntry>("wikiEntries"),
      embeddings: dirty<Embedding>("embeddings"),
      searchLogs: dirty<SearchLog>("searchLogs"),
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
  applyRemote(kind: EntityKind, incoming: SyncableEntity): "applied" | "kept-local" {
    const existing = this.one<SyncableEntity>(kind, incoming.id);
    if (existing) {
      const localDirty = this.isDirty(kind, incoming.id);
      if (localDirty && !incomingWins(incoming, existing)) return "kept-local";
    }

    const write = toDb(kind, incoming as unknown as Row);
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

    if (kind === "wikiEntries") this.reindex(incoming as WikiEntry);
    return "applied";
  }

  isDirty(kind: EntityKind, id: string): boolean {
    const row = this.db.prepare(`SELECT dirty FROM ${TABLE[kind]} WHERE id = ?`).get(id) as
      | { dirty: number }
      | undefined;
    return row?.dirty === 1;
  }

  // ---- 주입 큐 ----

  /**
   * 소화할 커밋을 큐에 넣는다. 같은 커밋을 두 번 넣어도 한 건이다 —
   * 훅이 여러 번 돌 수도 있고, 그때마다 중복이 쌓이면 안 된다.
   */
  enqueueIngest(item: {
    repoId: string;
    repoPath: string;
    kind: string;
    ref: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ingest_queue (repoId, repoPath, kind, ref, createdAt)
         VALUES (@repoId, @repoPath, @kind, @ref, @createdAt)
         ON CONFLICT(repoId, ref) DO NOTHING`,
      )
      .run({ ...item, createdAt: Date.now() });
  }

  listPendingIngest(repoId?: string, limit = 50): IngestItem[] {
    const rows =
      repoId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM ingest_queue WHERE processedAt IS NULL ORDER BY createdAt LIMIT ?",
            )
            .all(limit)
        : this.db
            .prepare(
              "SELECT * FROM ingest_queue WHERE processedAt IS NULL AND repoId = ? ORDER BY createdAt LIMIT ?",
            )
            .all(repoId, limit);
    return rows as IngestItem[];
  }

  countPendingIngest(repoId?: string): number {
    const row = (
      repoId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM ingest_queue WHERE processedAt IS NULL").get()
        : this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM ingest_queue WHERE processedAt IS NULL AND repoId = ?",
            )
            .get(repoId)
    ) as { n: number };
    return row.n;
  }

  markIngested(id: number): void {
    this.db.prepare("UPDATE ingest_queue SET processedAt = ? WHERE id = ?").run(Date.now(), id);
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

/**
 * DB 행을 프로토콜 모양으로 되돌린다.
 * 로컬 전용 컬럼(`dirty`)을 떼고, JSON 으로 넣어둔 배열 필드를 되살린다.
 */
function fromDb(kind: EntityKind, row: Row): Row {
  const { dirty: _dirty, ...rest } = row;
  for (const field of LIST_FIELDS[kind] ?? []) {
    rest[field] = parseList(rest[field]);
  }
  // SQLite 는 boolean 을 0/1 INTEGER 로 저장한다. 프로토콜은 boolean.
  if (kind === "columns" && "isDone" in rest) {
    rest["isDone"] = Boolean(rest["isDone"]);
  }
  return rest;
}

/** 프로토콜 모양을 DB 에 넣을 수 있는 값으로. 배열은 JSON 문자열이 된다. */
function toDb(kind: EntityKind, entity: Row): Row {
  const out: Row = { ...entity };
  for (const field of LIST_FIELDS[kind] ?? []) {
    out[field] = JSON.stringify(out[field] ?? []);
  }
  // SQLite 는 boolean 을 0/1 INTEGER 로 저장한다.
  if (kind === "columns" && "isDone" in out) {
    out["isDone"] = out["isDone"] ? 1 : 0;
  }
  return out;
}

/**
 * 사용자 질의를 FTS5 MATCH 문법으로 옮긴다.
 *
 * 날것으로 넘기면 `AND`, `"`, `*`, `(` 같은 게 FTS5 연산자로 해석돼서
 * 엉뚱한 결과가 나오거나 아예 구문 오류가 난다. 토큰만 뽑아 각각 인용하고
 * OR 로 잇는다 — 몇 개가 맞았는지는 bm25 가 순위로 반영한다.
 *
 * 접두 검색(`*`)을 붙이는 이유는 한국어 때문이다. unicode61 토크나이저는
 * 공백으로만 자르므로 "싱크를" 이 통째로 한 토큰이 되는데, 접두 검색이면
 * "싱크" 로도 걸린다.
 */
function toMatchQuery(query: string): string | null {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
