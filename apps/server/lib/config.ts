import { isAbsolute } from "node:path";

/**
 * 배포 설정을 한 군데로 모은다.
 *
 * 공개 인터넷에 노출되는 서버라, 어떤 환경변수가 보안에 영향을 주는지
 * 흩어져 있으면 안 된다. 여기만 보면 노출 면이 다 보여야 한다.
 */

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

const isProduction = process.env.NODE_ENV === "production";

/**
 * 가입 정책.
 *
 * - 초대 코드가 설정돼 있으면: 코드가 맞아야 가입된다.
 * - 코드가 없으면: **프로덕션은 닫히고, 개발은 열린다.**
 *
 * 프로덕션 기본값이 "열림"이면 설정을 깜빡한 순간 아무나 계정을 만든다.
 * 안전한 쪽이 기본이어야 한다. 반대로 로컬 개발까지 코드를 요구하면
 * 테스트가 번거로워지기만 하고 얻는 게 없다.
 */
const inviteCode = process.env["KNEST_INVITE_CODE"]?.trim() ?? "";
const inviteRequired = inviteCode.length > 0;

export const config = {
  isProduction,

  /**
   * 쿠키에 secure 를 붙일지.
   *
   * 리버스 프록시가 TLS 를 끊고 앱에는 평문 HTTP 로 넘기는 게 보통이라,
   * 앱은 자기가 HTTPS 뒤에 있는지 알 수 없다. 그래서 명시적으로 받는다.
   * 이걸 자동 추론하게 두면 "프로덕션인데 평문 HTTP" 조합에서 브라우저가
   * 쿠키를 버려 로그인이 조용히 안 되는 함정에 빠진다.
   */
  cookieSecure: bool("KNEST_COOKIE_SECURE", isProduction),

  /**
   * 리버스 프록시 뒤에 있는지.
   *
   * 켜면 레이트 리밋이 X-Forwarded-For 의 마지막 항목을 클라이언트 주소로
   * 쓴다. 프록시가 붙여준 값이라 신뢰할 수 있다. 프록시가 없는데 켜면
   * 공격자가 헤더를 위조해 레이트 리밋을 우회한다.
   */
  trustProxy: bool("KNEST_TRUST_PROXY", false),

  /** 가입 자체가 가능한지. */
  registrationOpen: inviteRequired || !isProduction,
  /** 초대 코드를 요구하는지. 코드가 없는 개발 환경에서는 요구하지 않는다. */
  inviteRequired,
  inviteCode,
};

/**
 * 시작할 때 한 번 점검한다. 조용히 잘못 도는 것보다 시끄럽게 죽는 게 낫다.
 *
 * 특히 DATABASE_URL 이 상대경로면 better-sqlite3 가 process.cwd() 기준으로
 * 푼다 — 컨테이너에서 작업 디렉토리가 달라지면 **에러가 아니라 빈 DB 를 새로
 * 만든다.** 데이터가 사라진 것처럼 보이는 최악의 실패 방식이다.
 */
export function checkDeploymentConfig(): string[] {
  const warnings: string[] = [];

  const url = process.env["DATABASE_URL"] ?? "";
  const filePath = url.startsWith("file:") ? url.slice("file:".length) : null;

  if (filePath !== null && !isAbsolute(filePath)) {
    const message =
      `DATABASE_URL 이 상대경로다 (${url}). better-sqlite3 는 이걸 실행 위치 기준으로 풀기 때문에, ` +
      `작업 디렉토리가 달라지면 빈 DB 가 새로 생긴다. 절대경로를 써라.`;
    if (isProduction) throw new Error(message);
    warnings.push(message);
  }

  if (isProduction && !config.inviteRequired) {
    warnings.push("KNEST_INVITE_CODE 가 없어 가입이 닫혀 있다. 첫 계정을 만들려면 설정해라.");
  }

  if (isProduction && !config.cookieSecure) {
    warnings.push(
      "KNEST_COOKIE_SECURE 가 꺼져 있다. HTTPS 뒤에 있다면 켜라 — 세션 쿠키가 평문으로 오간다.",
    );
  }

  if (isProduction && config.inviteCode.length > 0 && config.inviteCode.length < 12) {
    warnings.push("초대 코드가 짧다. 공개 노출 서버이므로 추측하기 어려운 값을 써라.");
  }

  return warnings;
}
