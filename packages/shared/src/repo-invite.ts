import { z } from "zod";
import { repoSchema } from "./entities.js";

/**
 * 레포별 참여 코드. 계정 가입 초대 코드(전역, env var 하나)와 달리
 * 레포마다 값이 달라야 해서 별도 흐름이다.
 *
 * clone 만으로 자동 합류는 안 된다 — `.kybird/repo.json` 이 git 에
 * 커밋되므로, 공개 레포라면 repoId 자체는 이미 공개된 값이다. 그걸
 * 그대로 참여 코드로 쓰면 아무나 조용히 합류할 수 있는 구멍이 된다.
 */

export const repoInviteRequestSchema = z.object({
  repoId: z.string().min(1).max(64),
});
export type RepoInviteRequest = z.infer<typeof repoInviteRequestSchema>;

/** 평문 코드는 발급 순간 한 번만 돌려준다. 서버는 해시만 저장한다. */
export const repoInviteResultSchema = z.object({
  code: z.string(),
});
export type RepoInviteResult = z.infer<typeof repoInviteResultSchema>;

export const repoJoinRequestSchema = z.object({
  repoId: z.string().min(1).max(64),
  code: z.string().min(1).max(200),
});
export type RepoJoinRequest = z.infer<typeof repoJoinRequestSchema>;

export const repoJoinResultSchema = z.object({
  repo: repoSchema,
});
export type RepoJoinResult = z.infer<typeof repoJoinResultSchema>;
