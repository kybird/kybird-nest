import { newId, now, type Embedding } from "@kybird/shared";
import type { ScoredId, Store } from "./store.js";
import type { Retriever } from "./wiki.js";

/**
 * 임베딩과 벡터 검색.
 *
 * 계산은 **전부 클라이언트**에서 한다 — 서버는 벡터를 blob 으로만 들고 있다
 * (brief.md 3장). 오프라인 우선이라 API 임베딩을 쓰면 서버가 없을 때 주입이
 * 막히므로 로컬 모델이 기본이다.
 *
 * 벡터마다 `model` 과 `dim` 을 같이 저장한다. 모델을 바꿔도 옛 벡터를 알아볼
 * 수 있어야 평가에서 "무엇을 바꿔서 좋아졌나"를 가릴 수 있다.
 */

export type Embedder = {
  /** 벡터와 함께 저장되는 식별자. 모델을 바꾸면 이 값도 바뀌어야 한다. */
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
};

/** 한국어가 섞인 코퍼스라 다국어 모델을 기본으로 둔다. */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

/**
 * transformers.js 로 도는 로컬 임베더.
 *
 * 동적 import 라 이 모듈을 불러오는 것만으로는 아무것도 로드하지 않는다.
 * 모델은 처음 쓸 때 한 번 내려받고 그 뒤로는 캐시에서 온다 — 그래서
 * 첫 실행만 네트워크가 필요하고 이후는 오프라인에서도 돈다.
 */
export function localEmbedder(model: string = DEFAULT_EMBEDDING_MODEL): Embedder {
  let pipe: ((texts: string[], options: object) => Promise<TensorLike>) | null = null;
  let dim = 0;

  async function ensurePipe() {
    if (pipe) return pipe;
    const { pipeline } = await import("@huggingface/transformers");
    const created = await pipeline("feature-extraction", model);
    pipe = created as unknown as (texts: string[], options: object) => Promise<TensorLike>;
    return pipe;
  }

  return {
    model,
    get dim() {
      return dim;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const run = await ensurePipe();
      // 평균 풀링 + 정규화. 정규화해두면 코사인 유사도가 내적과 같아진다.
      const output = await run(texts, { pooling: "mean", normalize: true });
      const rows = output.dims[0];
      const width = output.dims[1];
      if (rows === undefined || width === undefined) {
        throw new Error(`임베딩 출력 모양을 알 수 없다: ${JSON.stringify(output.dims)}`);
      }
      dim = width;

      const out: Float32Array[] = [];
      for (let i = 0; i < rows; i++) {
        out.push(Float32Array.from(output.data.slice(i * width, (i + 1) * width)));
      }
      return out;
    },
  };
}

type TensorLike = { dims: number[]; data: ArrayLike<number> & { slice(a: number, b: number): ArrayLike<number> } };

// ---- 직렬화 ----

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  // Buffer 는 풀링된 메모리를 공유할 수 있어서 그대로 뷰를 만들면 위험하다. 복사한다.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/** 정규화된 벡터끼리는 내적이 곧 코사인 유사도다. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

// ---- 인덱싱 ----

export type EmbedProgress = { done: number; total: number };

/**
 * 아직 벡터가 없거나 본문이 바뀐 엔트리들의 임베딩을 만든다.
 *
 * 배치로 끊어 돌리는 이유는 메모리 때문이다 — 수백 건을 한 번에 넣으면
 * 텐서가 통째로 올라간다.
 */
export async function ensureEmbeddings(
  store: Store,
  embedder: Embedder,
  options: { batchSize?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<number> {
  const pending = store.listEntriesWithoutEmbedding(embedder.model);
  if (pending.length === 0) return 0;

  const batchSize = options.batchSize ?? 16;
  let done = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map(embedText));

    store.transaction(() => {
      batch.forEach((entry, index) => {
        const vector = vectors[index];
        if (!vector) return;
        // 같은 엔트리·모델의 기존 벡터가 있으면 그 id 를 재사용한다.
        // 새 id 를 쓰면 낡은 벡터가 남아 검색에 두 번 걸린다.
        const existing = store.getEmbedding(entry.id, embedder.model);
        const embedding: Embedding = {
          id: existing?.id ?? newId(),
          entryId: entry.id,
          model: embedder.model,
          dim: vector.length,
          vector: encodeVector(vector),
          updatedAt: now(),
          deletedAt: null,
        };
        store.putEmbedding(embedding);
      });
    });

    done += batch.length;
    options.onProgress?.({ done, total: pending.length });
  }

  return done;
}

/** 임베딩에 넣을 텍스트. 제목을 앞에 붙여야 짧은 본문도 맥락을 갖는다. */
function embedText(entry: { title: string; body: string; tags: string[] }): string {
  const tags = entry.tags.length > 0 ? `\n태그: ${entry.tags.join(", ")}` : "";
  return `${entry.title}${tags}\n\n${entry.body}`.slice(0, 8000);
}

// ---- 검색 전략 ----

/**
 * 벡터 검색.
 *
 * 전체를 메모리에 올려 훑는다. 코퍼스가 수백~수천 건 규모라 이게 제일
 * 단순하고 충분히 빠르다. 수십만 건이 되면 ANN 인덱스가 필요하지만
 * 그때 가서 이 함수만 갈아끼우면 된다.
 */
export function vectorRetriever(embedder: Embedder): Retriever {
  return {
    name: "vector",
    model: embedder.model,
    async retrieve(store, query, options): Promise<ScoredId[]> {
      const [queryVector] = await embedder.embed([query]);
      if (!queryVector) return [];

      const allowed = new Set(store.listWikiEntries(options.repoId).map((e) => e.id));
      const scored: ScoredId[] = [];
      for (const embedding of store.listEmbeddings(embedder.model)) {
        if (!allowed.has(embedding.entryId)) continue;
        scored.push({ id: embedding.entryId, score: dot(queryVector, decodeVector(embedding.vector)) });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, options.limit);
    },
  };
}

/** RRF 상수. 클수록 상위권 쏠림이 완만해진다. 60 이 관례적인 값이다. */
const RRF_K = 60;

/**
 * 여러 전략을 순위로 융합한다 (Reciprocal Rank Fusion).
 *
 * **점수로 섞지 않는 게 핵심이다.** bm25 와 코사인 유사도는 스케일도
 * 분포도 달라서 정규화해봐야 임의의 가중치가 생길 뿐이다. 순위만 쓰면
 * 그 문제가 사라진다.
 */
export function hybridRetriever(parts: Retriever[], name = "hybrid-rrf"): Retriever {
  return {
    name,
    model: parts.map((p) => p.model).find((m) => m !== null) ?? null,
    async retrieve(store, query, options): Promise<ScoredId[]> {
      // 융합 품질을 위해 각 전략에서 넉넉히 받아온다.
      const perPart = Math.max(options.limit * 3, 30);
      const lists = await Promise.all(
        parts.map((part) => part.retrieve(store, query, { ...options, limit: perPart })),
      );

      const fused = new Map<string, number>();
      for (const list of lists) {
        list.forEach((hit, rank) => {
          fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
        });
      }

      return [...fused.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit);
    },
  };
}
