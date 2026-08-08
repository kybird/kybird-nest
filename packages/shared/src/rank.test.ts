import { test } from "node:test";
import assert from "node:assert/strict";
import { byRank, isValidRank, rankBetween, rankFirst, rankLast, rankSequence } from "./rank.js";

test("빈 목록에 처음 놓으면 유효한 랭크가 나온다", () => {
  const r = rankBetween(null, null);
  assert.ok(isValidRank(r), r);
});

test("두 랭크 사이에 끼워넣으면 엄격히 사이에 온다", () => {
  const a = rankBetween(null, null);
  const b = rankBetween(a, null);
  const mid = rankBetween(a, b);
  assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`);
});

test("맨 앞/맨 뒤 삽입", () => {
  const a = rankBetween(null, null);
  assert.ok(rankFirst(a) < a);
  assert.ok(rankLast(a) > a);
});

test("결과는 절대 'a'로 끝나지 않는다 — 끝자리가 0이면 그 뒤에 못 끼운다", () => {
  let lo = rankBetween(null, null);
  const hi = rankBetween(lo, null);
  for (let i = 0; i < 200; i++) {
    lo = rankBetween(lo, hi);
    assert.ok(!lo.endsWith("a"), `${i}번째: ${lo}`);
  }
});

test("같은 자리를 200번 반복 분할해도 순서가 유지된다", () => {
  // 한 카드를 계속 같은 두 카드 사이로 옮기는 상황.
  // 랭크 문자열이 길어지긴 해도 불변식은 깨지면 안 된다.
  const left = rankBetween(null, null);
  let right = rankBetween(left, null);
  for (let i = 0; i < 200; i++) {
    const next = rankBetween(left, right);
    assert.ok(left < next, `${i}번째: ${left} < ${next} 위반`);
    assert.ok(next < right, `${i}번째: ${next} < ${right} 위반`);
    right = next;
  }
});

test("rankSequence는 오름차순이다", () => {
  const seq = rankSequence(50);
  assert.equal(seq.length, 50);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i - 1]! < seq[i]!, `${seq[i - 1]} < ${seq[i]} 위반`);
  }
});

test("무작위 삽입을 반복해도 정렬 결과가 기대 순서와 같다", () => {
  // 랭크만 보고 정렬한 결과가, 우리가 의도한 논리적 순서와 일치하는지.
  const items = rankSequence(5).map((rank, i) => ({ id: `id${i}`, rank, label: `초기${i}` }));
  for (let i = 0; i < 300; i++) {
    const at = Math.floor(Math.random() * (items.length + 1));
    const prev = at > 0 ? items[at - 1]!.rank : null;
    const next = at < items.length ? items[at]!.rank : null;
    const item = { id: `new${i}`, rank: rankBetween(prev, next), label: `삽입${i}` };
    items.splice(at, 0, item);
  }
  const sorted = [...items].sort(byRank);
  assert.deepEqual(
    sorted.map((i) => i.id),
    items.map((i) => i.id),
  );
});

test("뒤집힌 입력은 거부한다", () => {
  const a = rankBetween(null, null);
  const b = rankBetween(a, null);
  assert.throws(() => rankBetween(b, a), /뒤집/);
});

test("잘못된 문자는 거부한다", () => {
  assert.throws(() => rankBetween("A1", null), /잘못된 랭크/);
  assert.throws(() => rankBetween(null, ""), /잘못된 랭크/);
});
