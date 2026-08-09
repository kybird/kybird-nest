import {
  newId,
  now,
  type SearchLog,
  type WikiEntry,
  type WikiEntryKind,
} from "@kybird/shared";
import type { ScoredId, Store } from "./store.js";

/**
 * wiki — 지식의 주입과 검색.
 *
 * 개념은 llm-wiki 를 따른다: 한 조각의 지식이 한 문서고, 그 위에 색인
 * (index.md)을 만들어 에이전트가 전체를 훑을 수 있게 한다.
 *
 * 검색은 **전략을 갈아끼울 수 있게** 짠다. 그 자체가 평가 시스템의
 * 전제이기 때문이다 — "이번 게 나아졌나"를 재려면 같은 질문셋을 전략만
 * 바꿔가며 돌릴 수 있어야 한다.
 */

export type InjectInput = {
  repoId: string | null;
  title: string;
  body: string;
  kind?: WikiEntryKind;
  tags?: string[];
  sourceRef?: string | null;
};

/** 지식 한 조각을 넣는다. */
export function inject(store: Store, input: InjectInput): WikiEntry {
  const entry: WikiEntry = {
    id: newId(),
    repoId: input.repoId,
    title: input.title,
    body: input.body,
    kind: input.kind ?? "concept",
    tags: input.tags ?? [],
    sourceRef: input.sourceRef ?? null,
    updatedAt: now(),
    deletedAt: null,
  };
  store.putWikiEntry(entry);
  return entry;
}

export function updateEntry(
  store: Store,
  id: string,
  patch: Partial<Omit<InjectInput, "repoId">>,
): WikiEntry {
  const existing = store.getWikiEntry(id);
  if (!existing) throw new Error(`엔트리를 찾을 수 없다: ${id}`);
  const updated: WikiEntry = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.sourceRef !== undefined ? { sourceRef: patch.sourceRef } : {}),
    updatedAt: now(),
  };
  store.putWikiEntry(updated);
  return updated;
}

/** 삭제는 툼스톤이다. 인덱스에서도 빠진다. */
export function removeEntry(store: Store, id: string): WikiEntry {
  const existing = store.getWikiEntry(id);
  if (!existing) throw new Error(`엔트리를 찾을 수 없다: ${id}`);
  const timestamp = now();
  const updated: WikiEntry = { ...existing, updatedAt: timestamp, deletedAt: timestamp };
  store.putWikiEntry(updated);
  return updated;
}

// ---- 검색 ----

export type SearchHit = { entry: WikiEntry; score: number };

export type SearchOptions = {
  /** 주면 그 레포 + 프로젝트 독립 지식만. 안 주면 유저의 모든 레포. */
  repoId?: string;
  limit?: number;
  /** 벡터·하이브리드 전략은 임베더가 있어야 한다. 없으면 키워드로 떨어진다. */
  retriever?: Retriever;
};

export type SearchResult = {
  hits: SearchHit[];
  strategy: string;
  model: string | null;
  tookMs: number;
  /** 이 검색의 로그 id. 나중에 `recordUsage` 로 실제 사용을 표시할 수 있다. */
  logId: string;
};

/**
 * 검색 전략. 키워드/벡터/하이브리드가 같은 모양을 갖는다.
 *
 * 점수 스케일은 전략마다 제각각이라 서로 비교하면 안 된다 — 융합은
 * 점수가 아니라 순위로 한다(RRF).
 */
export type Retriever = {
  name: string;
  model: string | null;
  retrieve(
    store: Store,
    query: string,
    options: { repoId?: string; limit: number },
  ): Promise<ScoredId[]>;
};

export const keywordRetriever: Retriever = {
  name: "keyword",
  model: null,
  retrieve: async (store, query, options) => store.searchKeyword(query, options),
};

/**
 * 검색하고 **반드시 로그를 남긴다.**
 *
 * 로그는 평가 정답셋의 유일한 소급 불가 요소다. 그래서 호출부가 끄고 켤 수
 * 있는 옵션으로 두지 않고 검색 경로에 못박아둔다.
 */
export async function search(
  store: Store,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const retriever = options.retriever ?? keywordRetriever;
  const limit = options.limit ?? 10;

  const started = Date.now();
  const scored = await retriever.retrieve(store, query, { ...options, limit });
  const hits: SearchHit[] = [];
  for (const { id, score } of scored.slice(0, limit)) {
    const entry = store.getWikiEntry(id);
    // 인덱스가 실제 행보다 앞서 있을 수 있다(동기화 중간 상태). 조용히 건너뛴다.
    if (entry && entry.deletedAt === null) hits.push({ entry, score });
  }
  const tookMs = Date.now() - started;

  const log: SearchLog = {
    id: newId(),
    repoId: options.repoId ?? null,
    query,
    scope: options.repoId === undefined ? "all" : "repo",
    strategy: retriever.name,
    model: retriever.model,
    resultIds: hits.map((h) => h.entry.id),
    usedIds: [],
    tookMs,
    updatedAt: now(),
    deletedAt: null,
  };
  store.putSearchLog(log);

  return { hits, strategy: retriever.name, model: retriever.model, tookMs, logId: log.id };
}

/**
 * 검색 결과 중 실제로 써먹은 것을 표시한다.
 *
 * 이게 정답셋의 씨앗이다 — 나중에 "이 질문엔 이 문서가 나왔어야 했다"를
 * 라벨링할 때 사람이 맨땅에서 만들지 않아도 된다.
 */
export function recordUsage(store: Store, logId: string, usedIds: string[]): void {
  const log = store.getSearchLog(logId);
  if (!log) throw new Error(`검색 로그를 찾을 수 없다: ${logId}`);
  store.putSearchLog({ ...log, usedIds, updatedAt: now() });
}

// ---- index.md 컴파일 ----

const KIND_LABELS: Record<WikiEntryKind, string> = {
  concept: "개념",
  pattern: "패턴",
  gotcha: "함정",
  decision: "결정",
  reference: "참고",
};

/**
 * 엔트리들을 하나의 index.md 로 컴파일한다.
 *
 * **이 산출물은 커밋하지 않는다.** seed 문서에 기록된 사고가 바로 이걸
 * 커밋해서 생겼다 — 매 컴파일마다 통계와 정렬이 통째로 다시 쓰여서
 * 전체 커밋의 10%가 이 파일 하나였고, 두 곳에서 컴파일하면 100% 충돌했다.
 * 진실은 스토어에 있고 이건 사람이 읽으려고 뽑는 것이다.
 *
 * frontmatter 의 닫는 `---` 를 반드시 넣는다 — 기존 구현이 이걸 빠뜨려서
 * Obsidian 이 인식하지 못했다.
 */
export function compileIndex(
  store: Store,
  options: { repoId?: string; title?: string } = {},
): string {
  const entries = store
    .listWikiEntries(options.repoId)
    .sort((a, b) => a.title.localeCompare(b.title, "ko"));

  const byKind = new Map<WikiEntryKind, WikiEntry[]>();
  for (const entry of entries) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry);
    byKind.set(entry.kind, list);
  }

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${options.title ?? "wiki 색인"}`);
  lines.push(`entries: ${entries.length}`);
  lines.push("generated: true");
  lines.push("---");
  lines.push("");
  lines.push(`# ${options.title ?? "wiki 색인"}`);
  lines.push("");
  lines.push(
    "> 이 파일은 생성물이다. 고쳐도 다음 컴파일에 덮어써진다. 커밋하지 마라.",
  );
  lines.push("");

  if (entries.length === 0) {
    lines.push("아직 엔트리가 없다.");
    lines.push("");
    return lines.join("\n");
  }

  for (const kind of Object.keys(KIND_LABELS) as WikiEntryKind[]) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    lines.push(`## ${KIND_LABELS[kind]} (${list.length})`);
    lines.push("");
    for (const entry of list) {
      const tags = entry.tags.length > 0 ? ` — ${entry.tags.map((t) => `\`${t}\``).join(" ")}` : "";
      lines.push(`- **${entry.title}**${tags}`);
      const summary = firstLine(entry.body);
      if (summary) lines.push(`  ${summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** 본문의 첫 의미있는 줄. 색인에 한 줄 요약으로 붙인다. */
function firstLine(body: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    return line.length > 160 ? line.slice(0, 157) + "…" : line;
  }
  return null;
}
