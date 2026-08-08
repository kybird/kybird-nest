/**
 * 싱크 프로토콜 종단 테스트.
 *
 * 두 클라이언트를 흉내내서 실제로 수렴하는지 본다. 싱크는 단위 테스트로는
 * 안 잡히는 종류의 버그(커서 전진, 순서, 격리)가 나오는 곳이라 살아있는
 * 서버를 상대로 돌린다.
 *
 *   npm run dev -w @kybird/server        # 다른 터미널에서
 *   BASE=http://localhost:3000 npm run test:e2e -w @kybird/server
 */
const BASE = process.env.BASE ?? "http://localhost:3000";

const cuid = () => "c" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
let clock = Date.now();
const tick = () => ++clock;

async function api(path, body, token) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} → ${res.status} 비JSON 응답: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

function ok(cond, msg) {
  if (!cond) {
    console.error("✗ " + msg);
    process.exitCode = 1;
  } else {
    console.log("✓ " + msg);
  }
}

const empty = () => ({ repos: [], columns: [], cards: [] });

// 클라이언트 흉내: 로컬 스토어 + 커서
function makeClient(token, name) {
  return {
    name,
    token,
    cursor: 0,
    store: { repos: new Map(), columns: new Map(), cards: new Map() },
    pending: empty(),
    async sync() {
      const { status, json } = await api(
        "/api/sync",
        { cursor: this.cursor, changes: this.pending },
        this.token,
      );
      if (status !== 200) throw new Error(`${name} sync 실패 ${status}: ${JSON.stringify(json)}`);
      this.pending = empty();
      this.cursor = json.cursor;
      for (const kind of ["repos", "columns", "cards"]) {
        for (const row of json.changes[kind]) this.store[kind].set(row.id, row);
      }
      return json;
    },
  };
}

const email = `test-${Date.now()}@example.com`;
const reg = await api("/api/auth/register", { email, password: "hunter2hunter2" });
ok(reg.status === 201, `회원가입 201 (받은 값: ${reg.status})`);
const token = reg.json.token;
ok(typeof token === "string" && token.length > 20, "토큰 발급");

const login = await api("/api/auth/login", { email, password: "hunter2hunter2" });
ok(login.status === 200, "로그인 200");
const bad = await api("/api/auth/login", { email, password: "wrongwrongwrong" });
ok(bad.status === 401, "틀린 비밀번호 401");

const noAuth = await api("/api/sync", { cursor: 0, changes: empty() });
ok(noAuth.status === 401, "토큰 없이 sync 하면 401");

// --- A 가 레포/컬럼/카드를 만든다 ---
const A = makeClient(token, "A");
const repoId = cuid();
const colId = cuid();
const card1 = cuid();
const card2 = cuid();

A.pending.repos.push({
  id: repoId,
  name: "kybird-nest",
  path: "D:/Project/kybird-nest",
  gitRemote: "https://github.com/kybird/kybird-nest.git",
  updatedAt: tick(),
  deletedAt: null,
});
A.pending.columns.push({
  id: colId,
  repoId,
  title: "할 일",
  rank: "n",
  updatedAt: tick(),
  deletedAt: null,
});
A.pending.cards.push({
  id: card1,
  repoId,
  columnId: colId,
  title: "싱크 프로토콜",
  body: "",
  rank: "n",
  updatedAt: tick(),
  deletedAt: null,
});
A.pending.cards.push({
  id: card2,
  repoId,
  columnId: colId,
  title: "칸반 UI",
  body: "",
  rank: "t",
  updatedAt: tick(),
  deletedAt: null,
});

const r1 = await A.sync();
ok(r1.rejected.length === 0, `첫 push 거절 없음 (${JSON.stringify(r1.rejected)})`);
ok(A.cursor > 0, `커서 전진 (${A.cursor})`);
ok(A.store.cards.size === 2, `A 가 카드 2개 보유 (${A.store.cards.size})`);

// --- B 는 백지에서 시작 — 전부 받아와야 한다 ---
const B = makeClient(token, "B");
await B.sync();
ok(B.store.repos.size === 1, `B 레포 수신 (${B.store.repos.size})`);
ok(B.store.columns.size === 1, `B 컬럼 수신 (${B.store.columns.size})`);
ok(B.store.cards.size === 2, `B 카드 수신 (${B.store.cards.size})`);
ok(B.cursor === A.cursor, `커서 일치 A=${A.cursor} B=${B.cursor}`);

// --- B 가 카드를 수정 → A 가 받아야 한다 ---
const edited = { ...B.store.cards.get(card1), title: "싱크 프로토콜 (완료)", updatedAt: tick() };
B.pending.cards.push(edited);
await B.sync();
await A.sync();
ok(
  A.store.cards.get(card1).title === "싱크 프로토콜 (완료)",
  `A 가 B 의 수정을 수신 (${A.store.cards.get(card1).title})`,
);

// --- 충돌: A 가 오래된 updatedAt 으로 밀면 거절돼야 한다 ---
const stale = { ...A.store.cards.get(card1), title: "옛날 값", updatedAt: 1 };
A.pending.cards.push(stale);
const r2 = await A.sync();
ok(r2.rejected.length === 1, `오래된 쓰기 1건 거절 (${JSON.stringify(r2.rejected)})`);
ok(r2.rejected[0]?.reason === "stale", `거절 사유 stale (${r2.rejected[0]?.reason})`);
ok(A.store.cards.get(card1).title === "싱크 프로토콜 (완료)", "거절 후 서버 값이 유지됨");

// --- 없는 부모를 참조하는 카드는 거절 ---
A.pending.cards.push({
  id: cuid(),
  repoId,
  columnId: cuid(),
  title: "고아",
  body: "",
  rank: "n",
  updatedAt: tick(),
  deletedAt: null,
});
const r3 = await A.sync();
ok(r3.rejected[0]?.reason === "missing_parent", `부모 없는 카드 거절 (${r3.rejected[0]?.reason})`);

// --- 툼스톤: 삭제가 전파돼야 한다 ---
const deleted = { ...A.store.cards.get(card2), updatedAt: tick(), deletedAt: tick() };
A.pending.cards.push(deleted);
await A.sync();
await B.sync();
ok(B.store.cards.get(card2)?.deletedAt !== null, "삭제(툼스톤)가 B 로 전파됨");

// --- 다른 유저 격리 ---
const other = await api("/api/auth/register", {
  email: `other-${Date.now()}@example.com`,
  password: "hunter2hunter2",
});
const C = makeClient(other.json.token, "C");
await C.sync();
ok(C.store.repos.size === 0, `다른 유저는 아무것도 못 본다 (${C.store.repos.size})`);

// 남의 레코드를 덮어쓰려는 시도
C.pending.repos.push({
  id: repoId,
  name: "탈취",
  path: null,
  gitRemote: null,
  updatedAt: tick(),
  deletedAt: null,
});
const r4 = await C.sync();
ok(r4.rejected[0]?.reason === "forbidden", `남의 레코드 쓰기 거절 (${r4.rejected[0]?.reason})`);
await A.sync();
ok(A.store.repos.get(repoId).name === "kybird-nest", "탈취 시도 후에도 원본 유지");

console.log(process.exitCode ? "\n실패 있음" : "\n전부 통과");
