import {
  SYNC_PAGE_SIZE,
  emptyChangeSet,
  incomingWins,
  type Card,
  type ChangeSet,
  type Column,
  type Rejection,
  type Repo,
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

type StoredMeta = { id: string; userId: string; updatedAt: Date };

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

/**
 * 클라이언트가 올린 변경분을 적용한다.
 *
 * 적용 순서는 **의존성 순서(레포 → 컬럼 → 카드)** 다. 한 번의 동기화 안에서
 * 새 레포와 그 안의 카드가 같이 올라오는 게 정상이기 때문이다.
 */
export async function applyChanges(userId: string, changes: ChangeSet): Promise<Rejection[]> {
  const rejected: Rejection[] = [];
  if (changes.repos.length + changes.columns.length + changes.cards.length === 0) {
    return rejected;
  }

  await prisma.$transaction(async (tx) => {
    for (const repo of changes.repos) {
      const existing = await tx.repo.findUnique({
        where: { id: repo.id },
        select: { id: true, userId: true, updatedAt: true },
      });
      const verdict = judge("repos", repo, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      await writeRepo(tx, userId, repo, await nextSeq(tx));
    }

    for (const column of changes.columns) {
      const existing = await tx.column.findUnique({
        where: { id: column.id },
        select: { id: true, userId: true, updatedAt: true },
      });
      const verdict = judge("columns", column, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(await ownsRepo(tx, userId, column.repoId))) {
        rejected.push({
          kind: "columns",
          id: column.id,
          reason: "missing_parent",
          serverUpdatedAt: null,
        });
        continue;
      }
      await writeColumn(tx, userId, column, await nextSeq(tx));
    }

    for (const card of changes.cards) {
      const existing = await tx.card.findUnique({
        where: { id: card.id },
        select: { id: true, userId: true, updatedAt: true },
      });
      const verdict = judge("cards", card, existing, userId);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      const parentsOk =
        (await ownsRepo(tx, userId, card.repoId)) && (await ownsColumn(tx, userId, card.columnId));
      if (!parentsOk) {
        rejected.push({
          kind: "cards",
          id: card.id,
          reason: "missing_parent",
          serverUpdatedAt: null,
        });
        continue;
      }
      await writeCard(tx, userId, card, await nextSeq(tx));
    }
  });

  return rejected;
}

async function ownsRepo(
  tx: Prisma.TransactionClient,
  userId: string,
  repoId: string,
): Promise<boolean> {
  const row = await tx.repo.findUnique({ where: { id: repoId }, select: { userId: true } });
  return row?.userId === userId;
}

async function ownsColumn(
  tx: Prisma.TransactionClient,
  userId: string,
  columnId: string,
): Promise<boolean> {
  const row = await tx.column.findUnique({ where: { id: columnId }, select: { userId: true } });
  return row?.userId === userId;
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

  const [repos, columns, cards] = await Promise.all([
    prisma.repo.findMany({ where, orderBy, take }),
    prisma.column.findMany({ where, orderBy, take }),
    prisma.card.findMany({ where, orderBy, take }),
  ]);

  // 세 종류를 하나의 seq 수열로 합쳐서 앞에서부터 SYNC_PAGE_SIZE 개만 취한다.
  // 이렇게 해야 "커서 = 돌려준 것들의 최대 seq" 가 종류에 상관없이 성립한다.
  const all = [
    ...repos.map((r) => ({ seq: r.seq, kind: "repos" as const, row: r })),
    ...columns.map((c) => ({ seq: c.seq, kind: "columns" as const, row: c })),
    ...cards.map((c) => ({ seq: c.seq, kind: "cards" as const, row: c })),
  ].sort((a, b) => a.seq - b.seq);

  const page = all.slice(0, SYNC_PAGE_SIZE);
  const hasMore = all.length > page.length;

  const changes = emptyChangeSet();
  for (const item of page) {
    if (item.kind === "repos") {
      const r = item.row;
      changes.repos.push({
        id: r.id,
        name: r.name,
        path: r.path,
        gitRemote: r.gitRemote,
        updatedAt: toMs(r.updatedAt),
        deletedAt: toMsOrNull(r.deletedAt),
      });
    } else if (item.kind === "columns") {
      const c = item.row;
      changes.columns.push({
        id: c.id,
        repoId: c.repoId,
        title: c.title,
        rank: c.rank,
        updatedAt: toMs(c.updatedAt),
        deletedAt: toMsOrNull(c.deletedAt),
      });
    } else {
      const c = item.row;
      changes.cards.push({
        id: c.id,
        repoId: c.repoId,
        columnId: c.columnId,
        title: c.title,
        body: c.body,
        rank: c.rank,
        updatedAt: toMs(c.updatedAt),
        deletedAt: toMsOrNull(c.deletedAt),
      });
    }
  }

  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { cursor: lastSeq, changes, hasMore };
}
