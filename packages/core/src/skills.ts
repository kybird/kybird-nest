import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `knest link`(또는 `repo join`) 시점에 스킬 파일과 지시어 파일을 자동 생성한다.
 *
 * 두 종류를 심는다:
 *
 * 1. 스킬 파일 (on-demand 본문 — 에이전트가 description 을 보고 호출할 때만 읽힘):
 *    `.claude/skills/knest/SKILL.md` — Claude Code (고유 경로)
 *    `.agents/skills/knest/SKILL.md` — Codex CLI·Antigravity (고유), OpenCode·ZCode (호환)
 *
 * 2. 지시어 파일 (항상 시스템 프롬프트에 주입 — "Tier 0"):
 *    `AGENTS.md` — Codex·ZCode·OpenCode 가 매 세션마다 전체를 읽는다. SSOT.
 *    `CLAUDE.md` — Claude Code 는 AGENTS.md 를 안 읽으므로 `@AGENTS.md` 인클루드로 우회.
 *    `GEMINI.md` — Antigravity 도 같은 이유로 `@AGENTS.md` 인클루드.
 *
 * 왜 지시어 파일이 따로 필요한가: 스킬은 name+description 카탈로그만 항상 주입되고
 * 본문은 on-demand 다. 그래서 "칸반을 써라" 같은 강제 지시를 스킬 본문에만 두면
 * 에이전트가 스킬을 호출하기 전엔 그 지시를 못 본다. AGENTS.md 는 전체가 항상
 * 주입되므로(Tier 0), 강제 지시는 여기에 둬야 확실하다.
 *
 * 이건 brief.md 4단계(스킬 상속: 부모 고정, 파생본 개인 것)가 아니다 —
 * 그건 서버가 스킬을 보유하고 LLM이 매개해서 리베이스하는 훨씬 큰 작업이고
 * 아직 안 만들었다. 여기서 하는 건 그보다 훨씬 작다: **MCP를 안 쓰기로
 * 하면서 사라진 "에이전트가 이 도구의 존재를 어떻게 아는가"의 빈자리를
 * 메우는 것.** MCP는 툴 목록에 자동으로 뜨지만 CLI는 AGENTS.md를 읽어야만
 * 안다 — 그 문서를 매번 손으로 안 써도 되게, link 시점에 자동으로 심는다.
 */

const MARKER = "<!-- kybird-nest:generated -->";

/** 스킬을 심을 상대경로들 (repoPath 기준). */
const SKILL_DIRS = [".claude/skills/knest", ".agents/skills/knest"];

/** 지시어를 심을 파일들 (repoPath 기준 파일명, 내용 팩토리). */
type InstructionKind = "agents" | "claude" | "gemini";
const INSTRUCTION_FILES: { name: string; kind: InstructionKind; body: () => string }[] = [
  { name: "AGENTS.md", kind: "agents", body: agentsContent },
  { name: "CLAUDE.md", kind: "claude", body: () => INCLUDE_AGENTS },
  { name: "GEMINI.md", kind: "gemini", body: () => INCLUDE_AGENTS },
];

const INCLUDE_AGENTS = `${MARKER}\n@AGENTS.md\n`;

function skillContent(): string {
  return `---
name: knest
description: kybird-nest 지식·칸반 백엔드 사용. 작업 시작 전 검색, 끝나면 기록.
---

${MARKER}
<!-- knest link 가 자동 생성한 파일이다. 직접 고쳐도 되지만, 그러면 이
     마커가 없어져서 다음 link 때 덮어쓰지 않는다(사용자 수정 존중). -->

# knest — 이 프로젝트에 연결된 지식·칸반 백엔드

이 레포는 kybird-nest 에 연결돼있다. 서버가 프로젝트 지식(wiki)과 칸반
보드를 저장하고, 여러 사람·기기가 공유한다.

## 작업 시작 전 — 먼저 검색해라

\`\`\`
knest wiki search "<찾고 싶은 것>"
\`\`\`

이미 누가(과거의 나 자신 포함) 알아낸 게 있는지 먼저 확인하면 같은 문제를
다시 풀지 않는다. 결과에 로그 id 가 같이 나오는데, 실제로 참고한 항목이
있으면 \`knest wiki used <로그id> <엔트리id>...\`로 표시해라 — 검색 품질
평가에 쓰인다.

## 작업 끝나면 — 알게 된 걸 남겨라

정리된 지식(결론 + 근거를 같이):
\`\`\`
knest wiki add "제목" --body "본문" [--kind concept|pattern|gotcha|decision|reference]
\`\`\`

다듬을 시간이 없는 원본 메모(나중에 다시 떠올라 압축될 수 있다):
\`\`\`
knest wiki raw "메모"
\`\`\`

다른 엔트리를 참조할 땐 본문에 \`[[제목]]\` 으로 쓰면 \`wiki index\` 가
폴더로 내보낸 뒤 옵시디언에서 링크가 연결된다.

옵시디언 vault 로 보려면:
\`\`\`
knest wiki index --out doc/wiki/    엔트리별 .md + index.md 를 폴더에 (생성물, 커밋 금지)
\`\`\`

## 커밋할 때마다

git hook 이 설치돼있으면, 커밋 직후에 "기록할 게 있으면 지금 남겨라"는
안내가 뜬다. 그 순간이 맥락이 살아있어서 기록하기 가장 좋을 때다 — 무시하지
말고 실제로 확인해라.

## 칸반 — 작업을 추적해라

작업은 칸반으로 관리한다. 카드를 너무 잘게 쪼개지 말고, 배경·범위·왜 필요한지를
본문에 담은 의미 단위로 만들어라.

\`\`\`
knest board                                     현재 보드 보기
knest add "<제목>" [--column 컬럼] [--body 본문]  카드 추가 (본문에 맥락을 담아라)
knest mv <카드> <컬럼>                           카드 옮기기
knest edit <카드> [새 제목] [--body 본문]         카드 편집 (제목·본문 둘 다)
\`\`\`

**작업을 시작할 때 카드를 진행 중으로 옮겨라.** 끝나면 완료로 옮긴다. "할 일"에
만 있는 카드는 아무도 안 한다는 뜻이고, "진행 중"은 지금 하고 있다는 뜻이다 —

\`\`\`
knest mv <카드> "진행 중"        작업 시작
knest mv <카드> "완료"           작업 완료
\`\`\`

카드가 완료에서 다시 진행 중로 돌아가면(회귀) \`↺N\` 표시가 붙는다. 반복적으로
회귀하는 카드는 뭔가 설계가 잘못됐다는 신호다.

지운 카드는 보관함에 남는다 — 실수로 지워도 되살릴 수 있다:
\`\`\`
knest trash                        보관함 (삭제된 카드 목록)
knest restore <카드>               보관함에서 되살리기
\`\`\`

## 밀린 것 처리

평소엔 커밋 직후 안내에서 몇 개씩 조금씩 처리하면 되지만, **이 레포에
knest를 막 붙였거나 밀린 게 많이 쌓여있으면** 하나씩 반복하지 말고 한
세션에 몰아서 처리해라:

\`\`\`
knest backfill --all                 밀린 커밋 전부를 한 번에 텍스트로 받는다
\`\`\`

받은 재료를 훑어보고, 남길 가치 있는 것만 \`knest wiki add\`/\`raw\`로
기록한 뒤, 다 본 것들은 \`knest backfill done <큐id>...\`로 한 번에 표시해라
(명령 자체에 큐 id 목록이 같이 나온다).

자세한 전체 명령은 \`knest help\`, \`knest wiki help\`.
`;
}

/**
 * AGENTS.md 본문. 항상 시스템 프롬프트에 주입되므로(Tier 0) 짧고 강령적이어야
 * 한다 — 스킬 본문(skillContent)처럼 긴 절차를 다루지 않는다. 핵심 강제
 * 지시(칸반 사용)와 도구 존재 알림만.
 */
function agentsContent(): string {
  return `${MARKER}
<!-- knest link 가 자동 생성한 파일이다. 직접 고쳐도 되지만, 그러면 이
     마커가 없어져서 다음 link 때 덮어쓰지 않는다(사용자 수정 존중). -->

# knest — 이 프로젝트의 지식·칸반 백엔드

이 레포는 kybird-nest(knest)에 연결돼있다. 서버가 지식(wiki)과 칸반
보드를 저장하고, 여러 사람·기기가 공유한다.

## 칸반으로 작업을 관리해라

작업은 칸반으로 관리한다. 카드를 너무 잘게 쪼개지 말고, 배경·범위·왜 필요한지를
본문에 담은 의미 단위로 만들어라.

\`\`\`
knest board                            현재 보드
knest add "<제목>" [--body 본문]         카드 추가 (본문에 맥락을 담아라)
knest mv <카드> <컬럼>                  카드 옮기기
knest edit <카드> [--body 본문]          카드 편집
\`\`\`

**작업을 시작할 때 카드를 진행 중으로 옮겨라.** 끝나면 완료로 옮긴다.
"할 일"에만 있는 카드는 아무도 안 한 것이다 — 시작하면 즉시 진행 중으로.

\`\`\`
knest mv <카드> "진행 중"        작업 시작
knest mv <카드> "완료"           작업 완료
\`\`\`

완료에서 진행 중로 돌아간 카드는 \`↺N\` 표시가 붙는다(회귀). 실수로 지운 카드는
\`knest trash\` 로 보관함에서, \`knest restore <카드>\` 로 되살린다.

## 작업 시작 전 — 먼저 검색해라

\`\`\`
knest wiki search "<찾고 싶은 것>"
\`\`\`

과거에(과거의 나 포함) 알아낸 게 있는지 먼저 본다. 실제로 참고한 항목은
\`knest wiki used <로그id> <엔트리id>\` 로 표시한다.

## 작업 끝나면 — 알게 된 걸 남겨라

\`\`\`
knest wiki add "제목" --body "본문" [--kind concept|pattern|gotcha|decision|reference]
\`\`\`

정리된 지식. 다듬을 시간이 없으면 \`knest wiki raw "메모"\`.
다른 엔트리를 참조할 땐 본문에 \`[[제목]]\` — wiki index 가 폴더로
내보낸 뒤 옵시디언에서 링크가 연결된다.

자세한 명령은 \`knest help\`. (knest 스킬이 활성화돼 있으면 더 자세한
절차가 스킬 본문에 있다.)
`;
}

export type SkillTargetKind = "skill" | InstructionKind;

export type SkillTarget =
  | { path: string; kind: SkillTargetKind; status: "written" }
  | { path: string; kind: SkillTargetKind; status: "skipped"; reason: "foreign" };

export type SkillSetupResult = SkillTarget[];

/**
 * 스킬 파일(2경로)과 지시어 파일(AGENTS/CLAUDE/GEMINI)을 쓴다.
 *
 * 이미 있는데 우리 마커가 없으면(사용자가 직접 만들었거나 고친 것)
 * 건드리지 않는다 — git hook 설치가 남의 훅을 안 덮어쓰는 것과 같은 이유.
 * 파일별로 독립적으로 판단한다.
 */
export function setupSkill(repoPath: string): SkillSetupResult {
  const skillBody = skillContent();
  const results: SkillTarget[] = [];

  for (const rel of SKILL_DIRS) {
    const dir = join(repoPath, rel);
    const path = join(dir, "SKILL.md");

    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (!current.includes(MARKER)) {
        results.push({ path, kind: "skill", status: "skipped", reason: "foreign" });
        continue;
      }
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(path, skillBody, "utf8");
    results.push({ path, kind: "skill", status: "written" });
  }

  for (const f of INSTRUCTION_FILES) {
    const path = join(repoPath, f.name);

    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (!current.includes(MARKER)) {
        results.push({ path, kind: f.kind, status: "skipped", reason: "foreign" });
        continue;
      }
    }

    writeFileSync(path, f.body(), "utf8");
    results.push({ path, kind: f.kind, status: "written" });
  }

  return results;
}
