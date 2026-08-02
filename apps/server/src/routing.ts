import type { MatchedRule } from "@eidos/shared";

export type HardRoute = {
  robotId: number;
  matchedRule: Extract<MatchedRule, "hidden-code" | "environment">;
  reason: string;
};

const normalize = (value: string) => value
  .toLocaleLowerCase("ko-KR")
  .replace(/[“”"'`.,!?()[\]{}:;<>/\\]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const hiddenRules: Array<{ robotId: number; signals: string[]; reason: string }> = [
  { robotId: 1, signals: ["집 안", "가벼운 물건", "가져다"], reason: "hidden code for indoor light errands" },
  { robotId: 2, signals: ["아이", "반려동물", "안전하게 놀"], reason: "hidden code for child or pet companionship" },
  { robotId: 3, signals: ["사람이 많은 곳", "서빙", "물품 전달"], reason: "hidden code for service delivery" },
  { robotId: 4, signals: ["이삿짐", "무거운 짐", "빠르게 옮"], reason: "hidden code for heavy transport" },
  { robotId: 5, signals: ["무거운 장비", "흔들리지 않게", "잡아"], reason: "hidden code for heavy stabilization" },
  { robotId: 6, signals: ["달리는 동안", "페이스", "짐을 들어"], reason: "hidden code for running companionship" },
  { robotId: 7, signals: ["낮은 곳", "함께 놀", "로봇 강아지"], reason: "hidden code for quadruped companionship" },
  { robotId: 8, signals: ["무거운 카트", "끌고", "균형"], reason: "hidden code for towing" },
  { robotId: 9, signals: ["집과 마당", "가벼운 심부름", "네발"], reason: "hidden code for indoor-outdoor errands" },
  { robotId: 10, signals: ["정보를 보여", "여러 물건", "나눠"], reason: "hidden code for display and distribution" },
  { robotId: 11, signals: ["여러 손", "요리와 정리", "동시에"], reason: "hidden code for parallel household work" },
  { robotId: 12, signals: ["눈길", "장비와 보급품", "운반"], reason: "hidden code for snow transport" },
  { robotId: 13, signals: ["바닥", "적재대", "올릴 힘"], reason: "hidden code for direct loading" },
  { robotId: 14, signals: ["물이 많은 곳", "점검", "씻어"], reason: "hidden code for wet-environment work" },
  { robotId: 15, signals: ["높은 곳", "케이블", "카메라 장비"], reason: "hidden code for elevated installation" },
  { robotId: 16, signals: ["강하게 고정", "정밀 조립", "여러 손"], reason: "hidden code for precision tool work" },
  { robotId: 17, signals: ["자잘한 물건", "잔뜩", "이동식 보관함"], reason: "hidden code for bulk light-item storage" },
  { robotId: 18, signals: ["공간 전체", "스캔", "변화까지 기록"], reason: "hidden code for spatial scanning" },
];

const environmentRules = {
  scan: ["스캔", "scan", "3d 지도", "3d map", "공간 매핑", "spatial mapping", "동선 분석", "동선을 분석", "디지털 트윈", "공간 기록"],
  water: ["물청소", "세척", "수영장", "침수", "습윤", "물 사출", "배수구", "물 청소", "wash", "wet area"],
  snow: ["눈", "스키장", "설원", "스노우", "겨울 야외", "눈길", "snow", "ski resort", "snowfield"],
};

function containsAny(text: string, terms: string[]): string | undefined {
  return terms.find((term) => text.includes(normalize(term)));
}

export function resolveHardRoute(input: string): HardRoute | undefined {
  const text = normalize(input);

  for (const rule of hiddenRules) {
    if (rule.signals.every((signal) => text.includes(normalize(signal)))) {
      return { robotId: rule.robotId, matchedRule: "hidden-code", reason: rule.reason };
    }
  }

  const scanTerm = containsAny(text, environmentRules.scan);
  if (scanTerm) return { robotId: 18, matchedRule: "environment", reason: `scan environment keyword: ${scanTerm}` };
  const waterTerm = containsAny(text, environmentRules.water);
  if (waterTerm) return { robotId: 14, matchedRule: "environment", reason: `water environment keyword: ${waterTerm}` };
  const snowTerm = containsAny(text, environmentRules.snow);
  if (snowTerm) return { robotId: 12, matchedRule: "environment", reason: `snow environment keyword: ${snowTerm}` };

  return undefined;
}

export function chooseFallback(random = Math.random): 1 | 2 {
  return random() < 0.5 ? 1 : 2;
}

export function normalizeTranscript(input: string): string {
  return normalize(input);
}

const hasAny = (text: string, terms: string[]) => terms.some((term) => text.includes(normalize(term)));

export type MockSemanticRoute = {
  robotId: number;
  matchedRule: Extract<MatchedRule, "group-a" | "group-b" | "group-c" | "group-d" | "group-e" | "group-f" | "group-g">;
};

/**
 * A deterministic approximation used only by Mock mode and routing fixtures.
 * Live semantic decisions remain the single Luna Structured Output call.
 */
export function resolveMockSemanticRoute(input: string): MockSemanticRoute | undefined {
  const text = normalize(input);

  if (hasAny(text, ["집", "집 안", "집안", "가져다", "심부름", "물건을 들고"]) && !hasAny(text, ["무거운", "중량", "큰 짐", "화물", "카트", "이삿짐"])) {
    if (hasAny(text, ["여러 가지", "잔뜩", "한번에", "종류별", "많이"])) return { robotId: 17, matchedRule: "group-a" };
    if (hasAny(text, ["마당", "텃밭", "테라스", "현관 밖", "캠핑", "피크닉", "잔디", "문턱"])) return { robotId: 9, matchedRule: "group-a" };
    return { robotId: 1, matchedRule: "group-a" };
  }

  if (hasAny(text, ["아이", "어린이", "반려동물", "강아지", "고양이", "놀아", "장난감", "교감", "친구", "산책", "낮은 곳", "순찰", "배변 봉투", "따라다니"])) {
    if (hasAny(text, ["아이", "산책", "따라다니", "낮은 곳", "가구 아래", "배변 봉투", "순찰"])) return { robotId: 7, matchedRule: "group-b" };
    return { robotId: 2, matchedRule: "group-b" };
  }

  if (hasAny(text, ["행사", "호텔", "전시장", "식당", "사람들", "여러 사람", "고객", "서빙", "물품 전달", "굿즈", "대기 번호"])) {
    if (hasAny(text, ["안내", "화면", "정보", "대기 번호", "여러 명", "동시에", "디스플레이", "나눠"])) return { robotId: 10, matchedRule: "group-c" };
    if (hasAny(text, ["서빙", "운반", "전달", "물품 이동"])) return { robotId: 3, matchedRule: "group-c" };
    return { robotId: 10, matchedRule: "group-c" };
  }

  if (hasAny(text, ["무거운", "중량", "큰 짐", "화물", "카트", "장비를 옮", "이삿짐", "바닥에서", "적재대", "로딩", "언로딩", "화물차에서"])) {
    if (hasAny(text, ["끌어", "견인", "카트 연결", "와이어", "뒤에 달아"])) return { robotId: 8, matchedRule: "group-d" };
    if (hasAny(text, ["바닥에서 들어", "적재대", "카트 위", "로딩", "언로딩", "화물차에서 내려"])) return { robotId: 13, matchedRule: "group-d" };
    if (hasAny(text, ["옮겨", "이동", "운반", "가져다"])) return { robotId: 4, matchedRule: "group-d" };
    if (hasAny(text, ["고정", "잡아", "버텨", "흔들리지", "지지", "유지"])) return { robotId: 5, matchedRule: "group-d" };
    return { robotId: 4, matchedRule: "group-d" };
  }

  if (hasAny(text, ["높은 곳", "천장", "상부 프레임", "케이블", "리깅", "카메라 설치", "긴 팔"])) return { robotId: 15, matchedRule: "group-e" };
  if (hasAny(text, ["나사", "드릴", "공구", "체결", "조립", "분해", "커넥터", "수리", "유지보수"])) return { robotId: 16, matchedRule: "group-e" };
  if (hasAny(text, ["설치", "고정", "지지", "정밀 작업"])) return { robotId: 5, matchedRule: "group-e" };

  if (hasAny(text, ["요리", "조리", "베이킹", "재료 준비", "정리", "분류", "포장", "동시에 여러 가지", "여러 팔"])) return { robotId: 11, matchedRule: "group-f" };

  if (hasAny(text, ["달리", "러닝", "조깅", "페이스", "함께 뛰"])) return { robotId: 6, matchedRule: "group-g" };
  if (hasAny(text, ["캠핑", "피크닉", "등산 입구", "공원", "마당", "야외", "따라와"])) return { robotId: 9, matchedRule: "group-g" };

  return undefined;
}
