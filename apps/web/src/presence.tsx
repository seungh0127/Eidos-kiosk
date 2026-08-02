import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

type PresenceProps = {
  mock: boolean;
  enabled: boolean;
  diagnostic: boolean;
  resetToken: number;
  onPresence: (present: boolean) => void;
  onStatus: (status: string) => void;
  onTelemetry: (telemetry: FaceTelemetry) => void;
};

type FaceBox = { x: number; y: number; width: number; height: number };

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

export function PresenceDetector({ mock, enabled, diagnostic, resetToken, onPresence, onStatus, onTelemetry }: PresenceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [faceBox, setFaceBox] = useState<FaceBox | undefined>();
  const onPresenceRef = useRef(onPresence);
  const onStatusRef = useRef(onStatus);
  const onTelemetryRef = useRef(onTelemetry);
  const resetTokenRef = useRef(resetToken);

  useEffect(() => { onPresenceRef.current = onPresence; }, [onPresence]);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  useEffect(() => { onTelemetryRef.current = onTelemetry; }, [onTelemetry]);
  useEffect(() => { resetTokenRef.current = resetToken; }, [resetToken]);

  useEffect(() => {
    if (!mock || !enabled) return;
    onStatusRef.current("Mock presence active");
    onTelemetryRef.current({ camera: "mock", detector: "idle", faceCount: 1, confidence: 1, areaRatio: 1, stableMs: 800, absentMs: 0, active: true, lastFrameAt: new Date().toISOString() });
    const timer = window.setTimeout(() => onPresenceRef.current(true), 600);
    return () => window.clearTimeout(timer);
  }, [enabled, mock, resetToken]);

  useEffect(() => {
    if (mock || !enabled) return;
    let disposed = false;
    let animationFrame = 0;
    let detector: FaceDetector | undefined;
    let lastDetection = 0;
    let stableSince = 0;
    let absentSince = 0;
    let active = false;
    let previousBox: FaceBox | undefined;
    let handledResetToken = resetTokenRef.current;

    const resetTracking = () => {
      active = false;
      stableSince = 0;
      absentSince = 0;
      previousBox = undefined;
    };

    async function start() {
      try {
        onTelemetryRef.current({ camera: "requesting", detector: "loading", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        onStatusRef.current("Camera ready");
        onTelemetryRef.current({ camera: "ready", detector: "loading", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });
        const wasmUrl = import.meta.env.VITE_FACE_WASM_URL ?? "/mediapipe/wasm";
        const modelUrl = import.meta.env.VITE_FACE_MODEL_URL ?? "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
        const vision = await FilesetResolver.forVisionTasks(wasmUrl);
        detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: modelUrl },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.65,
        });
        onStatusRef.current("Face detector ready");
        onTelemetryRef.current({ camera: "ready", detector: "ready", faceCount: 0, confidence: 0, areaRatio: 0, stableMs: 0, absentMs: 0, active: false, lastFrameAt: new Date().toISOString() });

        const tick = (timestamp: number) => {
          if (disposed) return;
          if (handledResetToken !== resetTokenRef.current) {
            handledResetToken = resetTokenRef.current;
            resetTracking();
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
          const tracked = pickFace(boxes, previousBox, frameWidth, frameHeight);
          const frameArea = Math.max(1, frameWidth * frameHeight);
          const qualifies = tracked && area(tracked) / frameArea >= 0.04;
          const stableMs = qualifies && stableSince ? timestamp - stableSince : 0;
          const absentMs = !qualifies && absentSince ? timestamp - absentSince : 0;
          setFaceBox(tracked && qualifies ? {
            x: tracked.x / frameWidth,
            y: tracked.y / frameHeight,
            width: tracked.width / frameWidth,
            height: tracked.height / frameHeight,
          } : undefined);
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
          });
          if (qualifies && tracked) {
            previousBox = tracked;
            absentSince = 0;
            if (!stableSince) stableSince = timestamp;
            if (!active && timestamp - stableSince >= 800) {
              active = true;
              onPresenceRef.current(true);
            }
          } else {
            stableSince = 0;
            if (!absentSince) absentSince = timestamp;
            if (active && timestamp - absentSince >= 2000) {
              active = false;
              previousBox = undefined;
              onPresenceRef.current(false);
            }
          }
        };
        animationFrame = requestAnimationFrame(tick);
      } catch (error) {
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
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [enabled, mock]);

  if (mock) return null;
  return <div className={`camera-feed ${diagnostic ? "camera-feed-visible" : ""}`}>
    <video ref={videoRef} className="camera-preview" muted playsInline aria-label="Live camera diagnostic preview" />
    {diagnostic && faceBox && <div className="face-box" style={{ left: `${faceBox.x * 100}%`, top: `${faceBox.y * 100}%`, width: `${faceBox.width * 100}%`, height: `${faceBox.height * 100}%` }} />}
  </div>;
}
