import { config } from "./config";

/**
 * 인증 엔드포인트 레이트 리밋.
 *
 * 인스턴스가 하나라 메모리에 둔다. 여러 대로 늘어나면 공유 저장소가
 * 필요하지만, 그때는 이 파일만 갈아끼우면 된다.
 *
 * 반드시 **비밀번호 검증보다 먼저** 불러야 한다. scrypt 는 시도당 33MB 를
 * 쓰므로, 검증을 하고 나서 세는 건 아무 방어도 되지 않는다.
 */

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();

/** 메모리가 무한정 늘지 않게 가끔 청소한다. */
const MAX_BUCKETS = 10_000;

function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= limit) return false;
  existing.count++;
  return true;
}

function sweep(now: number): void {
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
  // 전부 살아있으면 어쩔 수 없이 통째로 버린다. 공격 중이라는 뜻이고,
  // 리셋되면 정상 사용자는 다시 쓸 수 있다.
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

/**
 * 요청자 식별.
 *
 * 프록시 뒤라면 X-Forwarded-For 의 **마지막** 항목을 쓴다. 프록시가 직접
 * 붙인 값이라 위조할 수 없기 때문이다. 앞쪽 항목은 클라이언트가 보낸
 * 것이라 얼마든지 지어낼 수 있다.
 */
function clientKey(request: Request): string {
  if (!config.trustProxy) return "direct";
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "direct";
  const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? "direct";
}

export type LimitName = "login" | "register";

const LIMITS: Record<LimitName, { limit: number; windowMs: number }> = {
  // 사람이 로그인하는 빈도는 낮다. 넉넉해 보여도 무차별 대입에는 한참 모자란다.
  login: { limit: 10, windowMs: 15 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
};

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkRateLimit(request: Request, name: LimitName): LimitResult {
  const { limit, windowMs } = LIMITS[name];
  const key = `${name}:${clientKey(request)}`;

  if (hit(key, limit, windowMs)) return { ok: true };

  const window = buckets.get(key);
  const retryAfterSeconds = window
    ? Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000))
    : Math.ceil(windowMs / 1000);
  return { ok: false, retryAfterSeconds };
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "시도가 너무 잦다. 잠시 후 다시 해라." },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );
}

/** 테스트에서 상태를 비운다. */
export function resetRateLimits(): void {
  buckets.clear();
}
