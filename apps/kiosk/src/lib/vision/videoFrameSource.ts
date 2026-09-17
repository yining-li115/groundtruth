/** One newly decoded camera frame. Times are monotonic milliseconds. */
export interface DecodedFrameStamp {
  /**
   * Local to this video-loop instance; increments exactly once per decoded frame. HandPointer
   * normalises it to a lifetime-monotonic id before exposing it to interaction consumers.
   */
  seq: number;
  /** When the browser delivered the frame callback, on the performance clock. */
  receivedAtMs: number;
  /** When inference finished and the result became actionable. Added by the vision caller. */
  processedAtMs?: number;
  /** End-to-end synchronous model time for this frame. Added by the vision caller. */
  inferenceMs?: number;
  /** The frame's position on the media timeline. Useful for proving duplicate suppression. */
  mediaTimeMs: number;
  /** Browser compositor counter, where requestVideoFrameCallback exposes it. */
  presentedFrames?: number;
}

export type VideoFrameStaleReason = "video-stale" | "track-ended" | "page-hidden";

export interface VideoFrameStaleEvent {
  reason: VideoFrameStaleReason;
  atMs: number;
  ageMs: number;
  hadFrame: boolean;
}

export interface DecodedFrameLoopOptions {
  onFrame: (stamp: DecodedFrameStamp) => void;
  onStale: (event: VideoFrameStaleEvent) => void;
  /** Source-health timeout. Control has a tighter, independent freshness deadline. */
  staleAfterMs?: number;
  watchdogMs?: number;
}

export const DEFAULT_VIDEO_STALE_MS = 300;

/**
 * Run work once per NEW decoded video frame, not once per display refresh.
 *
 * `requestAnimationFrame` replays a 30fps webcam frame four or five times on a 120/144Hz
 * monitor. That wastes inference, changes frame-count gesture gates and feeds zero-dt duplicate
 * samples into velocity filters. `requestVideoFrameCallback` is the correct clock; the fallback
 * deduplicates `currentTime` for older browsers. A separate watchdog is essential because a
 * frozen video produces no callback in which the pointer could discover that it is stale.
 */
export function startDecodedFrameLoop(
  video: HTMLVideoElement,
  options: DecodedFrameLoopOptions,
): () => void {
  const staleAfterMs = Math.max(50, options.staleAfterMs ?? DEFAULT_VIDEO_STALE_MS);
  const watchdogMs = Math.max(25, options.watchdogMs ?? Math.min(100, staleAfterMs / 2));
  let stopped = false;
  let seq = 0;
  let callbackId = 0;
  let usingVideoCallback = false;
  let lastFrameAt = performance.now();
  let lastMediaTime = Number.NaN;
  const reportedStaleReasons = new Set<VideoFrameStaleReason>();

  const emit = (receivedAtMs: number, mediaTimeMs: number, presentedFrames?: number) => {
    if (stopped) return;
    seq += 1;
    lastFrameAt = receivedAtMs;
    lastMediaTime = mediaTimeMs;
    reportedStaleReasons.clear();
    try {
      options.onFrame({ seq, receivedAtMs, mediaTimeMs, presentedFrames });
    } finally {
      // The two MediaPipe tasks run synchronously. On a slower laptop they can occupy the main
      // thread longer than the source watchdog threshold; measuring only from callback entry
      // makes the queued watchdog invalidate a result immediately after it completes. Completion
      // is still real source activity, while a genuinely frozen stream receives neither edge.
      lastFrameAt = performance.now();
    }
  };

  const requestNextVideoFrame = () => {
    callbackId = video.requestVideoFrameCallback((now, metadata) => {
      try {
        emit(now, metadata.mediaTime * 1000, metadata.presentedFrames);
      } finally {
        if (!stopped) requestNextVideoFrame();
      }
    });
  };

  const fallbackTick = (now: number) => {
    if (stopped) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      const mediaTimeMs = video.currentTime * 1000;
      // Camera media time is monotonic in normal operation. Accept a backwards discontinuity as
      // a new frame too (track replacement), but never process the exact same time twice.
      if (!Number.isFinite(lastMediaTime) || Math.abs(mediaTimeMs - lastMediaTime) > 0.01) {
        emit(now, mediaTimeMs);
      }
    }
    callbackId = requestAnimationFrame(fallbackTick);
  };

  if (typeof video.requestVideoFrameCallback === "function") {
    usingVideoCallback = true;
    requestNextVideoFrame();
  } else {
    callbackId = requestAnimationFrame(fallbackTick);
  }

  const reportStale = (reason: VideoFrameStaleReason, atMs = performance.now()) => {
    if (stopped || reportedStaleReasons.has(reason)) return;
    reportedStaleReasons.add(reason);
    options.onStale({
      reason,
      atMs,
      ageMs: Math.max(0, atMs - lastFrameAt),
      hadFrame: seq > 0,
    });
  };

  const watchdog = window.setInterval(() => {
    const now = performance.now();
    if (now - lastFrameAt > staleAfterMs) reportStale("video-stale", now);
  }, watchdogMs);

  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
  const track = stream?.getVideoTracks()[0] ?? null;
  const onEnded = () => reportStale("track-ended");
  const onVisibility = () => {
    if (document.visibilityState !== "visible") reportStale("page-hidden");
  };
  track?.addEventListener("ended", onEnded);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    window.clearInterval(watchdog);
    track?.removeEventListener("ended", onEnded);
    document.removeEventListener("visibilitychange", onVisibility);
    if (usingVideoCallback) video.cancelVideoFrameCallback(callbackId);
    else cancelAnimationFrame(callbackId);
  };
}
