import { z } from "zod";

/**
 * 동기화되는 모든 레코드가 공통으로 갖는 필드.
 *
 * - `id` 는 **클라이언트가 생성**한다(cuid). 오프라인에서 서버 왕복 없이
 *   레코드를 만들 수 있어야 하기 때문이다.
 * - `updatedAt` 은 최후 승자 승리(LWW) 비교에 쓰인다.
 * - `deletedAt` 은 툼스톤이다. 실제 삭제는 하지 않는다 — 지워버리면
 *   다른 머신이 그 삭제를 알 방법이 없다.
 */
export const syncMetaSchema = z.object({
  id: z.string().min(1).max(64),
  updatedAt: z.number().int().nonnegative(),
  deletedAt: z.number().int().nonnegative().nullable(),
});
export type SyncMeta = z.infer<typeof syncMetaSchema>;

const rankSchema = z.string().regex(/^[a-z]+$/, "랭크는 a-z 로만 이뤄져야 한다");

/** 레포(프로젝트). git 프로젝트가 아닐 수도 있으므로 gitRemote 는 선택이다. */
export const repoSchema = syncMetaSchema.extend({
  name: z.string().min(1).max(200),
  path: z.string().max(1000).nullable(),
  gitRemote: z.string().max(1000).nullable(),
});
export type Repo = z.infer<typeof repoSchema>;

/** 칸반 컬럼. */
export const columnSchema = syncMetaSchema.extend({
  repoId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  rank: rankSchema,
});
export type Column = z.infer<typeof columnSchema>;

/** 칸반 카드. */
export const cardSchema = syncMetaSchema.extend({
  repoId: z.string().min(1).max(64),
  columnId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  rank: rankSchema,
});
export type Card = z.infer<typeof cardSchema>;

/** 동기화 대상 엔티티 종류. 새 엔티티가 생기면 여기에 추가한다. */
export const ENTITY_KINDS = ["repos", "columns", "cards"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityByKind = {
  repos: Repo;
  columns: Column;
  cards: Card;
};
