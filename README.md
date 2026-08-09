# kybird-nest

코딩 에이전트를 위한 지식·스킬 백엔드와, 그 위에 얹은 칸반/대시보드.

설계는 [doc/brief.md](doc/brief.md)가 SSOT다. 요약하면 **서버는 저장과
동기화만 하고, 계산은 전부 클라이언트가 한다.** 오프라인에서도 작업이
막히지 않는 게 전제다.

## 지금 되는 것

brief.md 6장 기준 **3단계 (MCP + git hook + backfill)** 까지.
여기까지가 "혼자 쓰기엔 충분히 돌아가는" 지점이다.

- 계정, 레포, 칸반 보드
- 오프라인 우선 동기화 — 서버가 없어도 로컬에 쌓았다가 나중에 올린다
- CLI(`knest`)와 웹 UI가 **대등한 클라이언트**다. 어느 쪽에서 옮겨도 같은
  경로로 seq 를 받아 서로에게 전파된다
- 충돌은 최후 승자 승리, 진 값은 로컬에 사본으로 남는다
- wiki: 지식 주입, 키워드(FTS5)+벡터 하이브리드 검색, index.md 컴파일
- 검색은 **반드시 로그를 남긴다** — 평가 정답셋의 씨앗이라 옵션으로 두지 않았다
- MCP 서버 — 에이전트가 붙어서 검색·기록·칸반 조작을 한다
- git hook + backfill — 지식 주입 3층 완성

스킬 상속·평가 하네스는 아직 없다 (4단계 이후).

## 에이전트에 붙이기

MCP 서버를 프로젝트 디렉토리에서 띄우면 된다. 에이전트 설정에 이렇게 넣는다:

```json
{
  "mcpServers": {
    "kybird-nest": {
      "command": "knest",
      "args": ["mcp"]
    }
  }
}
```

도구는 10개다 — `wiki_search` / `wiki_log` / `wiki_mark_used` / `wiki_index` /
`wiki_pending` / `wiki_pending_done` / `wiki_embed` / `kanban_board` /
`kanban_add_card` / `kanban_move_card`.

git hook 은 따로 심는다:

```bash
knest hook install
```

### 지식 주입은 3층이다

에이전트가 말을 듣게 **강제할 방법은 없다.** 대신 비협조를 데이터 손실이
아니라 지연으로 강등시킨다.

| 층 | 트리거 | 에이전트 협조 | 품질 |
|---|---|---|---|
| `wiki_log` | 에이전트가 호출 | 필요 | 높음 |
| git hook | commit / push | 불필요 | 중간 |
| backfill | 아무 때나 | 불필요 | 낮음~중간 |

위층이 비면 아래층이 받는다. 커밋은 git 에 남아있으므로 **지식이 영영
사라지는 구간이 없다.**

훅은 큐에 넣고 즉시 끝난다(커밋 오버헤드 약 0.1초). 훅에서 LLM 을 부르면
커밋이 느려지고, 느려지면 `--no-verify` 로 꺼버리게 된다.

`pre-push` 는 그물이다 — post-commit 이 놓친 것(훅 설치 전 커밋, 리베이스로
생긴 커밋)을 주워담는다.

### 실제로 글을 쓰는 건 에이전트다

`backfill` 은 재료만 준비한다. LLM API 키를 요구하지 않는 이유이고, 그래서
큐가 밀려도 잃는 게 없다 — 다음에 아무 세션이나 붙어서 `wiki_pending` 을
부르면 소화된다.

## 구조

```
apps/server        Next.js + Prisma + SQLite. 인증, 저장, 동기화 API, 웹 UI
packages/shared    서버·클라가 공유하는 프로토콜 타입, 분수 랭크, id 생성
packages/core      로컬 SQLite 스토어, 싱크 엔진, 칸반 로직
packages/cli       knest — 사람이 치는 표면
```

`core` 를 라이브러리로 분리해둔 건 나중에 붙일 MCP 서버가 CLI 와 같은
알맹이를 쓰기 위해서다. CLI 하나로 만들면 MCP 붙일 때 절반을 다시 짜게 된다.

## 시작하기

```bash
npm install
npm run build -w @kybird/shared && npm run build -w @kybird/core && npm run build -w knest
```

서버:

```bash
npm run db:migrate -w @kybird/server
npm run dev -w @kybird/server
```

`http://localhost:3000` 에서 가입하면 대시보드가 나온다.

CLI:

```bash
node packages/cli/dist/index.js login
cd /경로/내프로젝트
node packages/cli/dist/index.js link
node packages/cli/dist/index.js add "첫 카드"
node packages/cli/dist/index.js board
```

`knest` 로 바로 쓰려면 `npm link -w knest`.

## 테스트

단위 테스트는 그냥 돌아간다:

```bash
npm test -w @kybird/shared
```

종단 테스트는 **서버가 떠 있어야 한다.** 동기화는 커서 전진·순서·격리처럼
단위 테스트로 안 잡히는 버그가 나오는 곳이라 살아있는 서버를 상대로 돌린다.

```bash
BASE=http://localhost:3000 npm run test:e2e -w @kybird/server
BASE=http://localhost:3000 npm run test:e2e -w @kybird/core
```

wiki 테스트는 서버 없이 돌지만, **임베딩 모델을 처음 받을 때만 네트워크가
필요하다** (약 100MB, 이후 캐시):

```bash
npm run test:wiki -w @kybird/core
```

MCP 테스트는 진짜 MCP 클라이언트로 붙어서 도구를 호출한다. 연결된 git 레포
디렉토리를 가리켜야 한다:

```bash
PROJ=/경로/내프로젝트 npm run test:mcp -w knest
```

## 알아둘 것

- **로컬 스토어는 머신에 하나** (`~/.kybird/store.db`). 레포마다 두지 않는다 —
  cross-project 검색이 클라이언트에서 도는 이상 한 유저의 모든 레포가
  한자리에 있어야 한다.
- **레포 식별은 `.kybird/repo.json`.** git remote 로 식별하는 안도 있었지만
  "git 프로젝트가 아닐 수도 있다"와 양립하지 않는다. 비밀이 아니므로
  커밋해도 된다 — 오히려 커밋해두면 다른 머신에서 클론했을 때 바로 이어진다.
- **토큰은 `~/.kybird/config.json`.** 레포 안에 두지 않는다.
- **카드 순서는 정수가 아니라 문자열 분수 랭크다.** 정수 순서는 오프라인에서
  두 머신이 카드를 옮기면 반드시 충돌한다.

- **검색 인덱스(FTS5)와 벡터는 파생물이다.** 인덱스는 동기화하지 않고 각
  머신이 자기 것을 만든다. 벡터는 재계산이 비싸서 동기화하지만, 서버
  입장에서는 그냥 blob 이다.
- **`index.md` 는 생성물이라 커밋하지 않는다.** seed 문서에 기록된 사고가
  바로 이걸 커밋해서 생겼다 — 전체 커밋의 10%가 이 파일 하나였고, 두 곳에서
  컴파일하면 100% 충돌했다.

환경변수: `KYBIRD_HOME` (설정·스토어 위치), `KNEST_PASSWORD` (비대화형 로그인),
`KNEST_DEBUG` (훅이 삼킨 오류를 보여준다 — 훅은 커밋을 막지 않으려고 모든
예외를 삼키는데, 그 침묵이 진짜 버그도 가린다).

## 알려진 문제

`@huggingface/transformers` 가 `sharp`(이미지)와 `adm-zip`(설치 시 압축 해제)을
통해 high 등급 취약점 4건을 끌고 온다. 텍스트 임베딩은 두 경로를 쓰지 않지만
의존성 트리에는 들어있다. `npm audit` 으로 확인할 수 있다.

임베더는 `Embedder` 인터페이스로 갈아끼울 수 있게 해뒀으므로, 이 트리를
원치 않으면 다른 구현을 붙이고 이 의존성을 빼면 된다.
