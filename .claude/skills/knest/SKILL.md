---
name: knest
description: kybird-nest 지식·칸반 백엔드 사용. 작업 시작 전 검색, 끝나면 기록.
---

<!-- kybird-nest:generated -->
<!-- knest link 가 자동 생성한 파일이다. 직접 고쳐도 되지만, 그러면 이
     마커가 없어져서 다음 link 때 덮어쓰지 않는다(사용자 수정 존중). -->

# knest — 이 프로젝트에 연결된 지식·칸반 백엔드

이 레포는 kybird-nest 에 연결돼있다. 서버가 프로젝트 지식(wiki)과 칸반
보드를 저장하고, 여러 사람·기기가 공유한다.

## 작업 시작 전 — 먼저 검색해라

```
knest wiki search "<찾고 싶은 것>"
```

이미 누가(과거의 나 자신 포함) 알아낸 게 있는지 먼저 확인하면 같은 문제를
다시 풀지 않는다. 결과에 로그 id 가 같이 나오는데, 실제로 참고한 항목이
있으면 `knest wiki used <로그id> <엔트리id>...`로 표시해라 — 검색 품질
평가에 쓰인다.

## 작업 끝나면 — 알게 된 걸 남겨라

정리된 지식(결론 + 근거를 같이):
```
knest wiki add "제목" --body "본문" [--kind concept|pattern|gotcha|decision|reference]
```

다듬을 시간이 없는 원본 메모(나중에 다시 떠올라 압축될 수 있다):
```
knest wiki raw "메모"
```

## 커밋할 때마다

git hook 이 설치돼있으면, 커밋 직후에 "기록할 게 있으면 지금 남겨라"는
안내가 뜬다. 그 순간이 맥락이 살아있어서 기록하기 가장 좋을 때다 — 무시하지
말고 실제로 확인해라.

## 칸반

```
knest board                                     현재 보드 보기
knest add "<제목>" [--column 컬럼] [--body 본문]  카드 추가
knest mv <카드> <컬럼>                           카드 옮기기
```

## 밀린 것 처리

평소엔 커밋 직후 안내에서 몇 개씩 조금씩 처리하면 되지만, **이 레포에
knest를 막 붙였거나 밀린 게 많이 쌓여있으면** 하나씩 반복하지 말고 한
세션에 몰아서 처리해라:

```
knest backfill --all                 밀린 커밋 전부를 한 번에 텍스트로 받는다
```

받은 재료를 훑어보고, 남길 가치 있는 것만 `knest wiki add`/`raw`로
기록한 뒤, 다 본 것들은 `knest backfill done <큐id>...`로 한 번에 표시해라
(명령 자체에 큐 id 목록이 같이 나온다).

자세한 전체 명령은 `knest help`, `knest wiki help`.
