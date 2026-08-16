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
  /** 완료를 뜻하는 컬럼인가. 기본 "완료" 컬럼만 true. */
  isDone: z.boolean(),
});
export type Column = z.infer<typeof columnSchema>;

/**
 * 카드를 기각한 루프.
 *
 * brief.md 0장의 세 루프(기획→개발→QA)에서 **기각은 상류로 되돌아간다** —
 * QA가 기각하면 개발이, 개발이 기각하면(요구사항이 틀렸거나 불가능) 기획이
 * 받는다. 그래서 기록해야 하는 건 "어디로 가는지"가 아니라 **누가 튕겼는지**다.
 * 목적지는 거기서 따라 나온다.
 *
 * 이름에 `card` 를 붙인 이유는 `sync.ts` 에 이미 `Rejection` 이 있어서다 —
 * 그건 **서버가 push 를 거부한 것**이라 여기와 완전히 다른 개념이다.
 */
export const cardRejectedBySchema = z.enum(["qa", "dev"]);
export type CardRejectedBy = z.infer<typeof cardRejectedBySchema>;

/** 기각을 받는 쪽. 상류가 누구인지는 기각한 루프가 결정한다. */
export function cardRejectionOwner(by: CardRejectedBy): "dev" | "plan" {
  return by === "qa" ? "dev" : "plan";
}

/** 사람에게 보여줄 루프 이름. */
export const LOOP_LABEL: Record<CardRejectedBy | "plan", string> = {
  qa: "QA",
  dev: "개발",
  plan: "기획",
};

/**
 * 주격 조사까지 붙인 형태.
 *
 * 받침 유무가 이름마다 달라서("QA가" vs "개발이") 문장에서 조사를 그냥 이어
 * 붙이면 틀린다. 루프는 셋뿐이라 일반적인 조사 판정 대신 그냥 적어둔다.
 */
export const LOOP_SUBJECT: Record<CardRejectedBy | "plan", string> = {
  qa: "QA가",
  dev: "개발이",
  plan: "기획이",
};

/** 칸반 카드. */
export const cardSchema = syncMetaSchema.extend({
  repoId: z.string().min(1).max(64),
  columnId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000),
  rank: rankSchema,
  /** 마지막으로 완료 컬럼에 들어간 시각(ms). 미완료면 null. */
  completedAt: z.number().int().nonnegative().nullable(),
  /** 완료에서 빠져나간 횟수. 반복 회귀 감지. */
  regressCount: z.number().int().nonnegative(),
  /**
   * 마지막 기각의 주체. 기각된 적이 없거나 이후 다시 완료됐으면 null.
   *
   * **이력이 아니라 최신 한 건만 들고 있다.** 하류 루프가 행동하려면 "지금
   * 무엇이 문제인가"만 있으면 되고, 몇 번 튕겼는지는 `regressCount` 가 이미
   * 센다. 이력을 별도 엔티티로 두면 싱크 배관이 하나 더 생기는데 지금 값어치가
   * 그만큼은 아니다 — 필요해지면 그때 append-only 엔티티로 승격한다.
   */
  rejectedBy: cardRejectedBySchema.nullable(),
  /** 왜 튕겼는지. 상류가 이걸 읽고 고친다 — 비어있으면 기각이 무의미하다. */
  rejectedReason: z.string().max(5000).nullable(),
  /** 기각 시각(ms). */
  rejectedAt: z.number().int().nonnegative().nullable(),
});
export type Card = z.infer<typeof cardSchema>;

/**
 * wiki 엔트리. llm-wiki 를 따라 한 조각의 지식을 한 문서로 둔다.
 *
 * `repoId` 가 null 이면 **프로젝트 독립 지식**이다. 지금은 주입이 전부
 * 레포 종속이지만, 스키마를 열어둬야 나중에 전역 지식을 도입할 때
 * 전체 재인덱싱을 안 하게 된다.
 */
export const wikiEntryKindSchema = z.enum([
  "concept",
  "pattern",
  "gotcha",
  "decision",
  "reference",
]);
export type WikiEntryKind = z.infer<typeof wikiEntryKindSchema>;

export const wikiEntrySchema = syncMetaSchema.extend({
  repoId: z.string().min(1).max(64).nullable(),
  title: z.string().min(1).max(500),
  body: z.string().max(200_000),
  kind: wikiEntryKindSchema,
  tags: z.array(z.string().min(1).max(80)).max(30),
  /** 어디서 나온 지식인지 — 커밋 해시, 카드 id 등. 추적용이라 형식은 느슨하다. */
  sourceRef: z.string().max(500).nullable(),
});
export type WikiEntry = z.infer<typeof wikiEntrySchema>;

/**
 * 엔트리의 임베딩 벡터.
 *
 * 클라이언트가 계산하고 서버는 blob 으로만 들고 있는다. 그래도 동기화하는
 * 이유는 다른 머신이 같은 걸 다시 계산하지 않아도 되기 때문이다.
 *
 * `model`/`dim` 을 같이 저장하는 게 중요하다 — 모델을 바꿔도 옛 벡터를
 * 알아볼 수 있어야 평가에서 "무엇을 바꿨더니 좋아졌나"를 가릴 수 있다.
 */
export const embeddingSchema = syncMetaSchema.extend({
  entryId: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  dim: z.number().int().positive().max(8192),
  /** Float32Array 를 base64 로. */
  vector: z.string().max(200_000),
});
export type Embedding = z.infer<typeof embeddingSchema>;

/**
 * 검색 한 건의 기록.
 *
 * **이게 평가 시스템의 유일한 소급 불가 요소다.** 지표(recall@k, MRR)는
 * "이 질문엔 이 문서가 나와야 한다"는 정답셋이 있어야 잴 수 있는데, 그건
 * 나중에 이 로그에 라벨만 붙이면 싸게 만들어진다. 반대로 지금 안 남기면
 * 나중에 어떤 방법으로도 복원할 수 없다.
 *
 * `strategy` 와 `model` 을 같이 남기는 게 핵심이다 — 무엇을 바꿨을 때
 * 좋아졌는지 가르려면 검색마다 그때의 설정을 알아야 한다.
 */
export const searchLogSchema = syncMetaSchema.extend({
  repoId: z.string().min(1).max(64).nullable(),
  query: z.string().min(1).max(2000),
  /** 이 레포만 뒤졌는지, 유저의 모든 레포를 뒤졌는지. */
  scope: z.enum(["repo", "all"]),
  /** 예: "keyword", "vector", "hybrid-rrf". 전략을 갈아끼우며 비교하기 위한 것. */
  strategy: z.string().min(1).max(100),
  /** 벡터를 안 썼으면 null. */
  model: z.string().max(200).nullable(),
  /** 반환한 엔트리 id 를 순위 순서대로. */
  resultIds: z.array(z.string().max(64)).max(100),
  /**
   * 그중 실제로 써먹은 것. 검색 시점엔 비어 있고 나중에 채워질 수 있다 —
   * 정답셋 라벨링의 씨앗이 된다.
   */
  usedIds: z.array(z.string().max(64)).max(100),
  tookMs: z.number().int().nonnegative(),
});
export type SearchLog = z.infer<typeof searchLogSchema>;

/**
 * 동기화 대상 엔티티 종류. 새 엔티티가 생기면 여기에 추가한다.
 *
 * **순서가 의존성 순서다.** 적용할 때 이 순서대로 돌리면 자식이 부모보다
 * 먼저 쓰이는 일이 없다.
 */
export const ENTITY_KINDS = [
  "repos",
  "columns",
  "cards",
  "wikiEntries",
  "embeddings",
  "searchLogs",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityByKind = {
  repos: Repo;
  columns: Column;
  cards: Card;
  wikiEntries: WikiEntry;
  embeddings: Embedding;
  searchLogs: SearchLog;
};
