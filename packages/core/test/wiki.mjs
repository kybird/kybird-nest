/**
 * wiki 테스트 — 주입, 검색, 임베딩, 컴파일.
 *
 * 서버가 필요 없다. 대신 **임베딩 모델을 처음 받을 때만 네트워크가 필요하다**
 * (약 100MB, 이후 캐시). 그 다음부터는 오프라인에서도 돈다.
 *
 *   npm run test:wiki -w @kybird/core
 */
import {
  Store, inject, search, compileIndex, recordUsage,
  keywordRetriever, vectorRetriever, hybridRetriever,
  localEmbedder, ensureEmbeddings, encodeVector, decodeVector, dot,
} from "../dist/index.js";

const s = new Store(":memory:");
const R = "repo1";

const docs = [
  ["싱크 프로토콜", "push 와 pull 을 한 번의 왕복으로 처리한다. 오프라인 큐를 비우면서 동시에 다른 머신 변경분을 받아온다.", "concept", ["sync"]],
  ["분수 랭크", "카드 차례를 정수로 매기면 두 대에서 동시에 옮겼을 때 반드시 부딪힌다. 문자열로 사이값을 계속 만들어낼 수 있게 한다.", "gotcha", ["kanban"]],
  ["툼스톤 삭제", "레코드를 진짜로 지우면 다른 기기가 그 사실을 알 방법이 없다. 지웠다는 표시만 남긴다.", "pattern", ["sync"]],
  ["scrypt 비밀번호", "비밀번호는 느린 KDF 로 해싱한다. 토큰은 이미 고엔트로피라 SHA-256 이면 충분하다.", "decision", ["auth"]],
  ["임베딩 모델 고정", "벡터마다 어떤 모델로 만들었는지 남긴다. 나중에 모델을 갈아도 옛 벡터를 알아볼 수 있어야 한다.", "decision", ["wiki"]],
];
for (const [title, body, kind, tags] of docs) inject(s, { repoId: R, title, body, kind, tags });

let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗ " + m); fails++; } else console.log("✓ " + m); };

// --- 직렬화 왕복 ---
const v = Float32Array.from([0.1, -0.5, 0.25, 1]);
const back = decodeVector(encodeVector(v));
ok([...back].every((x, i) => Math.abs(x - v[i]) < 1e-6), "벡터 base64 왕복이 값을 보존한다");
ok(Math.abs(dot(v, v) - (0.01 + 0.25 + 0.0625 + 1)) < 1e-5, "내적 계산이 맞다");

// --- 키워드 검색 ---
const kw = await search(s, "랭크", { repoId: R });
ok(kw.hits[0]?.entry.title === "분수 랭크", `키워드: "랭크" → ${kw.hits[0]?.entry.title}`);
ok(kw.strategy === "keyword" && kw.model === null, "전략/모델이 로그에 기록됨");

// 어휘가 전혀 겹치지 않는 질의 — 키워드는 여기서 진다
const KEYLESS = "여러 컴퓨터에서 같은 항목의 자리를 바꿨을 때 부딪히지 않게 하려면";
const kwMiss = await search(s, KEYLESS, { repoId: R });
console.log(`  키워드 상위: ${kwMiss.hits.slice(0,3).map(h=>h.entry.title).join(", ") || "(없음)"}`);

// --- 로그가 반드시 남는가 ---
const logs = s.listSearchLogs();
ok(logs.length === 2, `검색 2건이 모두 로그로 남음 (${logs.length})`);
ok(logs[0].resultIds.length > 0 || logs[0].query === KEYLESS, "로그에 결과 id 가 담긴다");
recordUsage(s, kw.logId, [kw.hits[0].entry.id]);
ok(s.getSearchLog(kw.logId).usedIds.length === 1, "실제 사용 표시가 기록된다");

// --- 임베딩 ---
console.log("\n  임베딩 생성 중…");
const embedder = localEmbedder();
const n = await ensureEmbeddings(s, embedder);
ok(n === 5, `엔트리 5건 임베딩 (${n})`);
ok(await ensureEmbeddings(s, embedder) === 0, "이미 만든 건 다시 만들지 않는다");

const vecRet = vectorRetriever(embedder);
const vec = await search(s, KEYLESS, { repoId: R, retriever: vecRet });
ok(vec.hits[0]?.entry.title === "분수 랭크",
   `벡터: 어휘가 안 겹쳐도 찾아낸다 → ${vec.hits[0]?.entry.title} (${vec.hits[0]?.score.toFixed(3)})`);
ok(vec.model === embedder.model, `로그에 모델이 기록됨 (${vec.model})`);

const vec2 = await search(s, "암호를 어떻게 보관하나", { repoId: R, retriever: vecRet });
ok(vec2.hits[0]?.entry.title === "scrypt 비밀번호", `벡터: "암호 보관" → ${vec2.hits[0]?.entry.title}`);

// --- 하이브리드 ---
const hyb = hybridRetriever([keywordRetriever, vecRet]);
const h = await search(s, "삭제를 다른 기기에 어떻게 알리나", { repoId: R, retriever: hyb });
ok(h.hits[0]?.entry.title === "툼스톤 삭제", `하이브리드 → ${h.hits[0]?.entry.title}`);
ok(h.strategy === "hybrid-rrf", "하이브리드 전략명이 로그에 남는다");

// 하이브리드는 키워드 결과도 놓치지 않아야 한다
const h2 = await search(s, "scrypt", { repoId: R, retriever: hyb });
ok(h2.hits[0]?.entry.title === "scrypt 비밀번호", `하이브리드가 정확 일치도 유지 → ${h2.hits[0]?.entry.title}`);

// --- 본문 수정 시 재임베딩 ---
const target = s.listWikiEntries(R).find(e => e.title === "툼스톤 삭제");
s.putWikiEntry({ ...target, body: "완전히 다른 내용으로 교체됨", updatedAt: Date.now() + 1000 });
ok(await ensureEmbeddings(s, embedder) === 1, "본문이 바뀌면 그 엔트리만 다시 임베딩한다");
ok(s.listEmbeddings(embedder.model).length === 5, `벡터가 중복 생성되지 않는다 (${s.listEmbeddings(embedder.model).length})`);

// --- index.md 컴파일 ---
const md = compileIndex(s, { repoId: R, title: "테스트 색인" });
const fm = md.split("\n");
ok(fm[0] === "---" && fm.indexOf("---", 1) > 0, "frontmatter 가 제대로 닫힌다");
ok(md.includes("## 개념") && md.includes("## 함정") && md.includes("## 결정"), "종류별로 묶인다");
ok(md.includes("커밋하지 마라"), "생성물이라는 경고가 들어간다");
ok(!md.includes("Last updated"), "컴파일마다 바뀌는 타임스탬프를 넣지 않는다");
const md2 = compileIndex(s, { repoId: R, title: "테스트 색인" });
ok(md === md2, "같은 입력이면 같은 출력 (커밋해도 diff 가 안 생기는 성질)");

s.close();
console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
