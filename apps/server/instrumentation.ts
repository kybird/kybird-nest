/**
 * 서버가 뜰 때 한 번 도는 자리.
 *
 * 배포 설정이 잘못됐으면 **여기서 시끄럽게 죽는다.** 조용히 잘못 도는 쪽이
 * 훨씬 나쁘다 — 특히 DB 경로가 틀리면 에러 대신 빈 DB 가 생겨서 데이터가
 * 사라진 것처럼 보인다.
 */
export async function register(): Promise<void> {
  // Edge 런타임에서는 노드 모듈을 못 쓴다. 노드 런타임에서만 점검한다.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const { checkDeploymentConfig } = await import("./lib/config");
  for (const warning of checkDeploymentConfig()) {
    console.warn(`[kybird-nest] ${warning}`);
  }
}
