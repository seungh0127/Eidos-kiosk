import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

type PresenceProps = {
  mock: boolean;
  enabled: boolean;
  diagnostic: boolean;
  resetToken: number;
  cameraDeviceId: string;
  handDetectionEnabled: boolean;
  handWaveEnabled: boolean;
  fistCaptureEnabled: boolean;
  onPresence: (present: boolean) => void;
  onHandWave: () => void;
  onFist: () => void;
  onStatus: (status: string) => void;
  onTelemetry: (telemetry: FaceTelemetry) => void;
  onDevices: (devices: CameraDevice[]) => void;
  onStream?: (stream: MediaStream | null) => void;
  /** Overrides MIN_FACE_AREA_RATIO — pass a lower value while the visitor is
   *  expected to stand farther from the camera (e.g. posing for a photo). */
  minFaceAreaRatio?: number;
  /** Overrides how long the face can stop qualifying before presence flips
   *  to absent — raised during the photo stage so stepping back to frame a
   *  shot doesn't reset the visitor back to the idle screen. */
  presenceAbsentMs?: number;
};

export type CameraDevice = { deviceId: string; label: string };

type FaceBox = { x: number; y: number; width: number; height: number };
type HandPoint = { x: number; y: number; z?: number };

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
] as const;

const MIN_FACE_AREA_RATIO = 0.02;
// Presence can stop qualifying for up to this long before flipping to
// "absent" (default, outside the photo stage — see presenceAbsentMs prop).
const DEFAULT_PRESENCE_ABSENT_MS = 2000;
// Two independent ways to trigger, whichever happens first: a quick side-
// to-side wave (matches what visitors actually do — natural, fast), or just
// holding an open palm up for a few seconds (a fallback for someone who
// raises a hand without moving it, or when motion blur makes the wave's
// landmark tracking too noisy). Neither alone was reliable enough on its
// own at real kiosk distances, so both run together now.
const HAND_HOLD_MS = 5000;
// Small tolerance so one noisy "not open" frame doesn't restart the whole
// hold — only a gap longer than this counts as the hand actually leaving.
const HAND_HOLD_GRACE_MS = 500;
// Wave-motion thresholds — loosened from the original close-up-tuned
// values, since a hand farther from the camera covers less normalized
// frame-width for the same real arm motion.
const WAVE_WINDOW_MS = 2200;
const WAVE_MIN_SAMPLES = 5;
const WAVE_DIRECTION_DELTA = 0.01;
const WAVE_MIN_DIRECTION_CHANGES = 1;
const WAVE_MIN_SPAN = 0.11;
const WAVE_MIN_TRAVELLED = 0.2;
// Photo gesture is a quick close -> release sequence rather than a long
// closed fist hold. "Release" is just the fist no longer being classified as
// Closed_Fist — not a fully open hand (see the fistArmed branch below for
// why). The detector runs at roughly 10fps, so the close arm and release
// confirmation are intentionally short but still require more than one
// accidental classification to proceed.
const FIST_ARM_MS = 180;
const FIST_OPEN_CONFIRM_MS = 100;
const FIST_SEQUENCE_WINDOW_MS = 1500;
const FIST_MIN_CONFIDENCE = 0.65;

export type FaceTelemetry = {
  camera: "disabled" | "requesting" | "ready" | "error" | "mock";
  detector: "idle" | "loading" | "ready" | "error";
  faceCount: number;
  confidence: number;
  areaRatio: number;
  stableMs: number;
  absentMs: number;
  active: boolean;
  box?: FaceBox;
  lastFrameAt: string;
  /** Live open-hand diagnostics, present only while a hand landmarker is
   *  running and handWaveEnabled — lets the real kiosk camera's actual
   *  numbers be read against the wave/hold thresholds below instead of
   *  guessing why a hand wasn't recognized. The open-hand wave/hold trigger
   *  fires onHandWave; the separate fist-to-open trigger fires onFist. */
  hand?: {
    open: boolean;
    palmWidth: number;
    /** How long the hand has been continuously open, toward HAND_HOLD_MS. */
    heldMs: number;
    /** Side-to-side span covered within the wave sample window. */
    span: number;
    travelled: number;
    directionChanges: number;
    gesture?: string;
    gestureScore?: number;
    /** Time the recognizer has continuously seen a qualifying closed fist. */
    fistHeldMs?: number;
    /** A qualifying fist has been armed and is waiting for an open hand. */
    fistArmed?: boolean;
  };
};

function area(box: FaceBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionOverUnion(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return overlap / Math.max(1, area(a) + area(b) - overlap);
}

function centerDistance(box: FaceBox, frameWidth: number, frameHeight: number): number {
  const boxCenterX = box.x + box.width / 2;
  const boxCenterY = box.y + box.height / 2;
  const frameCenterX = frameWidth / 2;
  const frameCenterY = frameHeight / 2;
  return Math.hypot(boxCenterX - frameCenterX, boxCenterY - frameCenterY) / Math.max(1, Math.hypot(frameCenterX, frameCenterY));
}

function pickFace(boxes: FaceBox[], previous: FaceBox | undefined, frameWidth: number, frameHeight: number): FaceBox | undefined {
  if (!boxes.length) return undefined;
  const tracked = previous ? boxes.filter((box) => intersectionOverUnion(box, previous) >= 0.15) : [];
  const candidates = tracked.length ? tracked : boxes;
  return candidates.slice().sort((a, b) => {
    const score = (box: FaceBox) => {
      const size = area(box) / Math.max(1, frameWidth * frameHeight);
      const center = 1 - Math.min(1, centerDistance(box, frameWidth, frameHeight));
      const overlap = previous ? intersectionOverUnion(box, previous) : 0;
      return size * 0.55 + center * 0.25 + overlap * 0.2;
    };
    return score(b) - score(a);
  })[0];
}

function pointDistance(a: HandPoint, b: HandPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function vectorCosine(a: HandPoint, b: HandPoint, c: HandPoint): number {
  const first = { x: b.x - a.x, y: b.y - a.y, z: (b.z ?? 0) - (a.z ?? 0) };
  const second = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const firstLength = Math.hypot(first.x, first.y, first.z);
  const secondLength = Math.hypot(second.x, second.y, second.z);
  if (!firstLength || !secondLength) return -1;
  return (first.x * second.x + first.y * second.y + first.z * second.z) / (firstLength * secondLength);
}

/**
 * Detect an open palm rather than merely detecting any hand movement.
 * The fingertip/PIP distance and the joint alignment checks keep curled
 * fingers from being accepted as a five-finger wave.
 */
function hasFiveOpenFingers(landmarks: HandPoint[]): boolean {
  if (landmarks.length < 21) return false;
  const wrist = landmarks[0];
  const palmWidth = pointDistance(landmarks[5], landmarks[17]);
  // At a real kiosk's camera-to-visitor distance the hand occupies a much
  // smaller share of the frame than in close-up testing, so this used to
  // reject genuinely open hands outright. Lowered from .02 — still enough
  // to ignore a hand that's essentially not resolvable in the frame.
  if (palmWidth < 0.012) return false;

  const fingerTriples = [
    [5, 6, 8], // index
    [9, 10, 12], // middle
    [13, 14, 16], // ring
    [17, 18, 20], // pinky
  ] as const;
  const fingersOpen = fingerTriples.every(([mcp, pip, tip]) => {
    const tipDistance = pointDistance(wrist, landmarks[tip]);
    const pipDistance = pointDistance(wrist, landmarks[pip]);
    const segmentLength = pointDistance(landmarks[pip], landmarks[tip]);
    // Ratios are nominally distance-invariant, but a smaller/farther hand
    // gives MediaPipe fewer pixels per landmark, so its normalized jitter
    // eats a bigger share of these margins — loosened accordingly.
    return tipDistance > pipDistance * 1.0
      && segmentLength > palmWidth * 0.18
      && vectorCosine(landmarks[mcp], landmarks[pip], landmarks[tip]) > 0.05;
  });

  // The thumb bends in a different plane, so use its lateral extension and
  // joint alignment instead of comparing y coordinates.
  const thumbOpen = pointDistance(landmarks[4], landmarks[2]) > palmWidth * 0.5
    && pointDistance(wrist, landmarks[4]) > pointDistance(wrist, landmarks[3]) * 1.0
    && vectorCosine(landmarks[2], landmarks[3], landmarks[4]) > 0;
  return fingersOpen && thumbOpen;
}

function handPalmCenter(landmarks: HandPoint[]): number {
  // Wrist + the four MCP joints are more stable than averaging fingertips,
  // which can swing independently while the palm moves side to side.
  return (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 5;
}

export function PresenceDetector({ mock, enabled, diagnostic, resetToken, cameraDeviceId, handDetectionEnabled, handWaveEnabled, fistCaptureEnabled, onPresence, onHandWave, onFist, onStatus, onTelemetry, onDevices, onStream, minFaceAreaRatio, presenceAbsentMs }: PresenceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [faceBox, setFaceBox] = useState<FaceBox | undefined>();
  const [handLandmarks, setHandLandmarks] = useState<HandPoint[] | undefined>();
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const onPresenceRef = useRef(onPresence);
  const onHandWaveRef = useRef(onHandWave);
  const onFistRef = useRef(onFist);
  const handWaveEnabledRef = useRef(handWaveEnabled);
  const fistCaptureEnabledRef = useRef(fistCaptureEnabled);
  const onStatusRef = useRef(onStatus);
  const onTelemetryRef = useRef(onTelemetry);
  const onDevicesRef = useRef(onDevices);
  const onStreamRef = useRef(onStream);
  const resetTokenRef = useRef(resetToken);
  const cameraReadyRef = useRef(false);
  const minFaceAreaRatioRef = useRef(minFaceAreaRatio);
  const presenceAbsentMsRef = useRef(presenceAbsentMs);

  useEffect(() => { onPresenceRef.current = onPresence; }, [onPresence]);
  useEffect(() => { onHandWaveRef.current = onHandWave; }, [onHandWave]);
  useEffect(() => { onFistRef.current = onFist; }, [onFist]);
  useEffect(() => { handWaveEnabledRef.current = handWaveEnabled; }, [handWaveEnabled]);
  useEffect(() => { fistCaptureEnabledRef.current = fistCaptureEnabled; }, [fistCaptureEnabled]);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  useEffect(() => { onTelemetryRef.current = onTelemetry; }, [onTelemetry]);
  useEffect(() => { onDevicesRef.current = onDevices; }, [onDevices]);
  useEffect(() => { onStreamRef.current = onStream; }, [onStream]);
  useEffect(() => { resetTokenRef.current = resetToken; }, [resetToken]);
  useEffect(() => { minFaceAreaRatioRef.current = minFaceAreaRatio; }, [minFaceAreaRatio]);
  useEffect(() => { presenceAbsentMsRef.current = presenceAbsentMs; }, [presenceAbsentMs]);

  useEffect(() => {
    if (!mock || !enabled) return;
    cameraReadyRef.current = false;
    onStatusRef.current("Mock mode: requesting real camera · allow access to test hand detection");
    onTelemetryRef.current({ camera: "requesting", detector: "loading", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
    // The real camera (see the effect below) is always requested in mock
    // mode too, specifically so hand-wave/photo testing works against a
    // real webcam without needing the live API. This fallback only exists
    // for when there's genuinely no camera/permission — it used to fire
    // after 1.5s, which is far too soon for a human to notice and click an
    // actual "Allow camera" browser prompt, so it was masking a real camera
    // that would have connected a couple of seconds later with a fake one.
    const timer = window.setTimeout(() => {
      if (cameraReadyRef.current) return;
      onStatusRef.current("Mock camera unavailable · simulated presence active");
      onTelemetryRef.current({ camera: "mock", detector: "idle", faceCount: 1, confidence: 1, areaRatio: 1, stableMs: 500, absentMs: 0, active: true, lastFrameAt: new Date().toISOString() });
      onPresenceRef.current(true);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [enabled, mock, resetToken]);

  useEffect(() => {
    if (!enabled) return;
    setHandLandmarks(undefined);
    setFrameSize({ width: 1, height: 1 });
    let disposed = false;
    let animationFrame = 0;
    let detector: FaceDetector | undefined;
    let gestureRecognizer: GestureRecognizer | undefined;
    let lastDetection = 0;
    let lastHandDetection = 0;
    let stableSince = 0;
    let absentSince = 0;
    let active = false;
    let previousBox: FaceBox | undefined;
    let handledResetToken = resetTokenRef.current;
    let handWaveCooldownUntil = 0;
    let handReadyReported = false;
    // Dwell-time hold tracking.
    let openHandSince = 0;
    let lastOpenSeenAt = 0;
    // Wave-motion tracking, running in parallel with the hold above.
    let smoothedHandX: number | undefined;
    const handHistory: Array<{ x: number; at: number }> = [];
    let fistSince = 0;
    let fistOpenSince = 0;
    let fistArmed = false;
    let fistAwaitingRelease = false;
    let fistCooldownUntil = 0;

    const resetFistTracking = () => {
      fistSince = 0;
      fistOpenSince = 0;
      fistArmed = false;
      fistAwaitingRelease = false;
    };

    const resetTracking = () => {
      active = false;
      stableSince = 0;
      absentSince = 0;
      previousBox = undefined;
    };

    async function start() {
      try {
        onTelemetryRef.current({ camera: "requesting", detector: "loading", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
          audio: false,
        });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        onStreamRef.current?.(stream);
        cameraReadyRef.current = true;
        try {
          const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === "videoinput")
            .map((device) => ({ deviceId: device.deviceId, label: device.label || "Camera" }));
          onDevicesRef.current(devices);
        } catch {
          // Device enumeration is optional; the active stream can still run.
        }
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        onStatusRef.current(`Camera ready · ${stream.getVideoTracks()[0]?.label || "selected device"}`);
        onTelemetryRef.current({ camera: "ready", detector: "loading", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
        const wasmUrl = import.meta.env.VITE_FACE_WASM_URL ?? "/mediapipe/wasm";
        const modelUrl = import.meta.env.VITE_FACE_MODEL_URL ?? "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
        const vision = await FilesetResolver.forVisionTasks(wasmUrl);
        detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: modelUrl },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.65,
        });
        if (handDetectionEnabled) {
          try {
            gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
              baseOptions: {
                modelAssetPath: import.meta.env.VITE_GESTURE_MODEL_URL ?? "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
              },
              runningMode: "VIDEO",
              numHands: 1,
              minHandDetectionConfidence: 0.55,
              minHandPresenceConfidence: 0.55,
              minTrackingConfidence: 0.55,
            });
          } catch {
            onStatusRef.current("Hand detector unavailable · use mock wave control");
          }
        }
        onStatusRef.current(gestureRecognizer ? "Face detector ready · hand gestures enabled" : "Face detector ready");
        onTelemetryRef.current({ camera: "ready", detector: "ready", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });

        const tick = (timestamp: number) => {
          if (disposed) return;
          if (handledResetToken !== resetTokenRef.current) {
            handledResetToken = resetTokenRef.current;
            resetTracking();
            resetFistTracking();
          }
          animationFrame = requestAnimationFrame(tick);
          if (!detector || !videoRef.current || timestamp - lastDetection < 100 || videoRef.current.readyState < 2) return;
          lastDetection = timestamp;
          const result = detector.detectForVideo(videoRef.current, timestamp);
          const boxes = result.detections
            .filter((detection) => (detection.categories[0]?.score ?? 0) >= 0.65)
            .map((detection) => detection.boundingBox)
            .filter((box): box is NonNullable<typeof box> => Boolean(box))
            .map((box) => ({ x: box.originX, y: box.originY, width: box.width, height: box.height }));
          const confidence = result.detections.reduce((highest, detection) => Math.max(highest, detection.categories[0]?.score ?? 0), 0);
          const frameWidth = videoRef.current.videoWidth;
          const frameHeight = videoRef.current.videoHeight;
          if (frameWidth > 0 && frameHeight > 0) {
            setFrameSize((previous) => previous.width === frameWidth && previous.height === frameHeight ? previous : { width: frameWidth, height: frameHeight });
          }
          const tracked = pickFace(boxes, previousBox, frameWidth, frameHeight);
          const frameArea = Math.max(1, frameWidth * frameHeight);
          const qualifies = tracked && area(tracked) / frameArea >= (minFaceAreaRatioRef.current ?? MIN_FACE_AREA_RATIO);
          const stableMs = qualifies && stableSince ? timestamp - stableSince : 0;
          const absentMs = !qualifies && absentSince ? timestamp - absentSince : 0;
          setFaceBox(tracked && qualifies ? {
            x: tracked.x / frameWidth,
            y: tracked.y / frameHeight,
            width: tracked.width / frameWidth,
            height: tracked.height / frameHeight,
          } : undefined);

          // Wave-metrics diagnostics: computed whenever a hand is tracked,
          // regardless of whether it's yet long enough to trigger, so the
          // operator panel can show the *actual* numbers a real kiosk
          // camera is producing against the thresholds below.
          let handDiag: NonNullable<FaceTelemetry["hand"]> | undefined;

          if (gestureRecognizer && timestamp - lastHandDetection >= 100) {
            lastHandDetection = timestamp;
            const handResult = gestureRecognizer.recognizeForVideo(videoRef.current, timestamp);
            const candidates = handResult.landmarks
              .filter((landmarks) => landmarks.length >= 21)
              .map((landmarks) => {
                const points = landmarks as HandPoint[];
                const index = handResult.landmarks.indexOf(landmarks);
                const category = handResult.gestures[index]?.[0];
                return { landmarks: points, open: hasFiveOpenFingers(points), gesture: category?.categoryName ?? "None", gestureScore: category?.score ?? 0 };
              })
              .sort((a, b) => Math.max(Number(b.open), b.gesture === "Closed_Fist" ? b.gestureScore : 0) - Math.max(Number(a.open), a.gesture === "Closed_Fist" ? a.gestureScore : 0));
            const candidate = candidates[0];
            setHandLandmarks(candidate?.landmarks);

            const fistCaptureEnabled = fistCaptureEnabledRef.current;
            if (!fistCaptureEnabled) resetFistTracking();
            const closedFist = fistCaptureEnabled && candidate?.gesture === "Closed_Fist" && candidate.gestureScore >= FIST_MIN_CONFIDENCE;
            const fistHeldMs = closedFist && fistSince ? timestamp - fistSince : 0;
            const fistSequenceMs = fistSince ? timestamp - fistSince : 0;
            if (candidate && fistCaptureEnabled && !handWaveEnabledRef.current) {
              handDiag = {
                open: Boolean(candidate.open),
                palmWidth: pointDistance(candidate.landmarks[5], candidate.landmarks[17]),
                heldMs: 0,
                span: 0,
                travelled: 0,
                directionChanges: 0,
                gesture: candidate.gesture,
                gestureScore: candidate.gestureScore,
                fistHeldMs,
                fistArmed,
              };
            }
            if (closedFist) {
              if (fistAwaitingRelease) {
                // A fist that timed out must be released before another
                // close -> open sequence can begin.
              } else {
                if (!fistSince) {
                  fistSince = timestamp;
                  fistOpenSince = 0;
                  fistArmed = false;
                  onStatusRef.current("Closed fist detected · open hand to capture");
                }
                fistOpenSince = 0;
                if (!fistArmed && timestamp - fistSince >= FIST_ARM_MS) {
                  fistArmed = true;
                  onStatusRef.current("Closed fist armed · release to capture");
                }
              }
            } else if (fistAwaitingRelease) {
              // The timed-out fist has now been released; the next fist can
              // start a fresh gesture sequence.
              resetFistTracking();
            } else if (fistArmed && fistSequenceMs <= FIST_SEQUENCE_WINDOW_MS) {
              // Any release of the fist counts, not specifically a fully open
              // hand (hasFiveOpenFingers requires every finger to pass its
              // own straightness/angle check). Requiring that at the exact
              // instant of a fast unclench snap was the main source of missed
              // triggers — mid-motion fingers rarely land cleanly on that
              // check within a single ~100ms-sampled frame, so visitors had
              // to repeat the gesture, which read as "doesn't recognize it /
              // there's a delay."
              if (!fistOpenSince) {
                fistOpenSince = timestamp;
                onStatusRef.current("Fist release detected · confirming capture");
              }
              if (timestamp - fistOpenSince >= FIST_OPEN_CONFIRM_MS && timestamp >= fistCooldownUntil) {
                fistCooldownUntil = timestamp + 3500;
                resetFistTracking();
                onStatusRef.current("Fist → open hand confirmed · taking photo");
                onFistRef.current();
              }
            } else if (fistSince && fistSequenceMs > FIST_SEQUENCE_WINDOW_MS) {
              fistSince = 0;
              fistOpenSince = 0;
              fistArmed = false;
              fistAwaitingRelease = true;
              if (fistCaptureEnabled) onStatusRef.current("Fist gesture timed out · try close then open again");
            }

            if (!handWaveEnabledRef.current) {
              openHandSince = 0;
              handReadyReported = false;
              handHistory.length = 0;
              smoothedHandX = undefined;
            } else if (candidate?.open) {
              if (!handReadyReported) {
                handReadyReported = true;
                onStatusRef.current("Open hand detected · wave, or hold still a moment");
              }
              // Hold path.
              if (!openHandSince) openHandSince = timestamp;
              lastOpenSeenAt = timestamp;
              const heldMs = timestamp - openHandSince;

              // Wave path, tracked in parallel.
              const rawHandX = handPalmCenter(candidate.landmarks);
              smoothedHandX = smoothedHandX === undefined ? rawHandX : smoothedHandX * 0.58 + rawHandX * 0.42;
              handHistory.push({ x: smoothedHandX, at: timestamp });
              while (handHistory.length && timestamp - handHistory[0].at > WAVE_WINDOW_MS) handHistory.shift();
              let directionChanges = 0;
              let previousDirection = 0;
              let spanMin = handHistory[0].x;
              let spanMax = handHistory[0].x;
              let travelled = 0;
              for (let index = 1; index < handHistory.length; index += 1) {
                const delta = handHistory[index].x - handHistory[index - 1].x;
                spanMin = Math.min(spanMin, handHistory[index].x);
                spanMax = Math.max(spanMax, handHistory[index].x);
                travelled += Math.abs(delta);
                const direction = Math.abs(delta) >= WAVE_DIRECTION_DELTA ? Math.sign(delta) : 0;
                if (direction && previousDirection && direction !== previousDirection) directionChanges += 1;
                if (direction) previousDirection = direction;
              }
              const span = spanMax - spanMin;
              handDiag = { open: true, palmWidth: pointDistance(candidate.landmarks[5], candidate.landmarks[17]), heldMs, span, travelled, directionChanges, gesture: candidate.gesture, gestureScore: candidate.gestureScore, fistHeldMs, fistArmed };

              const waveTriggered = handHistory.length >= WAVE_MIN_SAMPLES
                && directionChanges >= WAVE_MIN_DIRECTION_CHANGES && span >= WAVE_MIN_SPAN && travelled >= WAVE_MIN_TRAVELLED;
              const holdTriggered = heldMs >= HAND_HOLD_MS;
              if (timestamp >= handWaveCooldownUntil && (waveTriggered || holdTriggered)) {
                handWaveCooldownUntil = timestamp + 3500;
                openHandSince = 0;
                handReadyReported = false;
                handHistory.length = 0;
                smoothedHandX = undefined;
                onStatusRef.current(waveTriggered ? "Open hand wave detected" : "Open hand held · continuing");
                onHandWaveRef.current();
              }
            } else {
              // A single noisy "not open" frame shouldn't restart the whole
              // hold — only actually reset once the gap outlasts the grace
              // window, so brief MediaPipe misclassification doesn't punish
              // someone who has genuinely been holding their hand up.
              if (openHandSince && timestamp - lastOpenSeenAt > HAND_HOLD_GRACE_MS) {
                openHandSince = 0;
                handReadyReported = false;
              }
              smoothedHandX = undefined;
              if (handHistory.length) handHistory.splice(0, Math.max(0, handHistory.length - 3));
              handDiag = candidate
                ? { open: false, palmWidth: pointDistance(candidate.landmarks[5], candidate.landmarks[17]), heldMs: openHandSince ? timestamp - openHandSince : 0, span: 0, travelled: 0, directionChanges: 0, gesture: candidate.gesture, gestureScore: candidate.gestureScore, fistHeldMs: fistSince ? timestamp - fistSince : 0, fistArmed }
                : undefined;
            }
          } else if (!gestureRecognizer) {
            setHandLandmarks(undefined);
          }

          onTelemetryRef.current({
            camera: "ready",
            detector: "ready",
            faceCount: boxes.length,
            confidence,
            areaRatio: tracked ? area(tracked) / frameArea : 0,
            stableMs,
            absentMs,
            active,
            box: tracked && qualifies ? {
              x: tracked.x / frameWidth,
              y: tracked.y / frameHeight,
              width: tracked.width / frameWidth,
              height: tracked.height / frameHeight,
            } : undefined,
            lastFrameAt: new Date().toISOString(),
            hand: handDiag,
          });

          if (!handWaveEnabledRef.current) {
            openHandSince = 0;
            handHistory.length = 0;
            smoothedHandX = undefined;
          }
          if (qualifies && tracked) {
            previousBox = tracked;
            absentSince = 0;
            if (!stableSince) stableSince = timestamp;
            if (!active && timestamp - stableSince >= 500) {
              active = true;
              onPresenceRef.current(true);
            }
          } else {
            stableSince = 0;
            if (!absentSince) absentSince = timestamp;
            if (active && timestamp - absentSince >= (presenceAbsentMsRef.current ?? DEFAULT_PRESENCE_ABSENT_MS)) {
              active = false;
              previousBox = undefined;
              onPresenceRef.current(false);
            }
          }
        };
        animationFrame = requestAnimationFrame(tick);
      } catch (error) {
        cameraReadyRef.current = false;
        onStatusRef.current(error instanceof Error ? error.message : "Camera setup failed");
        onTelemetryRef.current({ camera: "error", detector: "error", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
        onPresenceRef.current(false);
      }
    }

    void start();
    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      detector?.close();
      gestureRecognizer?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      onStreamRef.current?.(null);
      cameraReadyRef.current = false;
      setHandLandmarks(undefined);
    };
  }, [cameraDeviceId, enabled, handDetectionEnabled, mock]);

  return <div className={`camera-feed ${diagnostic ? "camera-feed-visible" : ""}`}>
    <video ref={videoRef} className="camera-preview" muted playsInline aria-label="Live camera diagnostic preview" />
    {diagnostic && faceBox && <div className="face-box" style={{ left: `${faceBox.x * 100}%`, top: `${faceBox.y * 100}%`, width: `${faceBox.width * 100}%`, height: `${faceBox.height * 100}%` }} />}
    {diagnostic && handLandmarks && <svg className="hand-landmarks" viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {HAND_CONNECTIONS.map(([from, to]) => <line key={`${from}-${to}`} x1={handLandmarks[from].x * frameSize.width} y1={handLandmarks[from].y * frameSize.height} x2={handLandmarks[to].x * frameSize.width} y2={handLandmarks[to].y * frameSize.height} />)}
      {handLandmarks.map((point, index) => <circle key={index} cx={point.x * frameSize.width} cy={point.y * frameSize.height} r={Math.max(frameSize.width, frameSize.height) * .008} />)}
    </svg>}
  </div>;
}
