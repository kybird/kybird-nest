import {
  newId,
  now,
  rankBetween,
  regressionReport,
  type Card,
  type Column,
  type RegressionReport,
  type CardRejectedBy,
  type Repo,
} from "@kybird/shared";
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
    rejectedBy: null,
    rejectedReason: null,
    rejectedAt: null,
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
  let { rejectedBy, rejectedReason, rejectedAt } = card;
  const sameColumn = card.columnId === toColumnId;
  if (!sameColumn) {
    if (column.isDone && completedAt === null) {
      // 완료가 아닌 곳에서 완료로 — 완료 시각 찍기.
      completedAt = now();
      // 완료에 도달했으면 지난 기각은 해소된 것이다. 안 지우면 다음 루프가
      // 이미 고쳐진 사유를 읽고 또 손대게 된다.
      rejectedBy = null;
      rejectedReason = null;
      rejectedAt = null;
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
    rejectedBy,
    rejectedReason,
    rejectedAt,
    updatedAt: now(),
  };
  store.putCard(updated);
  return updated;
}

/**
 * 카드를 기각해서 상류로 되돌린다.
 *
 * brief.md 0장의 순환은 **기각이 상류로 돌아가야 닫힌다.** 그냥 컬럼만 옮기면
 * 왜 튕겼는지가 사라져서 받는 쪽이 같은 걸 또 만든다 — 그래서 사유가 필수다.
 *
 * 목적지 컬럼은 기본으로 **맨 앞 컬럼**("할 일")이다. 지금은 세 루프가 보드
 * 하나를 같이 쓰기 때문에 QA 기각이든 개발 기각이든 갈 곳이 같고, 누가 집어야
 * 하는지는 `rejectedBy` 가 가른다. 루프별로 컬럼을 나누게 되면 `toColumnId` 로
 * 목적지를 지정하면 되고 이 함수는 안 바뀐다.
 *
 * 이동 자체는 `moveCard` 에 맡긴다 — 완료에서 나오는 경우의 `regressCount`
 * 증가가 거기 있고, 기각은 그 전이의 특수한 경우일 뿐이라 두 번 셀 이유가 없다.
 */
export function rejectCard(
  store: Store,
  cardId: string,
  input: { by: CardRejectedBy; reason: string; toColumnId?: string },
): Card {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("기각 사유는 비울 수 없다 — 받는 쪽이 고칠 수 없다");
  }

  const card = store.getCard(cardId);
  if (!card) throw new Error(`카드를 찾을 수 없다: ${cardId}`);

  const toColumnId = input.toColumnId ?? firstColumnId(store, card.repoId);
  const moved = moveCard(store, cardId, toColumnId);

  const updated: Card = {
    ...moved,
    rejectedBy: input.by,
    rejectedReason: reason,
    rejectedAt: now(),
    updatedAt: now(),
  };
  store.putCard(updated);
  return updated;
}

function firstColumnId(store: Store, repoId: string): string {
  const columns = store.listColumns(repoId);
  const first = columns[0];
  if (!first) throw new Error(`레포에 컬럼이 없다: ${repoId}`);
  return first.id;
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

/**
 * 보드 전체의 회귀 상태를 요약한다.
 *
 * 계산 자체는 `@kybird/shared` 에 있다 — 웹 대시보드도 같은 판단을 해야 하는데
 * core 를 임포트하면 `better-sqlite3` 까지 딸려오기 때문이다. 여기 있는 건
 * BoardView 를 카드 목록으로 펴주는 어댑터일 뿐이다.
 */
export function boardRegressionReport(view: BoardView): RegressionReport {
  return regressionReport(view.columns.flatMap(({ cards }) => cards));
}
