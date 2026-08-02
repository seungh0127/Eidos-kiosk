# Eidos 테스트 이슈 누적 메모

개발 중 발견한 문제를 우선 기록한다. 테스트가 충분히 쌓인 뒤 한 번에 수정하며, 기록 시점에는 앱 코드를 변경하지 않는다.

## Open

### 2026-08-02 — Local VAD false positive 및 반복 turn commit

- 상태: 1차 수정 완료 / 현장 검증 필요
- 조건: 개발자가 화면 앞에 계속 있는 상태에서 의도적으로 말하지 않음
- 관찰 로그:
  - `Local VAD: speech detected`가 반복됨
  - 약 1초 뒤 `Local VAD: turn committed`가 반복됨
  - 같은 시각에 `realtime closed`가 중복 기록됨
  - 호출어를 말하지 않았는데 최종적으로 `Thank you` 화면으로 이동함
- 관련 코드:
  - `apps/web/src/realtime.ts`
  - 현재 RMS 기반 Local VAD threshold: `0.08`
  - silence 판정: `750ms`
- 현재 판단:
  - 현재 계산식상 원시 RMS 약 `0.02`만 넘어도 음성으로 잡힐 수 있어 마이크 노이즈·팬·에어컨·스피커 피드백이 음성으로 오인될 가능성이 있음
  - 최소 음성 지속 시간이나 최소 누적 오디오량 검사가 없어 짧은 노이즈도 commit 대상이 됨
  - `connecting: Local VAD: speech detected`는 실제 Realtime 재연결이 아니라, VAD 이벤트를 `connecting` 상태명으로 기록하고 있는 것임
  - 해당 로그 묶음에서는 `Transcription session connected`가 한 번만 나타나므로, 반복되는 것은 세션 재연결보다 같은 세션 안의 반복 commit으로 보임
  - 호출어가 확인되지 않은 채 20초 wake timeout이 발생하고, 오류 화면 3초 후 `Thank you`로 전환되는 흐름으로 추정
- 나중에 확인·수정할 항목:
  - 실제 무음 환경에서 mic level 기준선 측정
  - adaptive noise floor 또는 threshold 상향
  - 최소 발화 지속 시간·최소 오디오량 도입
  - 한 turn당 commit 1회 보장 및 빈/짧은 commit 차단
  - VAD 이벤트에 `connecting` 대신 별도 상태/로그 타입 사용
  - `dataChannel.close`와 명시적 `stop()`에서 `closed` 중복 로그 제거
- 1차 반영: 적응형 noise floor, 220ms 시작 debounce, 260ms 최소 발화, 1000ms silence, pre-ready 입력 무시, 중복 closed 로그 방지

### 2026-08-02 — LLM rationale 길이 검증 실패

- 상태: 1차 수정 완료 / 현장 검증 필요
- 재현 문장: `Scan this entire space and update the digital twin`
- 오류: `rationale`가 240자를 초과하여 Zod 검증 실패
- 관련 코드: `apps/server/src/analysis.ts`
- 나중에 수정할 항목:
  - Structured Output JSON Schema에 `rationale.maxLength: 240` 추가
  - 프롬프트에 한 문장·240자 이하 조건 명시
  - 서버에서 내부 rationale을 안전하게 정규화하여 전체 분석 실패를 방지
- 1차 반영: Structured Output `maxLength: 240`, 프롬프트 제한, 서버 방어적 truncation

### 2026-08-02 — 이삿짐 요청이 Robot 17로 라우팅됨

- 상태: 현재 구현 유지 / 추가 수정 보류
- 전사: `새로운 집으로 이사했는데 이삿짐을 정리하고 싶어.`
- 결과: `group-a` → Robot 17 `Moving Box Organizer`
- 현재 판단: Robot 4의 결정 규칙은 `이삿짐`·`무거운 짐`·`빠르게 옮`이 모두 필요하므로, 해당 발화에는 강제 규칙이 적용되지 않음. `이삿짐 정리`를 여러 박스 정리로 해석해 Robot 17을 선택함.
- 결정: 원본 알고리즘 문서와 현재 구현을 기준으로 유지. 히든코드 외 하드코딩 라우팅은 추가하지 않음.

### 2026-08-02 — 화면 전환과 음성 수신 준비 시점 불일치

- 상태: 1차 수정 완료 / 현장 검증 필요
- 흐름: 얼굴 인식 → `Hi Eidos` 대기 화면 → 호출어 → 명령
- 관찰: 호출어 대기 화면이 먼저 나타난 직후 발화하면 첫 단어인 `Hi`가 누락되고 `Eidos`만 인식될 가능성이 있음
- 현재 판단:
  - 대기 화면은 `startSession()`에서 즉시 표시됨
  - 실제 마이크 준비, AudioContext 시작, Realtime 연결, data channel open은 그 이후 비동기로 완료됨
  - 따라서 화면 표시 시점과 실제 전사 가능 시점 사이에 준비 공백이 존재함
- 나중에 확인·수정할 항목:
  - 화면을 `Realtime transcription session connected` 이후에 대기 상태로 전환하거나, 준비 중 화면을 별도로 표시
  - 첫 발화가 연결 전에 시작되어도 버퍼링/보호할 수 있는지 확인
  - Local VAD 색상·상태명을 `준비 중 / 연결됨 / 음성 감지`로 명확히 분리
- 1차 반영: `realtime-connecting`은 내부 상태로 유지하되 화면은 첫 대기 화면을 계속 표시한다. data channel과 VAD 준비가 모두 끝난 뒤에만 `wake-listen` 화면으로 전환.

### 2026-08-02 — 명령 종료 후 분석 전환이 빠르게 느껴짐

- 상태: 1차 수정 완료 / 현장 검증 필요
- 현재 코드상 기준:
  - Local VAD가 마지막 음성 이후 `750ms` 침묵을 감지하면 `input_audio_buffer.commit` 전송
  - 전사 완료 이벤트 이후 `650ms` 뒤 `/api/analyze` 호출
  - 따라서 최소 약 `1.4초 + 전사 완료 이벤트가 도착하는 시간` 후 분석으로 넘어감
- 현재 판단: 히든코드는 프론트에서 실시간 검출되어 조기 전환시키지 않음. 전사문이 서버에 제출된 뒤 `resolveHardRoute()`가 실행되므로, 빠르게 느껴지는 원인은 VAD 침묵 기준과 전사 완료 후 650ms 대기 정책 쪽임.
- 나중에 확인·수정할 항목:
  - 명령 종료 후 추가 대기 시간을 1.0~1.5초 수준으로 늘릴지 실제 발화 테스트
  - 짧은 침묵을 문장 종료로 오인하지 않는지 확인
  - 연속 발화 중에는 추가 전사 완료가 올 때까지 분석 타이머를 유지하는지 검증
- 1차 반영: 전사 완료 후 분석 debounce를 `650ms`에서 `1100ms`로 변경하고, 추가 partial이 들어오면 타이머를 다시 시작.

### 2026-08-02 — `Thank you` 화면의 자동 초기화 필요

- 상태: 1차 수정 완료 / 현장 검증 필요
- 현재 동작: `Thank you` 화면은 얼굴이 계속 감지되면 무기한 유지됨. 얼굴이 2초 이상 사라져야 첫 화면으로 돌아감.
- 요청: 얼굴이 계속 화면에 있어도 `Thank you`를 몇 초간 보여준 뒤 자동으로 첫 화면으로 복귀
- 나중에 확인·수정할 항목:
  - 자동 복귀 시간을 결정할 것. 초기 제안값은 `5초`
  - 자동 복귀 시 얼굴이 계속 감지 중이어도 새 방문자 세션을 즉시 재시작하지 않도록 presence 재무장 정책 확인
- 1차 반영: `Thank you` 5초 후 idle 복귀. 얼굴이 계속 있는 동안에는 detector를 재무장하지 않아 같은 방문자를 즉시 재시작하지 않음.
