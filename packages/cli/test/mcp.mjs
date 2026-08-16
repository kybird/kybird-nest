/**
 * MCP 서버를 실제 클라이언트로 붙어서 확인한다.
 * 도구가 등록만 되고 실제로는 안 돌아가는 일이 흔해서, 호출까지 해본다.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 이 파일 기준으로 찾는다. 절대경로를 박아두면 그 사람 머신에서만 돈다
// (실제로 Windows 경로가 박혀 있어서 다른 OS 에서는 아예 실행이 안 됐다).
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const cwd = process.env.PROJ;

let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗ " + m); fails++; } else console.log("✓ " + m); };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, "mcp"],
  cwd,
  env: { ...process.env, KYBIRD_HOME: process.env.KYBIRD_HOME },
  stderr: "pipe",
});

const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("  도구:", names.join(", "), "\n");
ok(names.includes("wiki_search") && names.includes("wiki_log"), "핵심 wiki 도구가 등록됨");
ok(names.includes("wiki_pending") && names.includes("wiki_pending_done"), "backfill 도구가 등록됨");
ok(names.includes("kanban_board") && names.includes("kanban_add_card"), "칸반 도구가 등록됨");

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content.map((c) => c.text).join("\n");
};

// --- 빈 상태 검색: 결과가 없어도 기록을 권해야 한다 ---
const empty = await call("wiki_search", { query: "분수 랭크가 뭔가" });
ok(empty.includes("wiki_log"), "결과가 없을 때도 기록을 권한다");

// --- 기록 ---
const logged = await call("wiki_log", {
  title: "분수 랭크",
  body: "정수 순서는 오프라인에서 두 머신이 카드를 옮기면 반드시 충돌한다.\n문자열로 사이값을 계속 만들 수 있게 한다.",
  kind: "gotcha",
  tags: ["kanban", "sync"],
});
ok(logged.includes("기록했다"), `wiki_log 동작 (${logged.split("\n")[0]})`);

// --- 검색하면 나오고, 리마인더가 붙는가 ---
const found = await call("wiki_search", { query: "랭크" });
ok(found.includes("분수 랭크"), "기록한 게 바로 검색된다");
ok(found.includes("wiki_log"), "검색 응답에 기록 리마인더가 실려 나간다");
ok(found.includes("검색 로그 id:"), "로그 id 를 돌려줘서 사용 표시가 가능하다");

const logId = found.match(/검색 로그 id: (\S+)/)?.[1];
ok(!!logId, `로그 id 추출 (${logId})`);
const entryId = found.match(/id: (\S+) ·/)?.[1];
const marked = await call("wiki_mark_used", { logId, entryIds: [entryId] });
ok(marked.includes("표시했다"), "wiki_mark_used 동작");

// --- 색인 ---
const index = await call("wiki_index", {});
ok(index.includes("## 함정") && index.includes("분수 랭크"), "wiki_index 가 색인을 만든다");
ok(index.startsWith("---"), "frontmatter 로 시작한다");

// --- backfill ---
const pending = await call("wiki_pending", {});
ok(pending.includes("커밋") && pending.includes("diff --git"), "wiki_pending 이 커밋 재료를 준다");
const queueId = Number(pending.match(/### 큐 (\d+)/)?.[1]);
ok(Number.isInteger(queueId), `큐 id 추출 (${queueId})`);
const doneMsg = await call("wiki_pending_done", { queueIds: [queueId] });
ok(doneMsg.includes("남은 대기: 0건"), `완료 표시 후 큐가 빈다 (${doneMsg.trim()})`);
const afterDone = await call("wiki_pending", {});
ok(afterDone.includes("소화할 커밋이 없다"), "처리한 커밋은 다시 나오지 않는다");

// --- 칸반 ---
const boardBefore = await call("kanban_board", {});
ok(boardBefore.includes("할 일"), "kanban_board 가 보드를 보여준다");
const colId = boardBefore.match(/컬럼 id: (\S+)/)?.[1];
const added = await call("kanban_add_card", { title: "에이전트가 만든 카드" });
ok(added.includes("추가했다"), "kanban_add_card 동작");

const cardId = (await call("kanban_board", {})).match(/에이전트가 만든 카드\s+\(id: (\S+)\)/)?.[1];
const cols = [...boardBefore.matchAll(/컬럼 id: (\S+)/g)].map((m) => m[1]);
const moved = await call("kanban_move_card", { cardId, columnId: cols[2] });
ok(moved.includes("옮겼다"), "kanban_move_card 동작");
const boardAfter = await call("kanban_board", {});
ok(/## 완료 \(1\)/.test(boardAfter), "이동이 보드에 반영된다");
void colId;

// --- 기각: 완료된 카드를 상류로 되돌린다 ---
const rejected = await call("kanban_reject_card", {
  cardId,
  reason: "로그인 후 새로고침하면 세션이 풀린다",
});
ok(rejected.includes("QA 기각"), "기본 기각 주체는 QA 다");
ok(rejected.includes("개발이 받는다"), "QA 기각은 개발이 받는다");
ok(rejected.includes("회귀 1회"), "기각은 회귀로 잡힌다");

const afterReject = await call("kanban_board", {});
ok(/## 완료 \(0\)/.test(afterReject), "기각하면 완료에서 빠진다");

// 사유는 필수다 — 빈 사유로는 기각이 안 돼야 한다.
// SDK 는 도구가 던진 예외를 클라이언트 예외로 올리지 않고 isError 로 돌려준다.
const blank = await client.callTool({
  name: "kanban_reject_card",
  arguments: { cardId, reason: "   " },
});
ok(blank.isError === true, "빈 사유는 거부한다");

// 개발 기각은 기획으로 올라간다.
const devReject = await call("kanban_reject_card", {
  cardId,
  reason: "요구사항 자체가 오프라인을 고려하지 않았다",
  by: "dev",
});
ok(devReject.includes("기획이 받는다"), "개발 기각은 기획이 받는다");

await client.close();
console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
