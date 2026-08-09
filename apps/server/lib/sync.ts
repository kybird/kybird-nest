import {
  changeSetSize,
  emptyChangeSet,
  incomingWins,
  SYNC_PAGE_SIZE,
  type Card,
  type ChangeSet,
  type Column,
  type Embedding,
  type Rejection,
  type Repo,
  type SearchLog,
  type WikiEntry,
} from "@kybird/shared";
import { prisma } from "./prisma";
import type { Prisma } from "./generated/prisma/client";

const SEQ_COUNTER_ID = "seq";

/**
 * 전역 단조증가 seq 를 하나 발급한다.
 *
 * 반드시 호출부의 트랜잭션 안에서 실행해야 한다. SQLite 는 쓰기를 직렬화하므로
 * 동시 요청이 같은 값을 두 번 받는 일은 없다.
 */
async function nextSeq(tx: Prisma.TransactionClient): Promise<number> {
  const counter = await tx.counter.upsert({
    where: { id: SEQ_COUNTER_ID },
    create: { id: SEQ_COUNTER_ID, value: 1 },
    update: { value: { increment: 1 } },
    select: { value: true },
  });
  return counter.value;
}

// 서버는 DateTime 으로 저장하고 프로토콜은 epoch ms 로 주고받는다.
// 경계에서만 변환하고 그 밖에서는 섞지 않는다.
const toMs = (d: Date): number => d.getTime();
const toMsOrNull = (d: Date | null): number | null => (d === null ? null : d.getTime());
const fromMs = (ms: number): Date => new Date(ms);
const fromMsOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

// 문자열 배열은 JSON 으로 저장한다. 서버는 내용을 해석하지 않는다.
const packList = (values: string[]): string => JSON.stringify(values);
function unpackList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

type StoredMeta = { id: string; userId: string; updatedAt: Date };
const META_SELECT = { id: true, userId: true, updatedAt: true } as const;

/**
 * 들어온 행 하나를 적용할지 판정한다.
 *
 * - 남의 레코드면 `forbidden`
 * - 서버 값이 더 최신이면 `stale`
 * - 그 외에는 적용
 */
function judge(
  kind: Rejection["kind"],
  incoming: { id: string; updatedAt: number },
  existing: StoredMeta | null,
  userId: string,
): Rejection | null {
  if (existing === null) return null;
  if (existing.userId !== userId) {
    return { kind, id: incoming.id, reason: "forbidden", serverUpdatedAt: null };
  }
  if (!incomingWins(incoming, { updatedAt: toMs(existing.updatedAt), id: existing.id })) {
    return { kind, id: incoming.id, reason: "stale", serverUpdatedAt: toMs(existing.updatedAt) };
  }
  return null;
}

function missingParent(kind: Rejection["kind"], id: string): Rejection {
  return { kind, id, reason: "missing_parent", serverUpdatedAt: null };
}

/**
 * 클라이언트가 올린 변경분을 적용한다.
 *
 * 적용 순서는 **의존성 순서**다 — 레포 → 컬럼 → 카드, 레포 → wiki 엔트리 →
 * 임베딩. 한 번의 동기화 안에서 새 레포와 그 안의 카드가 같이 올라오는 게
 * 정상이기 때문이다.
 */
export async function applyChanges(userId: string, changes: ChangeSet): Promise<Rejection[]> {
  const rejected: Rejection[] = [];
  if (changeSetSize(changes) === 0) return rejected;

  await prisma.$transaction(async (tx) => {
    const owns = {
      repo: async (id: string) =>
        (await tx.repo.findUnique({ where: { id }, select: { userId: true } }))?.userId === userId,
      column: async (id: string) =>
        (await tx.column.findUnique({ where: { id }, select: { userId: true } }))?.userId === userId,
      entry: async (id: string) =>
        (await tx.wikiEntry.findUnique({ where: { id }, select: { userId: true } }))?.userId ===
        userId,
      // repoId 가 null 인 건 "프로젝트 독립"이라는 뜻이지 부모 누락이 아니다.
      optionalRepo: async (id: string | null) => (id === null ? true : owns.repo(id)),
    };

    for (const repo of changes.repos) {
      const existing = await tx.repo.findUnique({ where: { id: repo.id }, select: META_SELECT });
      const verdict = judge("repos", repo, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      await writeRepo(tx, userId, repo, await nextSeq(tx));
    }

    for (const column of changes.columns) {
      const existing = await tx.column.findUnique({ where: { id: column.id }, select: META_SELECT });
      const verdict = judge("columns", column, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(await owns.repo(column.repoId))) {
        rejected.push(missingParent("columns", column.id));
        continue;
      }
      await writeColumn(tx, userId, column, await nextSeq(tx));
    }

    for (const card of changes.cards) {
      const existing = await tx.card.findUnique({ where: { id: card.id }, select: META_SELECT });
      const verdict = judge("cards", card, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!((await owns.repo(card.repoId)) && (await owns.column(card.columnId)))) {
        rejected.push(missingParent("cards", card.id));
        continue;
      }
      await writeCard(tx, userId, card, await nextSeq(tx));
    }

    for (const entry of changes.wikiEntries) {
      const existing = await tx.wikiEntry.findUnique({
        where: { id: entry.id },
        select: META_SELECT,
      });
      const verdict = judge("wikiEntries", entry, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(await owns.optionalRepo(entry.repoId))) {
        rejected.push(missingParent("wikiEntries", entry.id));
        continue;
      }
      await writeWikiEntry(tx, userId, entry, await nextSeq(tx));
    }

    for (const embedding of changes.embeddings) {
      const existing = await tx.embedding.findUnique({
        where: { id: embedding.id },
        select: META_SELECT,
      });
      const verdict = judge("embeddings", embedding, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(await owns.entry(embedding.entryId))) {
        rejected.push(missingParent("embeddings", embedding.id));
        continue;
      }
      await writeEmbedding(tx, userId, embedding, await nextSeq(tx));
    }

    for (const log of changes.searchLogs) {
      const existing = await tx.searchLog.findUnique({ where: { id: log.id }, select: META_SELECT });
      const verdict = judge("searchLogs", log, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(await owns.optionalRepo(log.repoId))) {
        rejected.push(missingParent("searchLogs", log.id));
        continue;
      }
      await writeSearchLog(tx, userId, log, await nextSeq(tx));
    }
  });

  return rejected;
}

async function writeRepo(
  tx: Prisma.TransactionClient,
  userId: string,
  repo: Repo,
  seq: number,
): Promise<void> {
  const data = {
    name: repo.name,
    path: repo.path,
    gitRemote: repo.gitRemote,
    updatedAt: fromMs(repo.updatedAt),
    deletedAt: fromMsOrNull(repo.deletedAt),
    seq,
  };
  await tx.repo.upsert({
    where: { id: repo.id },
    create: { id: repo.id, userId, ...data },
    update: data,
  });
}

async function writeColumn(
  tx: Prisma.TransactionClient,
  userId: string,
  column: Column,
  seq: number,
): Promise<void> {
  const data = {
    repoId: column.repoId,
    title: column.title,
    rank: column.rank,
    updatedAt: fromMs(column.updatedAt),
    deletedAt: fromMsOrNull(column.deletedAt),
    seq,
  };
  await tx.column.upsert({
    where: { id: column.id },
    create: { id: column.id, userId, ...data },
    update: data,
  });
}

async function writeCard(
  tx: Prisma.TransactionClient,
  userId: string,
  card: Card,
  seq: number,
): Promise<void> {
  const data = {
    repoId: card.repoId,
    columnId: card.columnId,
    title: card.title,
    body: card.body,
    rank: card.rank,
    updatedAt: fromMs(card.updatedAt),
    deletedAt: fromMsOrNull(card.deletedAt),
    seq,
  };
  await tx.card.upsert({
    where: { id: card.id },
    create: { id: card.id, userId, ...data },
    update: data,
  });
}

async function writeWikiEntry(
  tx: Prisma.TransactionClient,
  userId: string,
  entry: WikiEntry,
  seq: number,
): Promise<void> {
  const data = {
    repoId: entry.repoId,
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    tags: packList(entry.tags),
    sourceRef: entry.sourceRef,
    updatedAt: fromMs(entry.updatedAt),
    deletedAt: fromMsOrNull(entry.deletedAt),
    seq,
  };
  await tx.wikiEntry.upsert({
    where: { id: entry.id },
    create: { id: entry.id, userId, ...data },
    update: data,
  });
}

async function writeEmbedding(
  tx: Prisma.TransactionClient,
  userId: string,
  embedding: Embedding,
  seq: number,
): Promise<void> {
  const data = {
    entryId: embedding.entryId,
    model: embedding.model,
    dim: embedding.dim,
    vector: embedding.vector,
    updatedAt: fromMs(embedding.updatedAt),
    deletedAt: fromMsOrNull(embedding.deletedAt),
    seq,
  };
  await tx.embedding.upsert({
    where: { id: embedding.id },
    create: { id: embedding.id, userId, ...data },
    update: data,
  });
}

async function writeSearchLog(
  tx: Prisma.TransactionClient,
  userId: string,
  log: SearchLog,
  seq: number,
): Promise<void> {
  const data = {
    repoId: log.repoId,
    query: log.query,
    scope: log.scope,
    strategy: log.strategy,
    model: log.model,
    resultIds: packList(log.resultIds),
    usedIds: packList(log.usedIds),
    tookMs: log.tookMs,
    updatedAt: fromMs(log.updatedAt),
    deletedAt: fromMsOrNull(log.deletedAt),
    seq,
  };
  await tx.searchLog.upsert({
    where: { id: log.id },
    create: { id: log.id, userId, ...data },
    update: data,
  });
}

export type PullResult = { cursor: number; changes: ChangeSet; hasMore: boolean };

/**
 * `cursor` 이후의 변경분을 돌려준다.
 *
 * 새 커서는 **실제로 돌려준 행들의 최대 seq** 다. 이 불변식 덕분에 push 와 pull 이
 * 별도 트랜잭션이어도 행을 건너뛰지 않는다 — 돌려주지 않은 행 너머로 커서가
 * 전진하는 일이 없기 때문이다.
 */
export async function pullChanges(userId: string, cursor: number): Promise<PullResult> {
  // 종류별로 페이지 크기만큼 넉넉히 읽고, seq 순으로 잘라낸다.
  const take = SYNC_PAGE_SIZE + 1;
  const where = { userId, seq: { gt: cursor } };
  const orderBy = { seq: "asc" } as const;

  const [repos, columns, cards, wikiEntries, embeddings, searchLogs] = await Promise.all([
    prisma.repo.findMany({ where, orderBy, take }),
    prisma.column.findMany({ where, orderBy, take }),
    prisma.card.findMany({ where, orderBy, take }),
    prisma.wikiEntry.findMany({ where, orderBy, take }),
    prisma.embedding.findMany({ where, orderBy, take }),
    prisma.searchLog.findMany({ where, orderBy, take }),
  ]);

  // 여러 종류를 하나의 seq 수열로 합쳐서 앞에서부터 SYNC_PAGE_SIZE 개만 취한다.
  // 이렇게 해야 "커서 = 돌려준 것들의 최대 seq" 가 종류에 상관없이 성립한다.
  const all = [
    ...repos.map((row) => ({ seq: row.seq, kind: "repos" as const, row })),
    ...columns.map((row) => ({ seq: row.seq, kind: "columns" as const, row })),
    ...cards.map((row) => ({ seq: row.seq, kind: "cards" as const, row })),
    ...wikiEntries.map((row) => ({ seq: row.seq, kind: "wikiEntries" as const, row })),
    ...embeddings.map((row) => ({ seq: row.seq, kind: "embeddings" as const, row })),
    ...searchLogs.map((row) => ({ seq: row.seq, kind: "searchLogs" as const, row })),
  ].sort((a, b) => a.seq - b.seq);

  const page = all.slice(0, SYNC_PAGE_SIZE);
  const hasMore = all.length > page.length;

  const changes = emptyChangeSet();
  for (const item of page) {
    switch (item.kind) {
      case "repos":
        changes.repos.push({
          id: item.row.id,
          name: item.row.name,
          path: item.row.path,
          gitRemote: item.row.gitRemote,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "columns":
        changes.columns.push({
          id: item.row.id,
          repoId: item.row.repoId,
          title: item.row.title,
          rank: item.row.rank,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "cards":
        changes.cards.push({
          id: item.row.id,
          repoId: item.row.repoId,
          columnId: item.row.columnId,
          title: item.row.title,
          body: item.row.body,
          rank: item.row.rank,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "wikiEntries":
        changes.wikiEntries.push({
          id: item.row.id,
          repoId: item.row.repoId,
          title: item.row.title,
          body: item.row.body,
          kind: item.row.kind as WikiEntry["kind"],
          tags: unpackList(item.row.tags),
          sourceRef: item.row.sourceRef,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "embeddings":
        changes.embeddings.push({
          id: item.row.id,
          entryId: item.row.entryId,
          model: item.row.model,
          dim: item.row.dim,
          vector: item.row.vector,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "searchLogs":
        changes.searchLogs.push({
          id: item.row.id,
          repoId: item.row.repoId,
          query: item.row.query,
          scope: item.row.scope as SearchLog["scope"],
          strategy: item.row.strategy,
          model: item.row.model,
          resultIds: unpackList(item.row.resultIds),
          usedIds: unpackList(item.row.usedIds),
          tookMs: item.row.tookMs,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
    }
  }

  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { cursor: lastSeq, changes, hasMore };
}
