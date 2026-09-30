export interface VideoInfo {
  title: string | null;
  durationSeconds: number | null;
}

export interface TranscriptSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface Transcript {
  /** Language code of the captions (e.g. `en`), when the vendor reports it. */
  language: string | null;
  /** In playback order. Never empty. */
  segments: TranscriptSegment[];
}

/**
 * Reads a YouTube video's details and captions. Failures are `IngestionError`s, already
 * classified transient or permanent.
 */
export interface TranscriptProvider {
  getVideo(videoId: string): Promise<VideoInfo>;
  getTranscript(videoId: string): Promise<Transcript>;
}
