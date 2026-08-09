import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * 초대 코드 대조.
 *
 * 단순 `===` 를 쓰지 않는 이유는 문자열 비교가 첫 불일치에서 멈추기 때문이다.
 * 응답 시간 차이로 코드를 한 글자씩 알아낼 수 있다. 길이가 달라도 새지 않게
 * 먼저 해시해서 같은 길이로 만든 뒤 상수 시간 비교를 한다.
 */
export function inviteMatches(supplied: string | undefined | null): boolean {
  if (!config.registrationOpen) return false;
  // 개발 환경에 코드가 설정돼 있지 않으면 요구하지 않는다.
  if (!config.inviteRequired) return true;

  const given = (supplied ?? "").trim();
  if (given.length === 0) return false;

  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(config.inviteCode).digest();
  return timingSafeEqual(a, b);
}
