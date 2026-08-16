import {
  byRank,
  emptyChangeSet,
  newId,
  now,
  rankBetween,
  type Card,
  type Column,
  type CardRejectedBy,
} from "@kybird/shared";
import { prisma } from "./prisma";
import { applyChanges, parseRejectedBy } from "./sync";

/**
 * 웹 UI 의 보드 조작.
 *
 * 쓰기는 전부 `applyChanges` 를 탄다. 웹에서 옮긴 카드가 CLI 에서 옮긴 것과
 * 똑같이 seq 를 받아야 다른 머신이 그 변경을 알아챌 수 있기 때문이다.
 * 여기서 Prisma 로 직접 쓰면 그 카드는 아무에게도 동기화되지 않는다.
 */

export type BoardColumn = { column: Column; cards: Card[] };
export type Board = {
  repo: { id: string; name: string; gitRemote: string | null };
  columns: BoardColumn[];
};

const toMs = (d: Date): number => d.getTime();
const toMsOrNull = (d: Date | null): number | null => (d === null ? null : d.getTime());

/** Prisma 행에서 프로토콜 Card 로 옮길 때 필요한 모양. */
type CardRow = {
  id: string;
  repoId: string;
  columnId: string;
  title: string;
  body: string;
  rank: string;
  completedAt: Date | null;
  regressCount: number;
  rejectedBy: string | null;
  rejectedReason: string | null;
  rejectedAt: Date | null;
  updatedAt: Date;
  deletedAt: Date | null;
};

/**
 * Prisma 행 → 프로토콜 Card.
 *
 * 이 변환이 원래 다섯 군데에 복붙돼 있었다. 필드가 하나 늘 때마다 다섯 곳을
 * 다 고쳐야 했고, 한 곳을 빼먹으면 그 경로로 쓴 카드만 조용히 필드를 잃는다.
 * 한 곳으로 모아서 그 실수 자체를 없앤다.
 */
function asCard(row: CardRow): Card {
  return {
    id: row.id,
    repoId: row.repoId,
    columnId: row.columnId,
    title: row.title,
    body: row.body,
    rank: row.rank,
    completedAt: toMsOrNull(row.completedAt),
    regressCount: row.regressCount,
    rejectedBy: parseRejectedBy(row.rejectedBy),
    rejectedReason: row.rejectedReason,
    rejectedAt: toMsOrNull(row.rejectedAt),
    updatedAt: toMs(row.updatedAt),
    deletedAt: toMsOrNull(row.deletedAt),
  };
}


export async function loadBoard(userId: string, repoId: string): Promise<Board | null> {
  const membership = await prisma.repoMember.findUnique({
    where: { repoId_userId: { repoId, userId } },
    select: { id: true },
  });
  if (!membership) return null;

  const repo = await prisma.repo.findFirst({
    where: { id: repoId, deletedAt: null },
    select: { id: true, name: true, gitRemote: true },
  });
  if (!repo) return null;

  // 컬럼·카드는 레포 멤버 전원이 공유한다 — userId 로 또 거르면 다른
  // 멤버가 만든 게 안 보인다.
  const [columns, cards] = await Promise.all([
    prisma.column.findMany({ where: { repoId, deletedAt: null } }),
    prisma.card.findMany({ where: { repoId, deletedAt: null } }),
  ]);

  const asColumn = (c: (typeof columns)[number]): Column => ({
    id: c.id,
    repoId: c.repoId,
    title: c.title,
    rank: c.rank,
    isDone: c.isDone,
    updatedAt: toMs(c.updatedAt),
    deletedAt: toMsOrNull(c.deletedAt),
  });
  const allCards = cards.map(asCard);
  return {
    repo,
    columns: columns
      .map(asColumn)
      .sort(byRank)
      .map((column) => ({
        column,
        cards: allCards.filter((card) => card.columnId === column.id).sort(byRank),
      })),
  };
}

export async function addCard(
  userId: string,
  repoId: string,
  columnId: string,
  title: string,
): Promise<void> {
  const siblings = await prisma.card.findMany({
    where: { columnId, deletedAt: null },
    select: { rank: true },
  });
  const last = siblings.map((s) => s.rank).sort().at(-1) ?? null;
  const column = await prisma.column.findFirst({
    where: { id: columnId, deletedAt: null },
    select: { isDone: true },
  });
  const ts = now();

  const card: Card = {
    id: newId(),
    repoId,
    columnId,
    title,
    body: "",
    rank: rankBetween(last, null),
    completedAt: column?.isDone ? ts : null,
    regressCount: 0,
    rejectedBy: null,
    rejectedReason: null,
    rejectedAt: null,
    updatedAt: ts,
    deletedAt: null,
  };
  await applyChanges(userId, { ...emptyChangeSet(), cards: [card] });
}

/**
 * 카드를 옮긴다. `position` 은 대상 컬럼에서 **자기 자신을 뺀** 목록 기준
 * 삽입 위치다.
 */
export async function moveCard(
  userId: string,
  cardId: string,
  toColumnId: string,
  position: number,
): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId, deletedAt: null } });
  if (!card) throw new Error("카드를 찾을 수 없다");

  const column = await prisma.column.findFirst({
    where: { id: toColumnId, deletedAt: null },
    select: { id: true, repoId: true, isDone: true },
  });
  if (!column) throw new Error("컬럼을 찾을 수 없다");

  const siblings = (
    await prisma.card.findMany({
      where: { columnId: toColumnId, deletedAt: null, NOT: { id: cardId } },
      select: { id: true, rank: true },
    })
  ).sort(byRank);

  const at = Math.min(Math.max(position, 0), siblings.length);
  const prev = at > 0 ? siblings[at - 1]!.rank : null;
  const next = at < siblings.length ? siblings[at]!.rank : null;

  // 완료 진입/이탈 감지. regressCount 로 반복 회귀를 잡는다.
  // card.completedAt 은 Prisma 의 Date — 프로토콜(ms)로 정규화해서 작업한다.
  const before = asCard(card);
  let completedAt = before.completedAt;
  let regressCount = before.regressCount;
  // 완료에 도달하면 지난 기각은 해소된 것이다 — core 쪽 moveCard 와 같은 규칙.
  let rejection: Pick<Card, "rejectedBy" | "rejectedReason" | "rejectedAt"> = {
    rejectedBy: before.rejectedBy,
    rejectedReason: before.rejectedReason,
    rejectedAt: before.rejectedAt,
  };
  const sameColumn = card.columnId === toColumnId;
  if (!sameColumn) {
    if (column.isDone && completedAt === null) {
      completedAt = now();
      rejection = { rejectedBy: null, rejectedReason: null, rejectedAt: null };
    } else if (!column.isDone && completedAt !== null) {
      regressCount += 1;
      completedAt = null;
    }
  }

  const moved: Card = {
    ...before,
    repoId: column.repoId,
    columnId: toColumnId,
    rank: rankBetween(prev, next),
    completedAt,
    regressCount,
    ...rejection,
    updatedAt: now(),
    deletedAt: null,
  };
  await applyChanges(userId, { ...emptyChangeSet(), cards: [moved] });
}

/**
 * 카드를 기각해서 상류로 되돌린다. core 의 `rejectCard` 와 같은 규칙이다.
 *
 * 이동을 `moveCard` 에 맡기는 것도 같다 — 완료에서 나올 때의 `regressCount`
 * 증가가 거기 있고, 기각은 그 전이의 특수한 경우다.
 */
export async function rejectCard(
  userId: string,
  cardId: string,
  input: { by: CardRejectedBy; reason: string; toColumnId?: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("기각 사유는 비울 수 없다 — 받는 쪽이 고칠 수 없다");
  }

  const card = await prisma.card.findFirst({ where: { id: cardId, deletedAt: null } });
  if (!card) throw new Error("카드를 찾을 수 없다");

  let toColumnId = input.toColumnId;
  if (toColumnId === undefined) {
    const columns = await prisma.column.findMany({
      where: { repoId: card.repoId, deletedAt: null },
      select: { id: true, rank: true },
    });
    const first = columns.sort(byRank)[0];
    if (!first) throw new Error("레포에 컬럼이 없다");
    toColumnId = first.id;
  }

  // 맨 뒤에 놓는다. 기각된 카드가 남의 순서를 밀고 들어갈 이유는 없다.
  const siblings = await prisma.card.count({
    where: { columnId: toColumnId, deletedAt: null, NOT: { id: cardId } },
  });
  await moveCard(userId, cardId, toColumnId, siblings);

  const moved = await prisma.card.findFirst({ where: { id: cardId } });
  if (!moved) throw new Error("카드를 찾을 수 없다");
  await applyChanges(userId, {
    ...emptyChangeSet(),
    cards: [
      {
        ...asCard(moved),
        rejectedBy: input.by,
        rejectedReason: reason,
        rejectedAt: now(),
        updatedAt: now(),
      },
    ],
  });
}

export async function editCard(
  userId: string,
  cardId: string,
  patch: { title?: string; body?: string },
): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId, deletedAt: null } });
  if (!card) throw new Error("카드를 찾을 수 없다");
  await applyChanges(userId, {
    ...emptyChangeSet(),
    cards: [
      {
        ...asCard(card),
        title: patch.title ?? card.title,
        body: patch.body ?? card.body,
        updatedAt: now(),
        deletedAt: null,
      },
    ],
  });
}

/** 삭제는 툼스톤이다. 진짜로 지우면 다른 머신이 삭제를 알 방법이 없다. */
export async function deleteCard(userId: string, cardId: string): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId, deletedAt: null } });
  if (!card) return;
  const timestamp = now();
  await applyChanges(userId, {
    ...emptyChangeSet(),
    cards: [{ ...asCard(card), updatedAt: timestamp, deletedAt: timestamp }],
  });
}

/**
 * 삭제된 카드를 되살린다. 툼스톤(deletedAt)을 지우기만 한다 — 데이터는
 * 그대로 남아있었다. updatedAt 이 최신이므로 다른 머신에도 복구가 퍼진다.
 */
export async function restoreCard(userId: string, cardId: string): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId } });
  if (!card || card.deletedAt === null) return;
  await applyChanges(userId, {
    ...emptyChangeSet(),
    cards: [{ ...asCard(card), updatedAt: now(), deletedAt: null }],
  });
}

/** 삭제된 카드(툼스톤) 목록 — 보관함 뷰용. 최근 삭제순. */
export async function listDeletedCards(
  userId: string,
  repoId: string,
): Promise<Card[]> {
  const membership = await prisma.repoMember.findUnique({
    where: { repoId_userId: { repoId, userId } },
    select: { id: true },
  });
  if (!membership) return [];

  const cards = await prisma.card.findMany({
    where: { repoId, deletedAt: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  return cards.map(asCard);
}

export async function addColumn(userId: string, repoId: string, title: string): Promise<void> {
  const siblings = await prisma.column.findMany({
    where: { repoId, deletedAt: null },
    select: { rank: true },
  });
  const last = siblings.map((s) => s.rank).sort().at(-1) ?? null;

  const column: Column = {
    id: newId(),
    repoId,
    title,
    rank: rankBetween(last, null),
    isDone: false,
    updatedAt: now(),
    deletedAt: null,
  };
  await applyChanges(userId, { ...emptyChangeSet(), columns: [column] });
}

export async function renameColumn(
  userId: string,
  columnId: string,
  title: string,
): Promise<void> {
  const column = await prisma.column.findFirst({ where: { id: columnId, deletedAt: null } });
  if (!column) throw new Error("컬럼을 찾을 수 없다");
  await applyChanges(userId, {
    ...emptyChangeSet(),
    columns: [
      {
        id: column.id,
        repoId: column.repoId,
        title,
        rank: column.rank,
        isDone: column.isDone,
        updatedAt: now(),
        deletedAt: null,
      },
    ],
  });
}

export type RepoSummary = {
  id: string;
  name: string;
  gitRemote: string | null;
  total: number;
  columns: Array<{ title: string; count: number }>;
  lastActivity: number | null;
};

/** 대시보드용 요약 — 한눈에 보기의 알맹이. 내가 만든 레포가 아니라 내가 멤버인 레포 전부. */
export async function summarize(userId: string): Promise<RepoSummary[]> {
  const memberships = await prisma.repoMember.findMany({ where: { userId }, select: { repoId: true } });
  const repos = await prisma.repo.findMany({
    where: { id: { in: memberships.map((m) => m.repoId) }, deletedAt: null },
    select: { id: true, name: true, gitRemote: true },
    orderBy: { name: "asc" },
  });

  return Promise.all(
    repos.map(async (repo) => {
      const [columns, cards] = await Promise.all([
        prisma.column.findMany({
          where: { repoId: repo.id, deletedAt: null },
          select: { id: true, title: true, rank: true },
        }),
        prisma.card.findMany({
          where: { repoId: repo.id, deletedAt: null },
          select: { columnId: true, updatedAt: true },
        }),
      ]);

      const ordered = columns.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
      const lastActivity = cards.reduce<number | null>(
        (max, c) => (max === null || c.updatedAt.getTime() > max ? c.updatedAt.getTime() : max),
        null,
      );

      return {
        ...repo,
        total: cards.length,
        columns: ordered.map((col) => ({
          title: col.title,
          count: cards.filter((c) => c.columnId === col.id).length,
        })),
        lastActivity,
      };
    }),
  );
}
