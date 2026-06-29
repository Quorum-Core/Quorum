# Quorum (Quorum)

Next.js(App Router) 기반 **AI 에이전트 본사 시뮬레이션** 웹앱. 30명의 전문 분야 AI 에이전트가
회의를 통해 안건을 논의하고, 의장(결재)의 승인을 거쳐 지시를 실행합니다. 회의를 거듭할수록
각 에이전트가 **학습 루프**로 교훈을 축적해 점점 더 맥락에 맞는 의견을 냅니다.

---

## 목차
- [핵심 개념](#핵심-개념)
- [주요 기능](#주요-기능)
- [학습 루프 (Phase A)](#학습-루프-phase-a)
- [도구 / MCP (Phase B)](#도구--mcp-phase-b)
- [보안 모델](#보안-모델)
- [기술 스택](#기술-스택)
- [시작하기](#시작하기)
- [환경 변수](#환경-변수)
- [DB provider](#db-provider)
- [디렉터리 구조](#디렉터리-구조)
- [스크립트 / 테스트](#스크립트--테스트)

---

## 핵심 개념

| 개념 | 설명 |
| --- | --- |
| **에이전트** | 30명. 분야별 페르소나·전문성·말투를 가진 LLM 캐릭터 (`src/data/`). |
| **회의(meeting)** | 안건을 주면 주제에 맞는 에이전트들이 순차 발언 → 검증(risk) → 종합(lead) → 요약·보고서. |
| **지시(directive)** | 회의 결론을 의장이 승인하면 각 에이전트가 상세 분석을 실행해 보고서로 정리. |
| **백그라운드 러너** | 회의 진행은 서버 측 `meeting-runner`가 끝까지 구동 → 탭을 닫아도 계속, 재시작에도 복원. |
| **학습 메모리** | 회의에서 얻은 교훈을 에이전트별로 영속 저장 → 다음 회의에 참고(RETRIEVE↔REFLECT). |

---

## 주요 기능

- **회의실(MeetingRoom)** — 안건 투입 → 에이전트 순차 발언. 토큰 단위 실시간 스트리밍, 백그라운드 완주.
- **지시 실행** — 승인된 회의 결론을 각 에이전트가 분석·실행, 보고서 생성.
- **대시보드** — 에이전트 상태, 의사결정 그래프, 타임라인, 보고서 검토.
- **도구 호출** — 일부 에이전트가 `web_search`(Tavily)·`calculate`(mathjs), 그리고 선택적 **MCP 도구** 사용.
- **학습 루프** — 회의 경험에서 교훈을 추출·축적해 재사용(아래).

---

## 학습 루프 (Phase A)

회의가 끝나면 토론 내용에서 **재사용 가능한 교훈**을 뽑아 에이전트별로 저장하고, 다음 회의 발언 시
참고합니다. 두 훅으로 구성됩니다.

```
회의 토론 ──(REFLECT)──▶ agent_memory(교훈 축적)
                              │
다음 회의 ◀──(RETRIEVE)───────┘  발언 프롬프트에 과거 교훈 주입
```

- **RETRIEVE** (`src/lib/meeting-runner.ts`) — 발언 직전, 그 에이전트의 활성 메모리(중요도·최근순 상위 N)를
  **낮은 권한 fenced 블록**(`UNTRUSTED_LEARNED_CONTEXT`)으로 user 메시지에 주입. systemPrompt에 직접 넣지 않음.
- **REFLECT** (`src/lib/learning.ts`) — 회의 finalize 시점에 LLM이 발언에서 교훈을 추출하고,
  **attribution 검증**(어느 발언의 어느 구절이 근거인지 DB 원문과 대조)을 통과한 것만 저장.
- **데이터 모델** (2-테이블 분리로 멱등성과 evidence_count 수렴 양립):
  - `agent_memory` — canonical 교훈(정규화 해시로 dedup, 반복되면 `evidence_count` 증가).
  - `memory_evidence` / `memory_evidence_links` — 발언 span ↔ 교훈 연결(라운드별 발생, 멱등).
  - `meeting_reflections` — round 단위 lease 기반 marker(중복 reflect·crash 복원·재시도 한도).
- **불변식**: 멱등(같은 회의 재처리 시 중복 0), orphan 복원(crash 안전), lease(멀티 러너 중복 방지),
  attribution(LLM 환각 근거 차단).

스키마: `src/lib/sqlite.ts`(자동 마이그레이션) / `sql/learning-loop.sql` + `sql/learning-loop-rpc.sql`(Supabase).

---

## 도구 / MCP (Phase B)

- **정적 도구**: `web_search`(Tavily 웹검색), `calculate`(mathjs 수식).
- **MCP 도구**(선택): 외부 [MCP](https://modelcontextprotocol.io) 서버의 도구를 **curated 등록분만** 노출.
  - 미설정(`MCP_SERVERS` 없음)이면 완전 dormant — 기존 동작 그대로.
  - 외부 tool 이름/설명/스키마는 신뢰하지 않고 **로컬 정의(curated)** 만 사용.
- 도구 호출 루프·동적 스펙 병합은 `src/lib/openrouter.ts`·`src/lib/agent-tools.ts`,
  MCP 브리지는 `src/lib/mcp-client.ts`.

---

## 보안 모델

학습 메모리·도구 결과·외부 입력을 모두 **신뢰 경계 밖(untrusted)** 으로 다룹니다.

- **프롬프트 인젝션 방어** — 회의 로그·학습 메모리·도구 결과는 `untrustedBlock`(`src/lib/untrusted.ts`)으로
  감싸고, 펜스 토큰 위조를 제거. "이전 지침 무시" 류 지시를 따르지 않도록 systemPrompt에 규칙 고정.
- **비밀값 유출 차단** — 모든 도구 인자를 호출 전 재귀 스캔(`scanArgsForSecret`)해 API 키·토큰이
  외부 도구(web_search/MCP)로 새지 않게 차단.
- **SSRF 방어**(MCP) — HTTPS only, private/loopback/메타데이터 CIDR(IPv4·IPv6·v4-mapped) 차단,
  DNS 해소 IP 전수 검사 + undici IP pinning(rebinding 차단), redirect off, timeout·size cap.
- **attribution** — 학습 교훈은 LLM 자기보고를 신뢰하지 않고 회의 원문과 대조한 것만 저장.

---

## 기술 스택

- **Next.js 16** (App Router) / **React 19** / **TypeScript**
- Tailwind CSS v4 + shadcn / base-ui
- **LLM**: OpenRouter (기본 `openai/gpt-oss-120b`)
- **DB**: SQLite(기본) / PostgreSQL / Supabase — `src/lib/db.ts`에서 추상화
- 회의 실시간 표시: Supabase Realtime
- 도구: Tavily(web_search), mathjs(calculate), MCP(`@modelcontextprotocol` 호환 HTTP)

---

## 시작하기

```bash
npm install
cp .env.example .env.local   # 키 채우기 (OPENROUTER_API_KEY 등)
npm run dev                  # http://localhost:3000
```

기본은 SQLite라 별도 DB 없이 바로 동작합니다. 학습 루프도 SQLite에서 즉시 켜집니다.

---

## 환경 변수

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | ✅ | LLM 호출 키. |
| `OPENROUTER_MEETING_MODEL` |  | 회의 발언 모델(기본 `openai/gpt-oss-120b`). |
| `DB_PROVIDER` |  | `sqlite`(기본) / `postgres` / `supabase`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` |  | Supabase 사용 시(설정되면 자동 전환). |
| `TAVILY_API_KEY` |  | `web_search` 도구. 없으면 검색만 비활성. |
| `MCP_SERVERS` |  | MCP 서버 목록 JSON `[{name,url,headers}]`. 없으면 MCP dormant. |
| `MCP_TOOLS` |  | curated MCP 도구 JSON `[{server,tool,description,parameters}]`. |

---

## DB provider

`DB_PROVIDER`로 `sqlite`(기본) / `postgres` / `supabase` 선택. Supabase URL/키가 있으면 자동 `supabase`.
회의 실시간 표시는 Supabase Realtime을 쓰므로 **프로덕션은 Supabase 권장**.

- 스키마: `sql/`·`supabase/` 마이그레이션 참고.
- **학습 루프 활성화**:
  - SQLite — `src/lib/sqlite.ts`가 자동 마이그레이션(별도 작업 없음).
  - Supabase — `sql/learning-loop.sql`(스키마) → `sql/learning-loop-rpc.sql`(RPC) 순서로 적용.
    미적용 시 학습 훅은 graceful skip(회의 진행에는 영향 없음).

---

## 디렉터리 구조

```
src/
 ├─ app/
 │   ├─ api/*/route.ts   # API 엔드포인트(meeting·directive·reports·agents·chat 등)
 │   └─ page.tsx         # 메인 UI
 ├─ components/          # UI(MeetingRoom·대시보드·그래프 등)
 ├─ data/                # 에이전트 roster·persona·층·토픽·관계
 └─ lib/
     ├─ db.ts            # DB 추상화(sqlite/supabase 디스패치)
     ├─ sqlite.ts        # SQLite 스키마·마이그레이션·시드
     ├─ supabase-db.ts   # Supabase 쿼리
     ├─ openrouter.ts    # LLM 호출·도구 루프
     ├─ agent-tools.ts   # web_search·calculate·secret 스캐너·getToolSpecs
     ├─ meeting-runner.ts # 백그라운드 회의 오케스트레이터 + 학습 훅
     ├─ learning-core.ts # 학습 순수 로직(hashing·추출·attribution, DB 비의존)
     ├─ learning.ts      # 학습 SQLite 트랜잭션
     ├─ learning-supabase.ts # 학습 Supabase RPC
     ├─ mcp-client.ts    # MCP 브리지(curated 노출·호출)
     ├─ mcp-ssrf.ts      # SSRF 가드(CIDR·URL·tool name)
     └─ untrusted.ts     # 프롬프트 인젝션 방어 래퍼
sql/                     # Supabase 스키마·학습 RPC·리셋
__tests__/               # Jest 테스트
```

자세한 구조·규칙은 [`AGENTS.md`](./AGENTS.md), 학습/MCP 설계는 [`docs/hermes-integration.md`](./docs/hermes-integration.md) 참고.

---

## 스크립트 / 테스트

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 |
| `npm run build` | 프로덕션 빌드 |
| `npm start` | 프로덕션 서버 |
| `npm run lint` | ESLint |
| `npm test` | Jest 테스트 |
| `npm run test:coverage` | 커버리지 |

테스트는 `__tests__/`에 위치하며 학습 루프(멱등·attribution·복원)·MCP(SSRF·파싱)·DB·보안 가드를 커버합니다.
