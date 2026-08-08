import {
  authResultSchema,
  bearer,
  syncResponseSchema,
  type AuthResult,
  type SyncRequest,
  type SyncResponse,
} from "@kybird/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function post(baseUrl: string, path: string, body: unknown, token?: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: bearer(token) } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // 서버가 죽어있는 건 정상 상황이다 — 오프라인 우선이라 호출부가 이걸 보고
    // 큐에 쌓아두기로 결정한다.
    throw new OfflineError(`서버에 닿을 수 없다: ${baseUrl}`, { cause });
  }

  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(`서버가 JSON 이 아닌 응답을 보냈다 (${res.status})`, res.status);
    }
  }

  if (!res.ok) {
    const message =
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `요청 실패 (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return json;
}

export class OfflineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OfflineError";
  }
}

export async function register(
  baseUrl: string,
  email: string,
  password: string,
): Promise<AuthResult> {
  return authResultSchema.parse(await post(baseUrl, "/api/auth/register", { email, password }));
}

export async function login(baseUrl: string, email: string, password: string): Promise<AuthResult> {
  return authResultSchema.parse(await post(baseUrl, "/api/auth/login", { email, password }));
}

export async function syncOnce(
  baseUrl: string,
  token: string,
  request: SyncRequest,
): Promise<SyncResponse> {
  return syncResponseSchema.parse(await post(baseUrl, "/api/sync", request, token));
}
