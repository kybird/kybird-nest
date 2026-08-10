<!-- kybird-nest:generated -->
<!-- knest link 가 자동 생성한 파일이다. 직접 고쳐도 되지만, 그러면 이
     마커가 없어져서 다음 link 때 덮어쓰지 않는다(사용자 수정 존중). -->

# knest — 이 프로젝트의 지식·칸반 백엔드

이 레포는 kybird-nest(knest)에 연결돼있다. 서버가 지식(wiki)과 칸반
보드를 저장하고, 여러 사람·기기가 공유한다.

## 칸반으로 작업을 관리해라

작업을 시작할 때 보드를 보고, 새 작업은 카드로 만들어라:

```
knest board                           현재 보드
knest add "<제목>" [--column 컬럼]      카드 추가
knest mv <카드> <컬럼>                 카드 옮기기
```

## 작업 시작 전 — 먼저 검색해라

```
knest wiki search "<찾고 싶은 것>"
```

과거에(과거의 나 포함) 알아낸 게 있는지 먼저 본다. 실제로 참고한 항목은
`knest wiki used <로그id> <엔트리id>` 로 표시한다.

## 작업 끝나면 — 알게 된 걸 남겨라

```
knest wiki add "제목" --body "본문" [--kind concept|pattern|gotcha|decision|reference]
```

정리된 지식. 다듬을 시간이 없으면 `knest wiki raw "메모"`.

자세한 명령은 `knest help`. (knest 스킬이 활성화돼 있으면 더 자세한
절차가 스킬 본문에 있다.)
