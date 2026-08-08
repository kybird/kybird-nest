import { syncRequestSchema, type SyncResponse } from "@kybird/shared";
import { authenticate, unauthorized } from "@/lib/auth";
import { applyChanges, pullChanges } from "@/lib/sync";

/**
 * push 와 pull 을 한 번의 왕복으로 처리한다.
 *
 * 오프라인에서 쌓인 큐를 비우면서 동시에 다른 머신의 변경분을 받아오는 게
 * 기본 동작이라, 둘을 나누면 왕복만 늘고 얻는 게 없다.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await authenticate(request);
  if (!user) return unauthorized();

  const parsed = syncRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "동기화 요청 형식이 잘못됐다", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { cursor, changes } = parsed.data;

  // 먼저 올리고 나서 내려받는다. 방금 올린 행도 pull 에 섞여 돌아오는데,
  // 클라이언트 입장에서 내용은 같고 seq 만 새로 알게 되므로 문제가 없다.
  const rejected = await applyChanges(user.id, changes);
  const pulled = await pullChanges(user.id, cursor);

  const response: SyncResponse = {
    cursor: pulled.cursor,
    changes: pulled.changes,
    hasMore: pulled.hasMore,
    rejected,
  };
  return Response.json(response);
}
