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

- **기간 필터** 7 / 30 / 90일 — 최근 N일과 바로 앞 N일을 비교
- **에이전트 필터** 전체 / Claude Code / Codex
- **지표 타일** (클릭하면 아래 차트 지표가 바뀜)
  | 지표 | 의미 |
  |---|---|
  | 활성 시간 | 에이전트가 일한 실제 벽시계 시간. 동시 세션은 한 번만 세고, 5분 넘는 공백은 제외 |
  | 에이전트 가동 | 세션별 작업 시간의 합. 병렬 세션·서브에이전트가 겹쳐 쌓임 |
  | 프롬프트 | 사람이 직접 보낸 요청 수 |
  | 세션 | 하루에 열린 대화 세션 수 |
  | 토큰 | 입력 + 출력 (캐시 읽기 제외) |
- **일별 비교 차트** — 최근 기간(실선) vs 이전 기간(점선), 호버 시 두 날짜 값
- **에이전트별** — 기간별 값·점유율·변화율
- **모델** — 응답 수 기준 상위 모델
- **주간 추이** — 전체 기록을 주 단위 누적 막대로
- **표로 보기** — 차트와 같은 값을 표로

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
