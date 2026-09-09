/**
 * Browser-side frame extraction for video attachments.
 *
 * A video attached to a native-vision model is sampled into a strip of
 * stills (default ~2 fps, capped at 32) instead of shipping the whole MP4:
 * the upload drops from ~137MB of base64 to a few MB of JPEG, the provider
 * ingests ordinary images through a path that cannot choke on a minutes-
 * long video prefill, and the model still sees the whole clip. The native
 * data URL is only produced when the chip is switched to "native clip" —
 * which needs the original File, kept here per attachment id for the
 * session.
 */

export interface VideoFrame {
  /** JPEG data URL of the sampled still. */
  dataUrl: string;
  /** Seconds into the clip this frame sits at. */
  t: number;
}

export interface FramesResult {
  frames: VideoFrame[];
  /** Source duration in seconds. */
  durationSec: number;
  /** Uniform spacing between frames in seconds. */
  intervalSec: number;
}

/** Target sampling rate before the frame cap. */
const TARGET_FPS = 2;
/** Hard cap — past this, frames spread out to cover the whole clip. */
const MAX_FRAMES = 32;
/** Longest edge of any sampled frame. */
const MAX_DIM = 768;
const JPEG_QUALITY = 0.72;
/** A seek that never fires is a decode problem, not a reason to hang. */
const SEEK_TIMEOUT_MS = 4_000;

/**
 * Original video files, per attachment id, for the lifetime of the page.
 * A reload drops these; the chip's mode toggle simply disappears and old
 * attachments stay in whatever mode they were stored in.
 */
export const nativeVideoFiles = new Map<string, File>();

export async function extractVideoFrames(
  file: Blob,
  onProgress?: (done: number, total: number) => void
): Promise<FramesResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the video's metadata never loaded")),
        10_000
      );
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the browser cannot decode this video"));
      };
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("the clip has no usable duration");
    }

    // Full coverage: past the cap the interval stretches so the last frame
    // still lands at the end of the clip instead of stopping partway.
    const wanted = Math.min(
      MAX_FRAMES,
      Math.max(1, Math.round(duration * TARGET_FPS))
    );
    const intervalSec = duration / wanted;
    const vw = video.videoWidth || MAX_DIM;
    const vh = video.videoHeight || MAX_DIM;
    const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");

    const frames: VideoFrame[] = [];
    for (let i = 0; i < wanted; i += 1) {
      const t = Math.min(duration - 1e-3, i * intervalSec);
      await seekTo(video, t);
      // Give the compositor a beat so the canvas never captures the
      // previous frame's pixels.
      await nextPaint();
      ctx.drawImage(video, 0, 0, w, h);
      frames.push({
        dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
        t,
      });
      onProgress?.(i + 1, wanted);
    }

    return { frames, durationSec: duration, intervalSec };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => done(new Error(`seek to ${t.toFixed(2)}s timed out`)),
      SEEK_TIMEOUT_MS
    );
    const onSeeked = () => done();
    const onError = () => done(new Error("seek failed"));
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
