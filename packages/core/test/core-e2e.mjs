/**
 * core 종단 테스트 — 두 대의 "머신"이 살아있는 서버를 통해 수렴하는지 본다.
 *
 * 오프라인 큐잉과 충돌 사본 보존은 단위 테스트로는 안 잡힌다. 실제로 로컬
 * SQLite 에 쓰고, HTTP 를 타고, 서버 SQLite 까지 갔다 와야 드러난다.
 *
 *   npm run dev -w @kybird/server        # 다른 터미널에서
 *   BASE=http://localhost:3000 npm run test:e2e -w @kybird/core
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  createCard,
  createRepo,
  editCard,
  moveCard,
  deleteCard,
  board,
  sync,
  register,
  OfflineError,
} from "../dist/index.js";

const BASE = process.env.BASE ?? "http://localhost:3000";

let failures = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("✗ " + msg);
    failures++;
  } else {
    console.log("✓ " + msg);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "knest-test-"));
const stores = [];
function machine(name) {
  const store = new Store(join(tmp, `${name}.db`));
  stores.push(store);
  return store;
}

const auth = await register(BASE, `core-${Date.now()}@example.com`, "hunter2hunter2");
const opts = { serverUrl: BASE, token: auth.token };

// ---- A: 레포와 카드를 만든다 ----
const A = machine("A");
const repo = createRepo(A, { name: "kybird-nest", path: "D:/Project/kybird-nest" });
const cols = A.listColumns(repo.id);
ok(cols.length === 3, `기본 컬럼 3개 (${cols.length})`);
ok(cols[0].title === "할 일", `첫 컬럼이 "할 일" (${cols[0].title})`);

const todo = cols[0];
const doing = cols[1];
const c1 = createCard(A, { repoId: repo.id, columnId: todo.id, title: "싱크 엔진" });
const c2 = createCard(A, { repoId: repo.id, columnId: todo.id, title: "칸반 UI" });
const c3 = createCard(A, { repoId: repo.id, columnId: todo.id, title: "MCP 표면" });

const pendingBefore = A.pending();
ok(
  pendingBefore.repos.length === 1 && pendingBefore.columns.length === 3 &&
    pendingBefore.cards.length === 3,
  `동기화 전 전부 dirty (레포 ${pendingBefore.repos.length}, 컬럼 ${pendingBefore.columns.length}, 카드 ${pendingBefore.cards.length})`,
);

const r1 = await sync(A, opts);
ok(r1.conflicts.length === 0 && r1.deferred.length === 0, "첫 동기화 충돌 없음");
ok(r1.pushed === 7, `7건 올림 (${r1.pushed})`);
const pendingAfter = A.pending();
ok(
  pendingAfter.repos.length + pendingAfter.columns.length + pendingAfter.cards.length === 0,
  "동기화 후 dirty 없음",
);

// ---- B: 백지에서 전부 받아온다 ----
const B = machine("B");
await sync(B, opts);
ok(B.listRepos().length === 1, `B 가 레포 수신 (${B.listRepos().length})`);
ok(B.listCards(todo.id).length === 3, `B 가 카드 3장 수신 (${B.listCards(todo.id).length})`);
ok(
  B.listCards(todo.id).map((c) => c.title).join(",") === "싱크 엔진,칸반 UI,MCP 표면",
  `B 에서 카드 순서 보존 (${B.listCards(todo.id).map((c) => c.title).join(",")})`,
);

// ---- 카드 이동이 순서로 반영되는지 ----
moveCard(B, c3.id, todo.id, 0);
await sync(B, opts);
await sync(A, opts);
ok(
  A.listCards(todo.id).map((c) => c.title).join(",") === "MCP 표면,싱크 엔진,칸반 UI",
  `이동이 A 로 전파 (${A.listCards(todo.id).map((c) => c.title).join(",")})`,
);

// 컬럼 간 이동
moveCard(A, c1.id, doing.id);
await sync(A, opts);
await sync(B, opts);
ok(B.listCards(doing.id).length === 1, `컬럼 간 이동 전파 (${B.listCards(doing.id).length})`);
ok(B.listCards(todo.id).length === 2, `원래 컬럼에서 빠짐 (${B.listCards(todo.id).length})`);

// ---- 오프라인: 서버에 못 닿아도 로컬 작업은 계속돼야 한다 ----
const offline = { serverUrl: "http://127.0.0.1:9", token: auth.token };
const offlineCard = createCard(A, { repoId: repo.id, columnId: todo.id, title: "오프라인에서 만듦" });
let threw = null;
try {
  await sync(A, offline);
} catch (e) {
  threw = e;
}
ok(threw instanceof OfflineError, `서버 불가 시 OfflineError (${threw?.name})`);
ok(A.getCard(offlineCard.id) !== null, "오프라인 중에도 로컬에는 남아있다");
ok(A.pending().cards.length === 1, `올리지 못한 변경이 큐에 남음 (${A.pending().cards.length})`);

// 다시 연결되면 flush
await sync(A, opts);
await sync(B, opts);
ok(
  B.getCard(offlineCard.id)?.title === "오프라인에서 만듦",
  `재연결 후 오프라인 변경이 B 까지 도달 (${B.getCard(offlineCard.id)?.title})`,
);

// ---- 충돌: 양쪽이 오프라인에서 같은 카드를 고친다 ----
// A 가 먼저 고치고 안 올린 사이, B 가 고쳐서 올린다. A 의 편집이 더 오래됐다.
editCard(A, c2.id, { title: "A 가 고친 제목" });
await new Promise((r) => setTimeout(r, 5));
editCard(B, c2.id, { title: "B 가 고친 제목" });
await sync(B, opts);

const r2 = await sync(A, opts);
ok(r2.conflicts.length === 1, `A 의 오래된 편집이 충돌로 처리됨 (${r2.conflicts.length})`);
ok(r2.conflicts[0]?.reason === "stale", `사유 stale (${r2.conflicts[0]?.reason})`);
ok(
  A.getCard(c2.id).title === "B 가 고친 제목",
  `A 가 서버(=B) 값으로 수렴 (${A.getCard(c2.id).title})`,
);

const conflicts = A.listConflicts();
ok(conflicts.length === 1, `진 값이 사본으로 보관됨 (${conflicts.length})`);
ok(
  JSON.parse(conflicts[0].payload).title === "A 가 고친 제목",
  `사본에 A 의 값이 그대로 (${JSON.parse(conflicts[0].payload).title})`,
);
ok(A.pending().cards.length === 0, "충돌 처리 후 dirty 가 남지 않는다");

// ---- 삭제 전파 ----
deleteCard(A, c3.id);
await sync(A, opts);
await sync(B, opts);
ok(B.getCard(c3.id)?.deletedAt !== null, "툼스톤 전파");
ok(
  !B.listCards(todo.id).some((c) => c.id === c3.id),
  "삭제된 카드는 목록에서 빠진다",
);

// ---- 보드 뷰가 양쪽에서 같은 모양인지 ----
const shape = (s) =>
  board(s, repo.id).columns.map((c) => `${c.column.title}:${c.cards.map((x) => x.title).join("|")}`).join(" / ");
ok(shape(A) === shape(B), `두 머신의 보드가 동일\n    A: ${shape(A)}\n    B: ${shape(B)}`);

// ---- 반복 동기화는 아무것도 바꾸지 않아야 한다 ----
const r3 = await sync(A, opts);
ok(r3.pushed === 0 && r3.pulled === 0, `변경 없을 때 무동작 (올림 ${r3.pushed}, 받음 ${r3.pulled})`);

for (const s of stores) s.close();
rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n실패 ${failures}건` : "\n전부 통과");
process.exit(failures ? 1 : 0);
