# Eidos 프로젝트 핸드오프

이 문서는 프론트엔드 개발자와 후속 에이전트가 현재 구현을 빠르게 이해하고 이어서 작업하기 위한 기준 문서다. 전시 환경은 GitHub Pages가 아니라 전시 Mac의 로컬 Node 서버 + Chrome 키오스크다.

## 1. 관람객이 보는 전체 흐름

```text
BOOT → IDLE → PRESENCE → REALTIME-CONNECTING → WAKE-LISTEN
     → REQUEST-LISTEN → ANALYZING → RESULT → WAIT-FOR-EXIT
```

- 카메라와 얼굴 감지는 브라우저의 MediaPipe에서 처리한다. 프레임·얼굴 이미지·바운딩박스는 저장하지 않는다.
- 얼굴 신뢰도 `0.65 이상`, 화면 면적 `2% 이상`인 얼굴이 `0.5초` 유지되면 관람객으로 확정한다.
- Realtime이 준비되기 전에는 대기 화면만 보이고, 준비가 끝나면 `Say “Hi, Eidos”` 화면이 보인다.
- 호출어는 `Hi Eidos`, `하이 에이도스`, `하이 아이도스` 조합만 인정한다. 호출어 뒤 요청이 붙어 있으면 그대로 요청문으로 넘긴다.
- 호출어 대기는 최대 20초다. 하나의 일반 Realtime 세션을 `gpt-realtime-2.1-mini`로 열고, 입력 전사는 `gpt-live-transcribe`, 발화 종료는 `semantic_vad · medium`으로 세션 시작부터 활성화한다. 호출어는 실시간 전사 delta에서 감지하고, 호출어 이후 요청은 `speech_stopped`와 해당 오디오 item의 `completed` 전사가 확정된 뒤 2초 debounce를 거쳐 `/api/analyze`로 보낸다. 전사 전용 `type: "transcription"` 세션에 Semantic VAD를 동적으로 넣는 방식은 지원되지 않으므로 사용하지 않는다.
- 요청을 라우팅할 수 없으면 오류 화면으로 보내지 않고 같은 요청 화면에서 “죄송합니다. 다시 말씀해주세요.”를 보여준 뒤 재청취한다.
- 요청 발화 완료 이벤트가 15초 안에 오지 않으면 현재 요청을 버리고 처음 대기 상태로 돌아간다.
- 분석 화면은 로봇 카드가 세로 슬롯처럼 약 3초간 이동한다. 카드 이동 주기는 약 `760ms`, 최종 로봇 안착 후 안정화 시간은 약 `650ms`다.
- 결과 화면에서는 로봇 영상이 무음·반복 재생된다. 유효한 결과만 `Soma 001` 같은 누적 번호를 증가시킨다.
- 결과/오류 이후에는 관람객 얼굴이 사라지는 것을 기다린다. Thank you 화면은 얼굴이 남아 있어도 약 5초 후 idle로 돌아간다.

## 2. 로컬 실행 방법

실제 API 키가 필요한 로컬 시연에서는 `.env`를 프로젝트 루트에 유지한다. 이 파일은 Git에 올리지 않는다.

```bash
npm install
cp .env.example .env       # 최초 1회
# .env에 OPENAI_API_KEY 입력
npm run dev                 # UI 5173, API 3000
```

전시형 실행:

```bash
./start-eidos.command
# 또는
npm run kiosk
```

`start-eidos.command`는 빌드, API 기동, `/api/runtime` 점검, 전용 Chrome 프로필과 키오스크 모드 실행을 담당한다. 카메라·마이크 권한은 첫 실행 시 Chrome에서 허용해야 한다.

API 키 없이 UI만 확인할 때:

```bash
EIDOS_MOCK=true npm run start --workspace @eidos/server
open 'http://127.0.0.1:3000/?mock&debug'
```

- `?mock`: 카메라·마이크·OpenAI 없이 Mock 흐름을 테스트한다.
- `?gallery`: 모든 상태와 18개 로봇 결과 영상을 확인한다.
- `?debug`: 개발 모니터를 연 상태로 시작한다.
- 세로 화면/DevTools는 `npm run dev` 후 일반 Chrome 프로필로 열고 `?mock&debug`를 사용한다. 키오스크 Chrome은 DevTools 튜닝용이 아니다.

## 3. 운영자용 단축키와 히든 커맨드

### 키보드 단축키

- `Ctrl + Option + E`: 개발 모니터 패널 열기/닫기
- `Ctrl + Option + R`: 강제 초기화

Mac의 Option 키는 브라우저 이벤트에서 `Alt`로 처리된다. 최종 전시 UI에서는 패널을 닫아두지만 단축키 자체는 남겨둔다.

### 패널 커맨드

개발 모니터 하단의 Command 입력창에서 실행한다.

```text
/mic pause       마이크 트랙을 mute하고 Realtime 입력을 잠시 멈춤
/mic resume      같은 Realtime 연결에서 마이크 입력 재개
/mic status      active / paused / not connected 상태 반환
/counter status  현재 Soma 카운터 확인
/counter reset   확인 문구 표시
/counter reset confirm  카운터만 0으로 초기화
```

운영 패널에는 위 기능을 버튼으로도 제공한다. `Reset counter`는 실수 방지를 위해 5초 안에 한 번 더 눌러야 실행된다. 카운터 초기화는 `data/eidos.sqlite`의 번호만 0으로 되돌리며 세션 로그나 영상을 삭제하지 않는다. pause는 연결을 끊지 않는다. 재연결 문제를 확인하는 테스트 중 잠시 수음을 막을 때 사용한다.

패널에서는 카메라 권한·MediaPipe 상태, 얼굴 수/confidence/면적/안정 시간, Realtime 연결, Realtime 모델과 `gpt-live-transcribe` 전사 모델, 마이크 선택기와 active input, microphone level, `semantic_vad · medium` 준비 상태, Semantic VAD speech started/stopped, partial/completed transcript, `HI EIDOS DETECTED`, 이벤트 로그, 최근 세션, JSON 내보내기, Mock/18개 로봇 갤러리를 확인할 수 있다.

## 4. 프로젝트 구조

```text
apps/web/
  src/App.tsx       상태 머신, 화면 전환, 운영 패널, Mock 컨트롤
  src/presence.tsx  MediaPipe 얼굴 감지와 presence 판정
  src/realtime.ts   WebRTC Realtime 세션, gpt-live-transcribe 전사, Semantic VAD 이벤트, 마이크 선택기와 오디오 미터
  src/styles.css    화면 레이아웃·색상 토큰·모션
  public/media/     robot-01..18.webm와 .webp

apps/server/
  src/server.ts       로컬 Express API와 정적 파일 서버
  src/config.ts       .env 설정과 모델명
  src/analysis.ts     Luna Structured Outputs 호출과 결과 검증
  src/routing.ts      숨은 코드·환경 규칙·Mock 의미 라우팅
  src/robotCatalog.ts 18개 로봇 카탈로그와 런타임 라우팅 정책
  src/db.ts           SQLite 카운터·세션 로그·30일 정리

packages/shared/src/index.ts  공유 phase/result/runtime 타입
scripts/                      미디어 변환·검증·런타임 점검
```

프론트 디자인을 바꿀 때 기본적으로 `apps/web/src/styles.css`와 화면 컴포넌트만 수정한다. API 계약, 상태 이름, 비디오 무음·반복 재생, 카메라/음성 데이터 비저장 정책은 유지한다. 영구 OpenAI 키를 `VITE_*` 변수나 브라우저 코드에 넣으면 안 된다.

## 5. 프론트엔드 계약

```ts
type AnalysisResult = {
  sessionId: string;
  robotId: number;          // 1..18
  displayName: string;      // Soma 001, 서버 카운터로 생성
  title: string;            // 영문 2~5단어
  requiredTasks: string[];  // 영문 3~5개, 각 1~4단어
  matchedRule: string;
  videoUrl: string;         // /media/robot-01.webm
};
```

로컬 API:

| Method | Endpoint | 역할 |
| --- | --- | --- |
| POST | `/api/realtime/session` | 브라우저용 단기 Realtime client secret 발급 |
| POST | `/api/analyze` | `{ sessionId, transcript, startedAt }`를 분석해 결과 반환 |
| GET | `/api/runtime` | 카운터·18개 자산·모델·Mock 상태 |
| GET | `/api/operator/status` | API 키·DB·미디어 진단 |
| GET | `/api/operator/sessions` | 최근 세션 메타데이터 |
| POST | `/api/operator/reset` | 운영자 reset 확인용 엔드포인트 |
| POST | `/api/operator/counter/reset` | `{ confirm: true }`일 때 카운터만 0으로 초기화 |

`/api/analyze`는 라우팅 불가 시 `422 { code: "unroutable" }`, 분석/LLM 오류 시 `502`를 반환한다. 프론트는 422를 재청취로 처리하고 그 외 오류는 오류 상태로 처리한다.

## 6. 로봇 알고리즘의 기초

라이브 모드에서는 서버가 먼저 결정론적 규칙을 확인한 뒤, 의미 판단과 영문 출력은 `gpt-5.6-luna`의 단일 Structured Outputs 호출에 맡긴다. reasoning effort는 `medium`이다. 정적 18개 카탈로그와 라우팅 정책을 프롬프트 앞부분에 넣는다.

우선순위:

1. **Step 0 hidden code**: 아래 3개 신호가 한 문장에 모두 포함되면 해당 로봇을 강제한다.
2. **Step 1 환경 키워드**: 공간 스캔은 18, 물 환경은 14, 눈/스키 환경은 12. 여러 환경이 겹치면 18 > 14 > 12 순서다.
3. **Step 2 의미 그룹**: 가정 심부름, 동행, 상업 서비스, 무거운 이동, 고소/정밀, 병렬 작업, 야외 동행으로 분류한다.
4. **Step 3 fallback**: 의미 매칭이 없으면 서버가 미리 정한 로봇 1 또는 2 중 하나를 후보로 전달한다.

라이브 LLM은 로봇 ID, 제목, 태스크, 매칭 규칙, 내부 rationale을 한 번에 반환한다. 서버는 제목/태스크 단어 수, 로봇 ID 범위, JSON 스키마를 검증한다. Mock 모드의 `resolveMockSemanticRoute`는 테스트 전용 근사 라우터이며 라이브 의미 판단을 대체하지 않는다.

### 18개 로봇 역할 요약

| ID | 프리셋 | 핵심 역할 |
| ---: | --- | --- |
| 1 | LIL COMPANION | 실내 가벼운 심부름 |
| 2 | MINI BUDDY | 아이·반려동물과 놀이/교감 |
| 3 | ADVANCED SERVICE MODEL | 실내 서빙·소형 물류 |
| 4 | Mr. HEAVY | 무거운 물건 운반 |
| 5 | Mr. POWER | 무거운 물체 지지·고정 |
| 6 | PACEMAKER | 러닝 동행·페이스 유지 |
| 7 | PUPPY | 저공간 순찰·동행·놀이 |
| 8 | KENTAUROS PAPA | 카트·대형 장비 견인 |
| 9 | KENTAUROS MINI | 마당·현관·가벼운 야외 심부름 |
| 10 | BUSY CENTIPEDE | 안내·디스플레이·다중 분배 |
| 11 | THE MULTITASKER | 요리·정리·분류 병렬 작업 |
| 12 | SHERPA | 눈·스키장 보급품 운반 |
| 13 | LOADER HEAVY | 바닥에서 적재대까지 직접 들어 올림 |
| 14 | AQUARIUS | 물청소·배수·습윤 환경 |
| 15 | ASYMMETRICAL TASK FOCUS MODEL | 고소 작업·케이블·카메라 설치 |
| 16 | QUAD-ARMED WORK FORCE | 공구·조립·정밀 유지보수 |
| 17 | LIL CHUBBY | 자잘하고 가벼운 물건을 많이 보관·운반 |
| 18 | Mr. SENSORPACKET | 공간 스캔·3D 지도·변화 기록 |

상세 원문은 [Eidos 알고리즘 통합 문서](../Eidos_알고리즘_통합문서.md)와 `apps/server/src/robotCatalog.ts`를 함께 본다. 알고리즘을 수정할 때는 `routing.fixtures.test.ts` 픽스처도 함께 수정한다.

## 7. 히든 코드 표

정규화 후 아래 신호 세 개가 모두 포함되어야 한다. 단어 하나만 말하거나 일반적인 요청만 말하는 것은 히든 코드가 아니다. 코드는 파일의 1번부터 18번 순서로 검사되며 Step 1 환경 규칙보다 우선한다.

| 로봇 | 히든 신호 3개 |
| ---: | --- |
| 1 | `집 안` + `가벼운 물건` + `가져다` |
| 2 | `아이` + `반려동물` + `안전하게 놀` |
| 3 | `사람이 많은 곳` + `서빙` + `물품 전달` |
| 4 | `이삿짐` + `무거운 짐` + `빠르게 옮` |
| 5 | `무거운 장비` + `흔들리지 않게` + `잡아` |
| 6 | `달리는 동안` + `페이스` + `짐을 들어` |
| 7 | `낮은 곳` + `함께 놀` + `로봇 강아지` |
| 8 | `무거운 카트` + `끌고` + `균형` |
| 9 | `집과 마당` + `가벼운 심부름` + `네발` |
| 10 | `정보를 보여` + `여러 물건` + `나눠` |
| 11 | `여러 손` + `요리와 정리` + `동시에` |
| 12 | `눈길` + `장비와 보급품` + `운반` |
| 13 | `바닥` + `적재대` + `올릴 힘` |
| 14 | `물이 많은 곳` + `점검` + `씻어` |
| 15 | `높은 곳` + `케이블` + `카메라 장비` |
| 16 | `강하게 고정` + `정밀 조립` + `여러 손` |
| 17 | `자잘한 물건` + `잔뜩` + `이동식 보관함` |
| 18 | `공간 전체` + `스캔` + `변화까지 기록` |

테스트 문장은 자연어로 각 신호를 모두 포함하면 된다. 히든 코드는 관람객 화면에 노출되지 않으며 운영자 검증용이다.

## 8. 미디어와 저장 정책

- 원본 ProRes ZIP/MOV는 Git에 넣지 않는다.
- 브라우저용 `robot-01..18.webm`와 `.webp`만 사용한다. WebM/WebP는 Git LFS 대상이다.
- 영상은 무음이어야 하며 결과 화면에서 `muted`, `loop`, `playsInline`으로 재생한다.
- `data/eidos.sqlite`에는 카운터와 전사·선택 로봇·규칙·제목·태스크·지연·오류만 저장한다.
- 성공 결과 진입 직전에 트랜잭션으로 카운터를 증가시킨다. 실패·취소·Mock 미리보기는 증가하지 않는다.
- 세션 로그는 30일 후 삭제한다. 카메라 프레임, 얼굴 이미지, 오디오 파일은 저장하지 않는다.
- 서버는 기본적으로 `127.0.0.1`에만 바인딩한다.

## 9. 인수인계 시 지켜야 할 것

1. 영구 API 키를 클라이언트 번들, `VITE_*`, 로그, Git에 넣지 않는다.
2. `AnalysisResult`와 `/api/*` 계약을 먼저 유지한 뒤 UI를 바꾼다.
3. 얼굴 감지 threshold, 입력 오디오 보정값, wakeword 정규화는 실제 녹음 테스트 없이 임의로 바꾸지 않는다.
4. 로봇 선택을 더 정교하게 만들더라도 현재 원문 문서의 우선순위를 먼저 보존한다.
5. 새 UI는 `?mock&gallery`에서 카메라·API 없이 모든 상태를 확인할 수 있어야 한다.
6. 제출 전 아래 검사를 실행한다.

```bash
npm run typecheck
npm run test:unit
npm run build
```

현재 프론트의 구체적인 컴포넌트 경계와 API 사용 예시는 [프론트엔드 핸드오프](./FRONTEND-HANDOFF.md)를 참고한다.
