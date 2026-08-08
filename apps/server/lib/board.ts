import { byRank, newId, now, rankBetween, type Card, type Column } from "@kybird/shared";
import { prisma } from "./prisma";
import { applyChanges } from "./sync";

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

export async function loadBoard(userId: string, repoId: string): Promise<Board | null> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, deletedAt: null },
    select: { id: true, name: true, gitRemote: true },
  });
  if (!repo) return null;

  const [columns, cards] = await Promise.all([
    prisma.column.findMany({ where: { repoId, userId, deletedAt: null } }),
    prisma.card.findMany({ where: { repoId, userId, deletedAt: null } }),
  ]);

  const asColumn = (c: (typeof columns)[number]): Column => ({
    id: c.id,
    repoId: c.repoId,
    title: c.title,
    rank: c.rank,
    updatedAt: toMs(c.updatedAt),
    deletedAt: toMsOrNull(c.deletedAt),
  });
  const asCard = (c: (typeof cards)[number]): Card => ({
    id: c.id,
    repoId: c.repoId,
    columnId: c.columnId,
    title: c.title,
    body: c.body,
    rank: c.rank,
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
    where: { columnId, userId, deletedAt: null },
    select: { rank: true },
  });
  const last = siblings.map((s) => s.rank).sort().at(-1) ?? null;

  const card: Card = {
    id: newId(),
    repoId,
    columnId,
    title,
    body: "",
    rank: rankBetween(last, null),
    updatedAt: now(),
    deletedAt: null,
  };
  await applyChanges(userId, { repos: [], columns: [], cards: [card] });
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
  const card = await prisma.card.findFirst({ where: { id: cardId, userId, deletedAt: null } });
  if (!card) throw new Error("카드를 찾을 수 없다");

  const column = await prisma.column.findFirst({
    where: { id: toColumnId, userId, deletedAt: null },
    select: { id: true, repoId: true },
  });
  if (!column) throw new Error("컬럼을 찾을 수 없다");

  const siblings = (
    await prisma.card.findMany({
      where: { columnId: toColumnId, userId, deletedAt: null, NOT: { id: cardId } },
      select: { id: true, rank: true },
    })
  ).sort(byRank);

  const at = Math.min(Math.max(position, 0), siblings.length);
  const prev = at > 0 ? siblings[at - 1]!.rank : null;
  const next = at < siblings.length ? siblings[at]!.rank : null;

  const moved: Card = {
    id: card.id,
    repoId: column.repoId,
    columnId: toColumnId,
    title: card.title,
    body: card.body,
    rank: rankBetween(prev, next),
    updatedAt: now(),
    deletedAt: null,
  };
  await applyChanges(userId, { repos: [], columns: [], cards: [moved] });
}

export async function editCardTitle(userId: string, cardId: string, title: string): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId, userId, deletedAt: null } });
  if (!card) throw new Error("카드를 찾을 수 없다");
  await applyChanges(userId, {
    repos: [],
    columns: [],
    cards: [
      {
        id: card.id,
        repoId: card.repoId,
        columnId: card.columnId,
        title,
        body: card.body,
        rank: card.rank,
        updatedAt: now(),
        deletedAt: null,
      },
    ],
  });
}

/** 삭제는 툼스톤이다. 진짜로 지우면 다른 머신이 삭제를 알 방법이 없다. */
export async function deleteCard(userId: string, cardId: string): Promise<void> {
  const card = await prisma.card.findFirst({ where: { id: cardId, userId, deletedAt: null } });
  if (!card) return;
  const timestamp = now();
  await applyChanges(userId, {
    repos: [],
    columns: [],
    cards: [
      {
        id: card.id,
        repoId: card.repoId,
        columnId: card.columnId,
        title: card.title,
        body: card.body,
        rank: card.rank,
        updatedAt: timestamp,
        deletedAt: timestamp,
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

/** 대시보드용 요약 — 한눈에 보기의 알맹이. */
export async function summarize(userId: string): Promise<RepoSummary[]> {
  const repos = await prisma.repo.findMany({
    where: { userId, deletedAt: null },
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
