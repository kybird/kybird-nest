import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_EMBEDDING_MODEL,
  OfflineError,
  Store,
  board,
  captureRaw,
  collectBackfill,
  compileIndex,
  createCard,
  ensureEmbeddings,
  formatMaterial,
  hybridRetriever,
  inject,
  keywordRetriever,
  loadConfig,
  localEmbedder,
  moveCard,
  recordUsage,
  search,
  storePath,
  sync,
  vectorRetriever,
  type Retriever,
} from "@kybird/core";
import { wikiEntryKindSchema } from "@kybird/shared";

/**
 * MCP 표면.
 *
 * 에이전트마다 훅 체계가 달라서 N개를 지원하는 건 무리다. MCP 는 Claude Code,
 * Cursor, Windsurf, Copilot 이 모두 지원하므로 여기 하나만 만들면 된다.
 *
 * MCP 역시 에이전트가 "부르기로 선택"해야 하는 건 마찬가지다. 그래서
 * **검색 응답에 리마인더를 실어 보낸다** — 에이전트는 wiki_search 를
 * 자발적으로 쓰므로(자기한테 이득이니까), 그 순간이 기록을 부탁할 유일한
 * 확실한 접점이다. AGENTS.md 는 세션 시작에 한 번 읽히고 잊힌다.
 */

type Ctx = { store: Store; repoId: string; repoPath: string };

const REMINDER =
  "이 결과로 작업을 진행했다면, 끝난 뒤 새로 알게 된 것을 wiki_log 로 남겨라. " +
  "다음 세션의 너(혹은 다른 사람)가 같은 걸 다시 알아내지 않아도 된다.";

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** 벡터가 하나도 없으면 이름만 하이브리드인 로그가 남아 평가가 더러워진다. */
function pickRetriever(store: Store, mode: "auto" | "keyword" | "semantic"): Retriever {
  if (mode === "keyword") return keywordRetriever;
  if (store.listEmbeddings(DEFAULT_EMBEDDING_MODEL).length === 0) return keywordRetriever;
  const vector = vectorRetriever(localEmbedder(DEFAULT_EMBEDDING_MODEL));
  return mode === "semantic" ? vector : hybridRetriever([keywordRetriever, vector]);
}

/** 서버가 없어도 로컬 작업은 계속돼야 한다. */
async function trySync(store: Store): Promise<string> {
  const config = loadConfig();
  if (!config.token) return "(로그인 안 됨 — 로컬에만 저장했다)";
  try {
    const report = await sync(store, { serverUrl: config.serverUrl, token: config.token });
    return report.conflicts.length > 0 ? `(동기화됨, 충돌 ${report.conflicts.length}건)` : "";
  } catch (error) {
    if (error instanceof OfflineError) return "(서버에 못 닿아 로컬에만 저장했다. 나중에 동기화된다)";
    throw error;
  }
}

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "kybird-nest", version: "0.0.0" });

  // ---- wiki ----

  server.registerTool(
    "wiki_search",
    {
      title: "프로젝트 지식 검색",
      description:
        "이 프로젝트(와 전역)에 쌓인 지식을 검색한다. 코드를 파헤치기 전에 먼저 여기를 " +
        "찾아보면 이미 해결된 문제를 다시 풀지 않는다. 키워드와 의미 검색을 함께 쓴다.",
      inputSchema: {
        query: z.string().describe("찾고 싶은 것. 자연어 문장이어도 된다"),
        scope: z
          .enum(["repo", "all"])
          .optional()
          .describe("repo=이 프로젝트만(기본), all=내 모든 프로젝트"),
        limit: z.number().int().min(1).max(30).optional(),
        mode: z.enum(["auto", "keyword", "semantic"]).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ query, scope, limit, mode }) => {
      const result = await search(ctx.store, query, {
        repoId: scope === "all" ? undefined : ctx.repoId,
        limit: limit ?? 8,
        retriever: pickRetriever(ctx.store, mode ?? "auto"),
      });

      if (result.hits.length === 0) {
        return text(
          `"${query}" 에 대한 지식이 아직 없다.\n\n` +
            `이번에 알아낸 게 있으면 wiki_log 로 남겨라 — 다음엔 여기서 바로 나온다.`,
        );
      }

      const body = result.hits
        .map((hit, i) => {
          const tags = hit.entry.tags.length > 0 ? ` [${hit.entry.tags.join(", ")}]` : "";
          const where = hit.entry.repoId === null ? " (전역)" : "";
          return (
            `## ${i + 1}. ${hit.entry.title}${where}\n` +
            `id: ${hit.entry.id} · 종류: ${hit.entry.kind}${tags}\n\n` +
            hit.entry.body
          );
        })
        .join("\n\n---\n\n");

      // 리마인더를 결과 뒤에 붙인다. 에이전트가 관심을 갖는 바로 그 순간이다.
      return text(
        `${result.hits.length}건 (${result.strategy}, ${result.tookMs}ms)\n\n${body}\n\n---\n\n` +
          `검색 로그 id: ${result.logId}\n` +
          `실제로 쓴 항목이 있으면 wiki_mark_used 로 알려주면 검색 품질 개선에 쓰인다.\n\n` +
          REMINDER,
      );
    },
  );

  server.registerTool(
    "wiki_log",
    {
      title: "알게 된 것 기록",
      description:
        "새로 알아낸 것을 프로젝트 지식으로 남긴다. 다음 세션이 같은 걸 다시 " +
        "알아내지 않게 하는 게 목적이므로, 결론뿐 아니라 '왜 그런지'를 같이 적어라.",
      inputSchema: {
        title: z.string().describe("한 줄 제목"),
        body: z.string().describe("본문(마크다운). 결론과 근거를 같이"),
        kind: wikiEntryKindSchema
          .optional()
          .describe("concept=개념, pattern=반복되는 해법, gotcha=함정, decision=결정, reference=참고"),
        tags: z.array(z.string()).optional(),
        global: z
          .boolean()
          .optional()
          .describe("이 프로젝트에 매이지 않는 일반 지식이면 true"),
        sourceRef: z.string().optional().describe("커밋 해시나 카드 id 등 출처"),
      },
    },
    async ({ title, body, kind, tags, global: isGlobal, sourceRef }) => {
      const entry = inject(ctx.store, {
        repoId: isGlobal ? null : ctx.repoId,
        title,
        body,
        kind,
        tags,
        sourceRef: sourceRef ?? null,
      });
      const note = await trySync(ctx.store);
      return text(`기록했다: ${entry.title} (${entry.id})${note ? `\n${note}` : ""}`);
    },
  );

  server.registerTool(
    "wiki_raw",
    {
      title: "raw 메모 남기기",
      description:
        "다듬지 않은 원본을 가볍게 남긴다 — wiki_log 보다 훨씬 저비용이다. 판단이 " +
        "덜 선 것, 정리는 나중에 하고 싶은 것을 형식 없이 던져두면 된다. git 레포면 " +
        "곧바로 커밋돼서(사용자별 파일이라 다른 사람과 충돌 없음) 팀에 공유되고, " +
        "나중에 wiki_pending 으로 다시 떠올라 wiki_log 로 압축될 수 있다.",
      inputSchema: { note: z.string().describe("raw 메모. 형식 자유, 다듬지 않아도 된다") },
    },
    async ({ note }) => {
      const config = loadConfig();
      const author = config.email ?? "anonymous";
      const result = captureRaw(ctx.repoPath, author, note);

      if (!result.committed) {
        return text(
          `이 기기에만 남겼다 (커밋 안 됨 — git 레포가 아니거나 실패): ${result.filePath}`,
        );
      }

      // 훅이 안 깔려있어도 큐에 바로 넣는다 — enqueueIngest 는 (repoId, ref)
      // 유니크라 훅이 나중에 같은 커밋을 또 넣어도 안전하다.
      if (result.commitSha) {
        ctx.store.enqueueIngest({
          repoId: ctx.repoId,
          repoPath: ctx.repoPath,
          kind: "commit",
          ref: result.commitSha,
        });
      }

      return text(
        `raw 메모를 커밋했다 (${result.commitSha?.slice(0, 7) ?? "?"}). ` +
          "나중에 wiki_pending 으로 다시 떠오른다.",
      );
    },
  );

  server.registerTool(
    "wiki_mark_used",
    {
      title: "검색 결과 사용 표시",
      description:
        "검색 결과 중 실제로 도움이 된 항목을 표시한다. 검색 품질을 재는 " +
        "정답셋이 여기서 만들어진다.",
      inputSchema: {
        logId: z.string().describe("wiki_search 가 돌려준 검색 로그 id"),
        entryIds: z.array(z.string()).describe("실제로 써먹은 엔트리 id 들"),
      },
    },
    async ({ logId, entryIds }) => {
      recordUsage(ctx.store, logId, entryIds);
      await trySync(ctx.store);
      return text(`표시했다: ${entryIds.length}건`);
    },
  );

  server.registerTool(
    "wiki_index",
    {
      title: "지식 색인",
      description:
        "이 프로젝트에 무슨 지식이 있는지 한눈에 본다. 무엇을 검색해야 할지 " +
        "모를 때 먼저 훑어보면 된다.",
      inputSchema: { scope: z.enum(["repo", "all"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ scope }) => {
      const repo = ctx.store.getRepo(ctx.repoId);
      return text(
        compileIndex(ctx.store, {
          repoId: scope === "all" ? undefined : ctx.repoId,
          title: scope === "all" ? "wiki 색인 (전체)" : `${repo?.name ?? "wiki"} 색인`,
        }),
      );
    },
  );

  // ---- backfill ----

  server.registerTool(
    "wiki_pending",
    {
      title: "아직 소화되지 않은 커밋",
      description:
        "지식으로 정리되지 않은 커밋의 내용과 diff 를 꺼내온다. 읽어보고 남길 만한 " +
        "게 있으면 wiki_log 로 기록한 뒤 wiki_pending_done 으로 처리 완료 표시를 해라. " +
        "오타 수정처럼 남길 게 없는 커밋이면 기록 없이 완료 표시만 해도 된다.",
      inputSchema: { limit: z.number().int().min(1).max(5).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const items = collectBackfill(ctx.store, { repoId: ctx.repoId, limit: limit ?? 2 });
      if (items.length === 0) {
        return text("소화할 커밋이 없다.");
      }
      const remaining = ctx.store.countPendingIngest(ctx.repoId);
      const body = items
        .map((item) => `### 큐 ${item.queueId}\n\n${formatMaterial(item)}`)
        .join("\n\n===\n\n");
      return text(`대기 ${remaining}건 중 ${items.length}건\n\n${body}`);
    },
  );

  server.registerTool(
    "wiki_pending_done",
    {
      title: "커밋 소화 완료 표시",
      description: "wiki_pending 으로 받은 항목을 처리했다고 표시한다.",
      inputSchema: { queueIds: z.array(z.number().int()) },
    },
    async ({ queueIds }) => {
      for (const id of queueIds) ctx.store.markIngested(id);
      return text(`${queueIds.length}건 완료 표시. 남은 대기: ${ctx.store.countPendingIngest(ctx.repoId)}건`);
    },
  );

  server.registerTool(
    "wiki_embed",
    {
      title: "의미 검색 인덱스 갱신",
      description:
        "아직 벡터가 없는 엔트리의 임베딩을 만든다. 지식을 많이 넣은 뒤 한 번 " +
        "돌려두면 의미 검색이 켜진다.",
    },
    async () => {
      const embedder = localEmbedder();
      const pending = ctx.store.listEntriesWithoutEmbedding(embedder.model).length;
      if (pending === 0) return text("만들 벡터가 없다.");
      const done = await ensureEmbeddings(ctx.store, embedder);
      await trySync(ctx.store);
      return text(`${done}건 임베딩했다.`);
    },
  );

  // ---- 칸반 ----

  server.registerTool(
    "kanban_board",
    {
      title: "칸반 보드 보기",
      description: "이 프로젝트의 할 일 현황.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const view = board(ctx.store, ctx.repoId);
      const body = view.columns
        .map(({ column, cards }) => {
          const list =
            cards.length === 0
              ? "  (없음)"
              : cards.map((c) => `  - ${c.title}  (id: ${c.id})`).join("\n");
          return `## ${column.title} (${cards.length})\n  컬럼 id: ${column.id}\n${list}`;
        })
        .join("\n\n");
      return text(`# ${view.repo.name}\n\n${body}`);
    },
  );

  server.registerTool(
    "kanban_add_card",
    {
      title: "카드 추가",
      description: "할 일을 추가한다. 컬럼을 안 주면 첫 컬럼에 들어간다.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        columnId: z.string().optional(),
      },
    },
    async ({ title, body, columnId }) => {
      const columns = ctx.store.listColumns(ctx.repoId);
      const column = columnId ? columns.find((c) => c.id === columnId) : columns[0];
      if (!column) return text(`컬럼을 찾을 수 없다: ${columnId}`);
      const card = createCard(ctx.store, {
        repoId: ctx.repoId,
        columnId: column.id,
        title,
        body,
      });
      const note = await trySync(ctx.store);
      return text(`추가했다: ${card.title} → ${column.title} (${card.id})${note ? `\n${note}` : ""}`);
    },
  );

  server.registerTool(
    "kanban_move_card",
    {
      title: "카드 옮기기",
      description: "카드를 다른 컬럼으로 옮긴다. 작업을 끝냈으면 완료 컬럼으로.",
      inputSchema: {
        cardId: z.string(),
        columnId: z.string(),
        position: z.number().int().min(0).optional(),
      },
    },
    async ({ cardId, columnId, position }) => {
      const card = moveCard(ctx.store, cardId, columnId, position);
      const note = await trySync(ctx.store);
      return text(`옮겼다: ${card.title}${note ? `\n${note}` : ""}`);
    },
  );

  return server;
}

export async function runMcp(ctx: Ctx): Promise<never> {
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());

  // stdio 를 프로토콜이 쓰고 있으므로 로그를 stdout 에 쓰면 안 된다.
  process.stderr.write(`kybird-nest MCP 서버 시작 (스토어: ${storePath()})\n`);

  return new Promise<never>(() => {
    // 전송이 닫힐 때까지 산다.
  });
}
