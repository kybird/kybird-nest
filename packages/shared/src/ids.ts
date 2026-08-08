import { createId, isCuid } from "@paralleldrive/cuid2";

/**
 * 레코드 id 는 클라이언트가 만든다. 오프라인에서 서버 왕복 없이 레코드를
 * 생성할 수 있어야 하기 때문이다.
 *
 * seed 문서에 기록된 "Case N 중복" 사고가 바로 이걸 안 해서 생긴 일이다 —
 * 여러 로컬이 각자 다음 순번을 계산해서 같은 번호를 두 번 썼다.
 * 순번을 아예 안 쓰면 그 충돌은 존재할 수 없다.
 */
export function newId(): string {
  return createId();
}

export function isValidId(value: string): boolean {
  return isCuid(value);
}

/** 지금 시각 (epoch ms). LWW 비교 기준이라 한 군데로 모아둔다. */
export function now(): number {
  return Date.now();
}
