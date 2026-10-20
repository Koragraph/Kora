/** Resolves web references without inheriting the desktop renderer's custom app scheme. */

const FETCH_FAILED_MESSAGE =
  "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.";
const HTML_INSTEAD_OF_MEDIA_MESSAGE =
  "This link returned a web page instead of media. Open the original URL.";
const DECODE_FAILED_MESSAGE =
  "The browser could not decode this image for copying. Try saving it instead.";
const BAD_DIMENSIONS_MESSAGE =
  "This image is too large or has no usable dimensions. Try saving it instead.";
const MAX_COPY_PIXELS = 64_000_000;

const mimeEssence = (blob: Blob): string => blob.type.split(";", 1)[0] ?? "";

export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) {
    return src;
  }
  const onPlainHttp = typeof window !== "undefined" && window.location.protocol === "http:";
  return (onPlainHttp ? "http:" : "https:") + src;
}

/** A remote http(s) URL: in the desktop app the window may only fetch loopback, so the main process fetches it. */
function isRemoteHttp(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
  } catch {
    return false;
  }
}

/** Reads media only for an explicit save/copy action; in a browser, remote hosts must allow CORS. */
async function readMediaBlob(src: string): Promise<Blob> {
  const viaShell = typeof window !== "undefined" ? window.shellBridge?.fetchRemoteMedia : undefined;
  if (viaShell && isRemoteHttp(src)) {
    const fetched = await viaShell(src).catch((cause: unknown) => {
      throw new Error(FETCH_FAILED_MESSAGE, { cause });
    });
    if (!fetched.bytes) throw new Error(fetched.error ?? FETCH_FAILED_MESSAGE);
    const media = new Blob([fetched.bytes as Uint8Array<ArrayBuffer>], {
      type: fetched.mime ?? "",
    });
    if (mimeEssence(media) === "text/html") throw new Error(HTML_INSTEAD_OF_MEDIA_MESSAGE);
    return media;
  }
  const response = await fetch(src).catch((cause: unknown) => {
    throw new Error(FETCH_FAILED_MESSAGE, { cause });
  });
  if (!response.ok) {
    throw new Error(`The file could not be fetched (HTTP ${response.status}).`);
  }
  const media = await response.blob();
  if (mimeEssence(media) === "text/html") {
    throw new Error(HTML_INSTEAD_OF_MEDIA_MESSAGE);
  }
  return media;
}

/** Downloads the original bytes with their original filename, without changing playback URLs. */
export async function downloadMedia(src: string, name: string): Promise<void> {
  const objectUrl = URL.createObjectURL(await readMediaBlob(src));
  try {
    const link = document.createElement("a");
    Object.assign(link, { href: objectUrl, download: name });
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

/** Converts browser-decodable images, including SVG, into the clipboard's portable PNG format. */
export async function readMediaPng(src: string): Promise<Blob> {
  const source = await readMediaBlob(src);
  if (mimeEssence(source) === "image/png") {
    return source;
  }

  const objectUrl = URL.createObjectURL(source);
  const picture = new Image();
  picture.src = objectUrl;
  try {
    await picture.decode().catch((cause: unknown) => {
      throw new Error(DECODE_FAILED_MESSAGE, { cause });
    });
    const { naturalHeight: height, naturalWidth: width } = picture;
    if (width <= 0 || height <= 0 || width * height > MAX_COPY_PIXELS) {
      throw new Error(BAD_DIMENSIONS_MESSAGE);
    }
    const surface = Object.assign(document.createElement("canvas"), { width, height });
    const context = surface.getContext("2d");
    if (!context) {
      throw new Error("Image copying is unavailable in this browser.");
    }
    context.drawImage(picture, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      surface.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("The image could not be converted to PNG."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
