import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureRaw,
  compileIndex,
  DEFAULT_EMBEDDING_MODEL,
  ensureEmbeddings,
  hybridRetriever,
  inject,
  keywordRetriever,
  localEmbedder,
  removeEntry,
  search,
  vectorRetriever,
  type Retriever,
  type Store,
} from "@kybird/core";
import type { WikiEntryKind } from "@kybird/shared";

export const WIKI_HELP = `knest wiki — 프로젝트 지식

  knest wiki add <제목> [--kind 종류] [--tag 태그]... [--body 본문] [--global]
      본문을 안 주면 표준입력에서 읽는다.
      종류: concept | pattern | gotcha | decision | reference

  knest wiki raw [메모]
      다듬지 않은 원본을 가볍게 남긴다. 메모를 안 주면 표준입력에서 읽는다.
      git 레포면 사용자별 파일(doc/raw/<나>/<날짜>.md)에 바로 커밋된다 —
      나중에 knest backfill 로 다시 떠올라 정식 엔트리로 압축될 수 있다.

  knest wiki search <질의> [--all] [--keyword|--semantic] [--limit N]
      기본은 하이브리드(키워드+벡터). --all 이면 내 모든 레포를 뒤진다.

  knest wiki list [--all]
  knest wiki show <엔트리>
  knest wiki rm <엔트리>
  knest wiki index [--out 경로] [--all]      색인을 만든다 (생성물, 커밋 금지)
  knest wiki embed                            아직 없는 벡터를 만든다
  knest wiki logs [--limit N]                 검색 기록
`;

type Ctx = { store: Store; repoId: string; repoPath: string; author: string };

export async function wikiCommand(argv: string[], ctx: Ctx): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return add(rest, ctx);
    case "raw":
      return raw(rest, ctx);
    case "search":
      return searchCmd(rest, ctx);
    case "list":
      return list(rest, ctx);
    case "show":
      return show(rest, ctx);
    case "rm":
      return remove(rest, ctx);
    case "index":
      return index(rest, ctx);
    case "embed":
      return embed(ctx);
    case "logs":
      return logs(rest, ctx);
    default:
      process.stdout.write(WIKI_HELP);
      return sub === undefined || sub === "help" ? 0 : 1;
  }
}

async function add(argv: string[], { store, repoId }: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      tag: { type: "string", multiple: true },
      body: { type: "string" },
      global: { type: "boolean" },
      source: { type: "string" },
    },
    allowPositionals: true,
  });

  const title = positionals.join(" ").trim();
  if (!title) {
    process.stderr.write("제목이 필요하다: knest wiki add <제목>\n");
    return 1;
  }

  const body = values.body ?? (await readStdin());
  if (!body.trim()) {
    process.stderr.write("본문이 비었다. --body 로 주거나 표준입력으로 넣어라.\n");
    return 1;
  }

  const kind = (values.kind ?? "concept") as WikiEntryKind;
  const entry = inject(store, {
    // --global 은 특정 프로젝트에 매이지 않는 지식이라는 뜻이다.
    repoId: values.global ? null : repoId,
    title,
    body: body.trim(),
    kind,
    tags: values.tag ?? [],
    sourceRef: values.source ?? null,
  });

  process.stdout.write(`${short(entry.id)}  ${entry.title}  [${entry.kind}]\n`);
  return 0;
}

async function raw(argv: string[], ctx: Ctx): Promise<number> {
  const note = (argv.join(" ").trim() || (await readStdin())).trim();
  if (!note) {
    process.stderr.write("메모가 비었다: knest wiki raw <메모> (또는 표준입력)\n");
    return 1;
  }

  const result = captureRaw(ctx.repoPath, ctx.author, note);
  if (!result.committed) {
    process.stdout.write(
      `이 기기에만 남겼다 (커밋 안 됨 — git 레포가 아니거나 실패): ${result.filePath}\n`,
    );
    return 0;
  }

  // 훅이 안 깔려있어도 큐에 바로 넣는다 — (repoId, ref) 유니크라 훅이
  // 나중에 같은 커밋을 또 넣어도 안전하다.
  if (result.commitSha) {
    ctx.store.enqueueIngest({
      repoId: ctx.repoId,
      repoPath: ctx.repoPath,
      kind: "commit",
      ref: result.commitSha,
    });
  }
  process.stdout.write(`커밋했다: ${result.commitSha?.slice(0, 7) ?? "?"}  ${result.filePath}\n`);
  return 0;
}

async function searchCmd(argv: string[], { store, repoId }: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean" },
      keyword: { type: "boolean" },
      semantic: { type: "boolean" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });

  const query = positionals.join(" ").trim();
  if (!query) {
    process.stderr.write("질의가 필요하다: knest wiki search <질의>\n");
    return 1;
  }

  const scope = values.all ? undefined : repoId;
  const retriever = pickRetriever(store, values);
  const limit = values.limit ? Number(values.limit) : 10;

  const result = await search(store, query, { repoId: scope, limit, retriever });

  if (result.hits.length === 0) {
    process.stdout.write("결과 없음.\n");
    if (retriever.name === "keyword") {
      process.stdout.write("(벡터 검색을 쓰려면 knest wiki embed 를 먼저 돌려라)\n");
    }
    return 0;
  }

  process.stdout.write(`\n  ${result.strategy} · ${result.tookMs}ms\n\n`);
  result.hits.forEach((hit, i) => {
    const tags = hit.entry.tags.length > 0 ? `  ${hit.entry.tags.map((t) => `#${t}`).join(" ")}` : "";
    const where = hit.entry.repoId === null ? "  (전역)" : "";
    process.stdout.write(
      `  ${String(i + 1).padStart(2)}. ${hit.entry.title}${where}\n` +
        // RRF 점수는 1/(60+순위) 규모라 소수점을 넉넉히 보여야 구분이 된다.
        `      ${short(hit.entry.id)}  [${hit.entry.kind}]  ${hit.score.toFixed(4)}${tags}\n` +
        `      ${snippet(hit.entry.body)}\n\n`,
    );
  });

  // 에이전트가 이 로그 id 로 "실제로 뭘 썼는지" 되돌려줄 수 있다.
  process.stdout.write(`  로그: ${result.logId}\n\n`);
  return 0;
}

/**
 * 벡터가 하나도 없는데 하이브리드를 고르면 사실상 키워드만 돌면서
 * 이름만 하이브리드인 로그가 남는다. 평가 로그가 더러워지므로 실제로
 * 쓸 수 있을 때만 벡터를 붙인다.
 */
function pickRetriever(
  store: Store,
  values: { keyword?: boolean; semantic?: boolean },
): Retriever {
  if (values.keyword) return keywordRetriever;

  const hasVectors = store.listEmbeddings(DEFAULT_EMBEDDING_MODEL).length > 0;
  if (!hasVectors) return keywordRetriever;

  const vector = vectorRetriever(localEmbedder(DEFAULT_EMBEDDING_MODEL));
  return values.semantic ? vector : hybridRetriever([keywordRetriever, vector]);
}

function list(argv: string[], { store, repoId }: Ctx): number {
  const { values } = parseArgs({
    args: argv,
    options: { all: { type: "boolean" } },
    allowPositionals: false,
  });
  const entries = store.listWikiEntries(values.all ? undefined : repoId);
  if (entries.length === 0) {
    process.stdout.write("엔트리가 없다.\n");
    return 0;
  }
  for (const entry of entries.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const where = entry.repoId === null ? " (전역)" : "";
    process.stdout.write(`${short(entry.id)}  [${entry.kind.padEnd(9)}] ${entry.title}${where}\n`);
  }
  process.stdout.write(`\n${entries.length}건\n`);
  return 0;
}

function show(argv: string[], ctx: Ctx): number {
  const entry = findEntry(argv[0], ctx);
  if (!entry) return 1;
  process.stdout.write(`\n# ${entry.title}\n\n`);
  process.stdout.write(`종류: ${entry.kind}\n`);
  if (entry.tags.length > 0) process.stdout.write(`태그: ${entry.tags.join(", ")}\n`);
  if (entry.sourceRef) process.stdout.write(`출처: ${entry.sourceRef}\n`);
  process.stdout.write(`\n${entry.body}\n\n`);
  return 0;
}

function remove(argv: string[], ctx: Ctx): number {
  const entry = findEntry(argv[0], ctx);
  if (!entry) return 1;
  removeEntry(ctx.store, entry.id);
  process.stdout.write(`지웠다: ${entry.title}\n`);
  return 0;
}

function index(argv: string[], { store, repoId }: Ctx): number {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, all: { type: "boolean" } },
    allowPositionals: false,
  });

  const scope = values.all ? undefined : repoId;
  const repo = store.getRepo(repoId);
  const markdown = compileIndex(store, {
    repoId: scope,
    title: values.all ? "wiki 색인 (전체)" : `${repo?.name ?? "wiki"} 색인`,
  });

  if (!values.out) {
    process.stdout.write(markdown);
    return 0;
  }
  const path = resolve(values.out);
  writeFileSync(path, markdown, "utf8");
  process.stdout.write(`${path}\n`);
  process.stdout.write("생성물이다. .gitignore 에 넣어라.\n");
  return 0;
}

async function embed({ store }: Ctx): Promise<number> {
  const embedder = localEmbedder();
  const pending = store.listEntriesWithoutEmbedding(embedder.model).length;
  if (pending === 0) {
    process.stdout.write("만들 벡터가 없다.\n");
    return 0;
  }

  process.stdout.write(`${pending}건 임베딩한다. 모델을 처음 쓰면 내려받느라 좀 걸린다…\n`);
  const done = await ensureEmbeddings(store, embedder, {
    onProgress: ({ done: d, total }) => {
      process.stdout.write(`\r  ${d}/${total}`);
    },
  });
  process.stdout.write(`\r  ${done}/${pending} 완료\n`);
  return 0;
}

function logs(argv: string[], { store }: Ctx): number {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: "string" } },
    allowPositionals: false,
  });
  const records = store.listSearchLogs(values.limit ? Number(values.limit) : 20);
  if (records.length === 0) {
    process.stdout.write("검색 기록이 없다.\n");
    return 0;
  }
  for (const log of records) {
    const used = log.usedIds.length > 0 ? `  사용 ${log.usedIds.length}` : "";
    process.stdout.write(
      `${new Date(log.updatedAt).toLocaleString()}  [${log.strategy}]  "${log.query}"\n` +
        `  결과 ${log.resultIds.length}건  ${log.tookMs}ms${used}\n`,
    );
  }
  return 0;
}

// ---- 거들기 ----

function findEntry(ref: string | undefined, { store, repoId }: Ctx) {
  if (!ref) {
    process.stderr.write("엔트리를 지정해라.\n");
    return null;
  }
  // 전역 지식도 대상이므로 레포 한정 목록에서 찾는다(그 안에 전역이 포함된다).
  const matches = store.listWikiEntries(repoId).filter((e) => e.id.startsWith(ref));
  if (matches.length === 0) {
    process.stderr.write(`엔트리를 찾을 수 없다: ${ref}\n`);
    return null;
  }
  if (matches.length > 1) {
    process.stderr.write(`"${ref}" 로 시작하는 엔트리가 ${matches.length}개다. 더 길게 써라.\n`);
    return null;
  }
  return matches[0]!;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function snippet(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  return line.length > 90 ? line.slice(0, 87) + "…" : line;
}

function short(id: string): string {
  return id.slice(0, 7);
}
