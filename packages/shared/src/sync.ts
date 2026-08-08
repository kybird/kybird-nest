import { z } from "zod";
import { cardSchema, columnSchema, repoSchema } from "./entities.js";

/**
 * 동기화 프로토콜.
 *
 * 서버는 진실이지만 똑똑하지는 않다 — 저장하고, 단조증가 `seq` 를 찍고,
 * 커서 이후 변경분을 돌려주는 게 전부다. 임베딩·검색·컴파일은 전부 클라이언트다.
 *
 * push 와 pull 을 **한 번의 왕복으로** 처리한다. 오프라인에서 쌓인 큐를
 * 비우면서 동시에 남의 머신 변경분을 받아오는 게 기본 동작이기 때문이다.
 *
 *   1. 클라이언트가 로컬 dirty 행 + 자기 커서를 보낸다
 *   2. 서버가 LWW 로 적용하고 각 행에 새 seq 를 찍는다
 *   3. 서버가 `cursor` 이후의 모든 변경분을 돌려준다
 *   4. 클라이언트가 그걸 로컬에 반영하고 커서를 전진시킨다
 *
 * `seq` 는 유저별이 아니라 **전역 단조증가**다. pull 할 때 userId 로
 * 걸러내므로 한 유저가 보는 수열은 여전히 단조증가이고, 서버는 카운터를
 * 하나만 관리하면 된다.
 */

/** 한 번의 동기화로 오가는 변경분 묶음. */
export const changeSetSchema = z.object({
  repos: z.array(repoSchema).default([]),
  columns: z.array(columnSchema).default([]),
  cards: z.array(cardSchema).default([]),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export function emptyChangeSet(): ChangeSet {
  return { repos: [], columns: [], cards: [] };
}

export function changeSetSize(changes: ChangeSet): number {
  return changes.repos.length + changes.columns.length + changes.cards.length;
}

/** 한 번의 pull 로 돌려주는 최대 행 수. 초과분은 `hasMore` 로 알린다. */
export const SYNC_PAGE_SIZE = 500;

export const syncRequestSchema = z.object({
  /** 이 클라이언트가 마지막으로 받아본 seq. 처음이면 0. */
  cursor: z.number().int().nonnegative(),
  /** 아직 서버에 올리지 못한 로컬 변경분. */
  changes: changeSetSchema,
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/**
 * 서버가 내 변경을 거절한 건. LWW 에서 졌다는 뜻이다.
 *
 * 클라이언트는 진 쪽을 그냥 버리지 않고 로컬 `conflicts` 에 사본으로
 * 남긴다 — 혼자 쓰는 시스템이라 드물게 일어나지만, 일어났을 때
 * 조용히 사라지면 그게 제일 나쁘다.
 */
export const rejectionReasonSchema = z.enum([
  /** LWW 에서 졌다. 서버 값이 더 최신이다. */
  "stale",
  /** 참조하는 레포/컬럼이 서버에 없다. 부모를 먼저 올려야 한다. */
  "missing_parent",
  /** 그 id 는 다른 유저의 것이다. */
  "forbidden",
]);
export type RejectionReason = z.infer<typeof rejectionReasonSchema>;

export const rejectionSchema = z.object({
  kind: z.enum(["repos", "columns", "cards"]),
  id: z.string(),
  reason: rejectionReasonSchema,
  /** 서버가 갖고 있던 값의 updatedAt. `stale` 일 때만 의미가 있다. */
  serverUpdatedAt: z.number().int().nonnegative().nullable(),
});
export type Rejection = z.infer<typeof rejectionSchema>;

export const syncResponseSchema = z.object({
  /** 클라이언트가 다음에 보낼 커서. */
  cursor: z.number().int().nonnegative(),
  /** 요청 커서 이후의 서버 변경분. */
  changes: changeSetSchema,
  /** 아직 못 받은 변경분이 남았다 — 같은 흐름으로 한 번 더 호출한다. */
  hasMore: z.boolean(),
  /** LWW 에서 진 로컬 변경들. */
  rejected: z.array(rejectionSchema).default([]),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;

/**
 * 최후 승자 승리 판정.
 *
 * `updatedAt` 이 같으면 id 로 타이브레이크한다 — 임의적이지만 **결정적**이라는
 * 게 중요하다. 어느 머신에서 판정하든 같은 답이 나와야 수렴한다.
 */
export function incomingWins(
  incoming: { updatedAt: number; id: string },
  existing: { updatedAt: number; id: string },
): boolean {
  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt;
  }
  return incoming.id > existing.id;
}
