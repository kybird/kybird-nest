import { test } from "node:test";
import assert from "node:assert/strict";
import type { Card } from "./entities.js";
import { REGRESS_STALL_THRESHOLD, regressionReport } from "./regression.js";

// exactOptionalPropertyTypes 때문에 Partial 을 그냥 펼치면 undefined 가 섞인다.
// Object.assign 은 실제로 있는 키만 덮어쓰므로 그 문제가 없다.
function card(patch: Partial<Card> & { id: string }): Card {
  const base: Card = {
    id: patch.id,
    repoId: "r1",
    columnId: "c1",
    title: patch.id,
    body: "",
    rank: "m",
    completedAt: null,
    regressCount: 0,
    rejectedBy: null,
    rejectedReason: null,
    rejectedAt: null,
    updatedAt: 0,
    deletedAt: null,
  };
  return Object.assign(base, patch);
}

test("회귀가 없으면 전부 비어있다", () => {
  const report = regressionReport([card({ id: "a" }), card({ id: "b" })]);
  assert.deepEqual(report.regressed, []);
  assert.deepEqual(report.stalled, []);
  assert.equal(report.totalRegressions, 0);
});

test("회귀한 카드만 골라서 횟수 내림차순으로 준다", () => {
  const report = regressionReport([
    card({ id: "a", regressCount: 1 }),
    card({ id: "b", regressCount: 0 }),
    card({ id: "c", regressCount: 2 }),
  ]);
  assert.deepEqual(
    report.regressed.map((c) => c.id),
    ["c", "a"],
  );
  assert.equal(report.totalRegressions, 3);
});

test("임계치 이상만 stalled 로 잡힌다", () => {
  const below = REGRESS_STALL_THRESHOLD - 1;
  const report = regressionReport([
    card({ id: "below", regressCount: below }),
    card({ id: "at", regressCount: REGRESS_STALL_THRESHOLD }),
    card({ id: "above", regressCount: REGRESS_STALL_THRESHOLD + 1 }),
  ]);
  assert.deepEqual(
    report.stalled.map((c) => c.id),
    ["above", "at"],
  );
});

test("삭제된 카드는 안 센다 — 지운 카드의 회귀는 개입 대상이 아니다", () => {
  const report = regressionReport([
    card({ id: "live", regressCount: 5 }),
    card({ id: "dead", regressCount: 9, deletedAt: 123 }),
  ]);
  assert.deepEqual(
    report.regressed.map((c) => c.id),
    ["live"],
  );
  assert.equal(report.totalRegressions, 5);
});
