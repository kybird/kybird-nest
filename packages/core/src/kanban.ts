import { newId, now, rankBetween, type Card, type Column, type Repo } from "@kybird/shared";
import type { Store } from "./store.js";

/** 새 레포에 기본으로 깔아주는 컬럼. */
export const DEFAULT_COLUMNS = ["할 일", "진행 중", "완료"] as const;

export function createRepo(
  store: Store,
  input: { name: string; path?: string | null; gitRemote?: string | null },
): Repo {
  const repo: Repo = {
    id: newId(),
    name: input.name,
    path: input.path ?? null,
    gitRemote: input.gitRemote ?? null,
    updatedAt: now(),
    deletedAt: null,
  };
  store.transaction(() => {
    store.putRepo(repo);
    for (const title of DEFAULT_COLUMNS) {
      createColumn(store, repo.id, title, { isDone: title === "완료" });
    }
  });
  return repo;
}

export function createColumn(
  store: Store,
  repoId: string,
  title: string,
  opts?: { isDone?: boolean },
): Column {
  const existing = store.listColumns(repoId);
  const last = existing.length > 0 ? existing[existing.length - 1]!.rank : null;
  const column: Column = {
    id: newId(),
    repoId,
    title,
    rank: rankBetween(last, null),
    isDone: opts?.isDone ?? false,
    updatedAt: now(),
    deletedAt: null,
  };
  store.putColumn(column);
  return column;
}

export function createCard(
  store: Store,
  input: { repoId: string; columnId: string; title: string; body?: string },
): Card {
  const existing = store.listCards(input.columnId);
  const last = existing.length > 0 ? existing[existing.length - 1]!.rank : null;
  const targetColumn = store.getColumn(input.columnId);
  const card: Card = {
    id: newId(),
    repoId: input.repoId,
    columnId: input.columnId,
    title: input.title,
    body: input.body ?? "",
    rank: rankBetween(last, null),
    completedAt: targetColumn?.isDone ? now() : null,
    regressCount: 0,
    updatedAt: now(),
    deletedAt: null,
  };
  store.putCard(card);
  return card;
}

export function editCard(
  store: Store,
  cardId: string,
  patch: { title?: string; body?: string },
): Card {
  const card = store.getCard(cardId);
  if (!card) throw new Error(`카드를 찾을 수 없다: ${cardId}`);
  const updated: Card = {
    ...card,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    updatedAt: now(),
  };
  store.putCard(updated);
  return updated;
}

/**
 * 카드를 옮긴다. `position` 은 대상 컬럼에서 **자기 자신을 뺀** 목록 기준
 * 삽입 위치다. 생략하면 맨 뒤.
 */
export function moveCard(
  store: Store,
  cardId: string,
  toColumnId: string,
  position?: number,
): Card {
  const card = store.getCard(cardId);
  if (!card) throw new Error(`카드를 찾을 수 없다: ${cardId}`);

  const column = store.getColumn(toColumnId);
  if (!column || column.deletedAt !== null) {
    throw new Error(`컬럼을 찾을 수 없다: ${toColumnId}`);
  }

  // 같은 컬럼 안에서 옮길 때 자기 자신이 이웃 계산에 끼면 안 된다.
  const siblings = store.listCards(toColumnId).filter((c) => c.id !== cardId);
  const at = position === undefined ? siblings.length : clamp(position, 0, siblings.length);
  const prev = at > 0 ? siblings[at - 1]!.rank : null;
  const next = at < siblings.length ? siblings[at]!.rank : null;

  // 완료 진입/이탈 감지. regressCount 로 반복 회귀를 잡는다.
  let { completedAt, regressCount } = card;
  const sameColumn = card.columnId === toColumnId;
  if (!sameColumn) {
    if (column.isDone && completedAt === null) {
      // 완료가 아닌 곳에서 완료로 — 완료 시각 찍기.
      completedAt = now();
    } else if (!column.isDone && completedAt !== null) {
      // 완료에서 완료가 아닌 곳으로 — 회귀. 카운트 올리고 completedAt 리셋.
      regressCount += 1;
      completedAt = null;
    }
  }

  const updated: Card = {
    ...card,
    columnId: toColumnId,
    repoId: column.repoId,
    rank: rankBetween(prev, next),
    completedAt,
    regressCount,
    updatedAt: now(),
  };
  store.putCard(updated);
  return updated;
}

/** 삭제는 툼스톤이다. 진짜로 지우면 다른 머신이 삭제를 알 방법이 없다. */
export function deleteCard(store: Store, cardId: string): Card {
  const card = store.getCard(cardId);
  if (!card) throw new Error(`카드를 찾을 수 없다: ${cardId}`);
  const timestamp = now();
  const updated: Card = { ...card, updatedAt: timestamp, deletedAt: timestamp };
  store.putCard(updated);
  return updated;
}

/** 삭제된 카드를 되살린다. 툼스톤(deletedAt)을 지운다. */
export function restoreCard(store: Store, cardId: string): Card {
  const card = store.getCard(cardId);
  if (!card) throw new Error(`카드를 찾을 수 없다: ${cardId}`);
  const updated: Card = { ...card, updatedAt: now(), deletedAt: null };
  store.putCard(updated);
  return updated;
}

export function renameColumn(store: Store, columnId: string, title: string): Column {
  const column = store.getColumn(columnId);
  if (!column) throw new Error(`컬럼을 찾을 수 없다: ${columnId}`);
  const updated: Column = { ...column, title, updatedAt: now() };
  store.putColumn(updated);
  return updated;
}

export type BoardView = {
  repo: Repo;
  columns: Array<{ column: Column; cards: Card[] }>;
};

/** 한 레포의 보드 전체. 대시보드와 CLI 가 같이 쓴다. */
export function board(store: Store, repoId: string): BoardView {
  const repo = store.getRepo(repoId);
  if (!repo) throw new Error(`레포를 찾을 수 없다: ${repoId}`);
  return {
    repo,
    columns: store.listColumns(repoId).map((column) => ({
      column,
      cards: store.listCards(column.id),
    })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
