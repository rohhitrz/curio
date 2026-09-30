export interface StoredObject {
  size: number;
  contentType: string | undefined;
}

/** File storage (Cloudflare R2 in production, an in-memory fake in tests). */
export interface StorageProvider {
  /**
   * Signed PUT URL. Content type and length are part of the signature, so the browser
   * must upload exactly the declared file.
   */
  createUploadUrl(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;
  /** Signed GET URL for a private object. */
  createDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  /** Object metadata, or null when the key doesn't exist. */
  head(key: string): Promise<StoredObject | null>;
  /** The object's bytes, or null when the key doesn't exist. */
  download(key: string): Promise<Uint8Array | null>;
  /** Deletes the object; deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
