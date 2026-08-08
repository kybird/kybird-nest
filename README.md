# kybird-nest

코딩 에이전트를 위한 지식·스킬 백엔드와, 그 위에 얹은 칸반/대시보드.

설계는 [doc/brief.md](doc/brief.md)가 SSOT다. 요약하면 **서버는 저장과
동기화만 하고, 계산은 전부 클라이언트가 한다.** 오프라인에서도 작업이
막히지 않는 게 전제다.

## 지금 되는 것

brief.md 6장 기준 **1단계 (서버 + 싱크 + 칸반)** 까지.

- 계정, 레포, 칸반 보드
- 오프라인 우선 동기화 — 서버가 없어도 로컬에 쌓았다가 나중에 올린다
- CLI(`knest`)와 웹 UI가 **대등한 클라이언트**다. 어느 쪽에서 옮겨도 같은
  경로로 seq 를 받아 서로에게 전파된다
- 충돌은 최후 승자 승리, 진 값은 로컬에 사본으로 남는다

wiki·스킬·MCP·평가는 아직 없다 (2단계 이후).

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

환경변수: `KYBIRD_HOME` (설정·스토어 위치), `KNEST_PASSWORD` (비대화형 로그인).
