import type { Card } from "./entities.js";

/**
 * 회귀 계기판.
 *
 * `brief.md` 0장은 `regressCount` 를 "루프가 헛도는지 재는 계기판"으로 규정한다 —
 * 같은 카드가 완료에서 반복해 튕겨나오면 그 루프는 수렴하지 않는 것이고, 사람이
 * 개입해야 한다는 신호다. 그런데 지금까지는 카드마다 `↺N` 을 **찍기만 하고 읽는
 * 쪽이 없었다.** 기록만 하고 아무도 안 보면 신호가 아무한테도 안 간다.
 *
 * 이 모듈이 shared 에 있는 이유는 CLI 와 웹 대시보드가 **같은 임계치로 같은
 * 판단**을 해야 하기 때문이다. 표면마다 따로 세면 두 화면이 서로 다른 말을 한다.
 * core 에 두면 웹이 못 쓴다(core 는 `better-sqlite3` 를 끌고 온다). 계산에
 * 필요한 건 `Card` 뿐이라 저장소를 모르는 이 자리가 맞다.
 */

/**
 * 이 횟수 이상 회귀하면 "수렴 안 하는 카드"로 본다.
 *
 * 왜 3인가 — 1회는 흔한 재작업이고 2회도 그럴 수 있다. 3회부터는 같은 카드가
 * 반복해 튕겨나온다는 뜻이라, 카드 자체가 잘못 정의됐거나(범위가 너무 넓거나
 * 완료 조건이 모호하거나) 루프가 못 푸는 문제일 확률이 높다. 정밀한 수치가
 * 아니라 **사람 눈에 띄게 하는 문턱**이므로 실사용 데이터가 쌓이면 조정한다.
 */
export const REGRESS_STALL_THRESHOLD = 3;

export type RegressionReport = {
  /** 한 번이라도 회귀한 카드. 회귀 횟수 내림차순. */
  regressed: Card[];
  /** 그중 임계치 이상 — 사람이 봐야 하는 것들. */
  stalled: Card[];
  /** 되돌아간 횟수의 총합. 카드 수가 아니다. */
  totalRegressions: number;
};

/**
 * 카드 목록의 회귀 상태를 요약한다.
 *
 * 삭제된 카드(툼스톤)는 세지 않는다 — 지운 카드의 회귀는 지금 개입할 대상이
 * 아니라서 계기판에 남으면 잡음이 된다.
 */
export function regressionReport(cards: Card[]): RegressionReport {
  const regressed = cards
    .filter((card) => card.deletedAt === null && card.regressCount > 0)
    .sort((a, b) => b.regressCount - a.regressCount);

  return {
    regressed,
    stalled: regressed.filter((card) => card.regressCount >= REGRESS_STALL_THRESHOLD),
    totalRegressions: regressed.reduce((sum, card) => sum + card.regressCount, 0),
  };
}
