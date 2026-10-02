# agent-usage

AI 코딩 에이전트(Claude Code, Codex)를 **얼마나 쓰고 있는지**, 그리고 **이전 기간과 비교해 어떻게 변했는지** 보여주는 React 컴포넌트.

로컬 로그만 읽고, 외부로 아무것도 보내지 않습니다.

## 빠른 시작

```bash
npm install
npm run collect   # 내 로컬 로그 → public/usage.json (git에 안 올라감)
npm run dev
```

`public/usage.json`이 없으면 합성 샘플 데이터(`public/usage.sample.json`)로 렌더링됩니다.

## 화면 구성

- **헤더** — 기간(오늘 / 7 / 30 / 90일)과 에이전트(전체 / Claude Code / Codex) 필터
  - 7·30·90일: 최근 N일을 바로 앞 N일과 비교
  - **오늘: 어제의 나와 비교.** 하루가 끝나지 않았으니 어제 하루 전체가 아니라 *어제 같은 시각까지*와 비교 (시간 단위 데이터, 진행 중인 시간은 분 비율로 계산)
- **지표 탭** — 5개 지표의 현재 값과 방향(↑↓)만. 누른 지표가 아래 전체를 바꿈
  | 지표 | 의미 |
  |---|---|
  | 활성 시간 | 에이전트가 일한 실제 벽시계 시간. 동시 세션은 한 번만 세고(에이전트끼리 겹쳐도), 5분 넘는 공백은 제외 |
  | 에이전트 가동 | 세션별 작업 시간의 합. 병렬 세션·서브에이전트가 겹쳐 쌓임 |
  | 프롬프트 | 사람이 직접 보낸 요청 수 |
  | 세션 | 하루에 열린 대화 세션 수 |
  | 토큰 | 입력 + 출력 (캐시 읽기 제외) |
- **히어로** — 얼마나 변했는지를 크게("↑ 95% 늘었어요"), 비교 대상 값을 한 줄로("이전 30일엔 132.6h"), 보조 통계 3개
- **추세 차트**
  - 기간: 최근(실선) vs 이전(점선) 일별. 오늘이 진행 중이면 마지막 구간은 점선
  - 오늘: 0–24시 누적 곡선. 어제는 하루 끝까지 점선으로 그려서 "어제는 여기까지 갔다"가 보이고, 지금 시각에 오늘과 어제의 차이를 표시
- **에이전트 비중** — 이전/최근 100% 막대로 누가 일을 했는지의 변화, 에이전트별 값과 증감
- **모델** — 응답 수 기준 상위 모델
- **활동 기록** — GitHub 잔디처럼 하루하루를 칸으로. 최대 1년, 화면 폭에 맞춰 주 수가 조절됨
- **표로 보기** — 차트와 같은 값을 표로 (오늘이면 시간별)

**숫자는 한 자리에 한 번만:** 현재 값은 탭에, 변화량은 히어로에, 비교 대상 값은 히어로 문장에만 나옵니다. 차트는 호버할 때만 숫자를 보여줍니다.

디자인 메모: 색은 에이전트 구분(Claude Code 주황, Codex 파랑)에만 쓰고, 나머지는 잉크 한 가지 농도로 표현합니다. 라이트/다크 모두 대응하고, `prefers-reduced-motion`이면 애니메이션을 끕니다. 글꼴은 Pretendard(없으면 시스템 글꼴).

## 데이터 수집 (`scripts/collect.mjs`)

| 에이전트 | 읽는 위치 | 세는 방식 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 응답은 `message.id`, 프롬프트는 레코드 `uuid`로 중복 제거 (이어하기한 세션이 이전 기록을 복사해도 한 번만 셈) |
| Codex | `~/.codex/sessions/**/*.jsonl` | 토큰은 누적 `token_count`의 차분, 프롬프트는 `task_started` |

### SSH 서버의 로그도 합치기

서버에서 직접 `claude` / `codex`를 실행하면 로그는 서버에만 남습니다. `remotes.txt`(gitignore됨)에 SSH 호스트를 한 줄에 하나씩 적거나 `--remote`로 넘기세요. 서버에 `node`만 있으면 되고, 설치할 것은 없습니다.

```bash
echo my-server >> remotes.txt
npm run collect            # 또는: npm run collect -- --remote my-server
```

스크립트를 SSH로 서버에 흘려보내 `--raw` 모드로 실행하고(서버에 파일을 남기지 않음), 메시지 id·프롬프트 id·파일별 활동 구간만 받아와 합칩니다. 데스크톱 앱의 SSH 세션은 로컬(`~/.claude/projects/ssh-*`)에도 사본이 남는데, 같은 id로 합쳐지므로 두 번 세지 않습니다. 날짜는 서버가 아닌 이 컴퓨터의 시간대를 따릅니다.

출력에는 **일별 집계값과 모델별 응답 수만** 들어갑니다. 프롬프트 내용, 경로, 프로젝트 이름은 포함되지 않습니다. 날짜는 로컬 시간대 기준입니다.

## 컴포넌트로 쓰기

```tsx
import { AgentUsage } from "./src";

<AgentUsage data={usage} defaultRange={30} defaultMetric="activeHours" />
```

| prop | 기본값 | 설명 |
|---|---|---|
| `data` | — | `collect.mjs`가 만든 JSON |
| `endDate` | 수집일 | 비교 기준이 되는 마지막 날 (`YYYY-MM-DD`) |
| `defaultRange` | `30` | `7 \| 30 \| 90` |
| `defaultMetric` | `"activeHours"` | `activeHours \| agentHours \| prompts \| sessions \| tokens` |

라이트/다크 모드는 `prefers-color-scheme`과 `<html data-theme="dark|light">`를 모두 따릅니다.

## 다른 에이전트 추가

`collect.mjs`에 `collectXxx()`를 추가해 `bucket(date, "xxx")`에 값을 쌓고, 출력의 `agents`에 표시 이름을 넣으면 컴포넌트는 그대로 동작합니다 (색은 순서대로 배정).
