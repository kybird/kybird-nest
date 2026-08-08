/**
 * 분수 랭크 (lexo-rank 류).
 *
 * 칸반 카드 순서를 정수로 매기면 오프라인에서 두 머신이 카드를 옮겼을 때
 * 반드시 충돌한다. 두 랭크 "사이"에 항상 새 랭크를 끼워넣을 수 있는
 * 문자열 랭크를 쓰면 이웃만 알면 되므로 재배열이 전파되지 않는다.
 *
 * 알파벳은 'a'..'z' (base 26). 문자열 사전순 비교가 곧 순서다.
 */

const BASE = 26;
const FIRST_CHAR = "a".charCodeAt(0);

function toDigits(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0) - FIRST_CHAR);
}

function fromDigits(digits: number[]): string {
  return digits.map((d) => String.fromCharCode(FIRST_CHAR + d)).join("");
}

/** 랭크 문자열로 쓸 수 있는 값인지 — 'a'..'z' 로만 이뤄진 비어있지 않은 문자열. */
export function isValidRank(value: string): boolean {
  return /^[a-z]+$/.test(value);
}

/**
 * `prev` 와 `next` 사이에 오는 랭크를 만든다.
 * 양끝은 `null` 로 열어둔다 — `rankBetween(null, first)` 는 맨 앞,
 * `rankBetween(last, null)` 은 맨 뒤.
 *
 * 반환값은 항상 `prev < 결과 < next` 를 만족하며 'a' 로 끝나지 않는다.
 */
export function rankBetween(prev: string | null, next: string | null): string {
  if (prev !== null && !isValidRank(prev)) {
    throw new Error(`잘못된 랭크: ${JSON.stringify(prev)}`);
  }
  if (next !== null && !isValidRank(next)) {
    throw new Error(`잘못된 랭크: ${JSON.stringify(next)}`);
  }
  if (prev !== null && next !== null && prev >= next) {
    throw new Error(`랭크 순서가 뒤집혔다: ${prev} >= ${next}`);
  }

  const lo = prev === null ? [] : toDigits(prev);
  const hi = next === null ? null : toDigits(next);
  const out: number[] = [];

  for (let i = 0; ; i++) {
    // 자리가 끝난 쪽은 각각 하한/상한으로 취급한다.
    // prev 가 끝났으면 0(그 뒤에 뭘 붙여도 크다), next 가 끝났으면 BASE.
    const p = lo[i] ?? 0;
    const n = hi === null ? BASE : (hi[i] ?? BASE);

    if (p + 1 < n) {
      // 두 자리 사이에 여유가 있다 — 중간값을 넣고 끝낸다.
      out.push(Math.floor((p + n) / 2));
      return fromDigits(out);
    }

    // 여유가 없으니 prev 를 따라가며 한 자리 더 내려간다.
    out.push(p);
  }
}

/** 목록 맨 앞에 놓을 랭크. */
export function rankFirst(current: string | null = null): string {
  return rankBetween(null, current);
}

/** 목록 맨 뒤에 놓을 랭크. */
export function rankLast(current: string | null = null): string {
  return rankBetween(current, null);
}

/** 비어있는 목록에 n개를 고르게 배치할 랭크들. */
export function rankSequence(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}

/** 랭크 기준 오름차순 비교자. 동률이면 id 로 타이브레이크한다. */
export function byRank<T extends { rank: string; id: string }>(a: T, b: T): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
