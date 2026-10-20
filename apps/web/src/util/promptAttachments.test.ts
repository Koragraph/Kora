import {
  type PendingPromptAttachment,
  pendingPromptAttachmentToUpload,
  pendingPromptAttachmentToOptimistic,
  partitionIncomingAttachmentFiles,
  capRestoredAttachments,
  formatAttachmentSize,
  attachmentKindForMimeType,
} from "./promptAttachments";
import { describe, expect, it } from "vite-plus/test";

function makeFile(name: string, mimeType: string, sizeBytes: number): File {
  return new File([new Uint8Array(Math.max(0, sizeBytes))], name, { type: mimeType });
}

describe("pendingPromptAttachmentToUpload / pendingPromptAttachmentToOptimistic", () => {
  const pending: PendingPromptAttachment = {
    dataUrl: "data:image/png;base64,AAAA",
    sizeBytes: 100,
    mimeType: "image/png",
    name: "shot.png",
    type: "image",
    id: "attach-1",
  };

  it("round-trips a file attachment too", () => {
    const filePending: PendingPromptAttachment = {
      ...pending,
      type: "file",
      mimeType: "application/pdf",
    };
    expect(pendingPromptAttachmentToUpload(filePending).type).toBe("file");
    expect(pendingPromptAttachmentToOptimistic(filePending).type).toBe("file");
  });

  it("builds the optimistic timeline shape with a reusable previewUrl", () => {
    const optimistic = pendingPromptAttachmentToOptimistic(pending);
    expect(optimistic).toEqual({
      previewUrl: "data:image/png;base64,AAAA",
      sizeBytes: 100,
      mimeType: "image/png",
      name: "shot.png",
      id: "attach-1",
      type: "image",
    });
  });

  it("builds the wire upload shape with the client id", () => {
    const upload = pendingPromptAttachmentToUpload(pending);
    expect(upload).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      sizeBytes: 100,
      mimeType: "image/png",
      name: "shot.png",
      id: "attach-1",
      type: "image",
    });
  });
});

describe("partitionIncomingAttachmentFiles", () => {
  it("stops accepting once the attachment cap is reached", () => {
    const files = Array.from({ length: 3 }, (_, i) => makeFile(`f${i}.txt`, "text/plain", 10));
    const result = partitionIncomingAttachmentFiles(files, 7);
    // existingCount 7 + 8 max = room for 1 more
    expect(result.accepted).toHaveLength(1);
    expect(result.rejections).toHaveLength(2);
  });

  it("rejects empty files", () => {
    const empty = makeFile("empty.txt", "text/plain", 0);
    const result = partitionIncomingAttachmentFiles([empty], 0);
    expect(result.accepted).toEqual([]);
    expect(result.rejections[0]?.description).toContain("empty");
  });

  it("rejects an image over the image size limit", () => {
    const oversized = makeFile("huge.png", "image/png", 11 * 1024 * 1024);
    const result = partitionIncomingAttachmentFiles([oversized], 0);
    expect(result.accepted).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.name).toBe("huge.png");
  });
  it("accepts files within the per-kind size limit", () => {
    const files = [
      makeFile("photo.png", "image/png", 1024),
      makeFile("notes.txt", "text/plain", 1024),
    ];
    const result = partitionIncomingAttachmentFiles(files, 0);
    expect(result.accepted).toEqual(files);
    expect(result.rejections).toEqual([]);
  });
});

describe("formatAttachmentSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe("5 MB");
  });
});

describe("attachmentKindForMimeType", () => {
  it("treats everything else as a file, including unsupported images", () => {
    expect(attachmentKindForMimeType("application/pdf")).toBe("file");
    expect(attachmentKindForMimeType("image/heic")).toBe("file");
    expect(attachmentKindForMimeType("")).toBe("file");
  });
  it("treats supported image mimes as images", () => {
    expect(attachmentKindForMimeType("image/png")).toBe("image");
    expect(attachmentKindForMimeType("IMAGE/PNG")).toBe("image");
  });
});

describe("capRestoredAttachments", () => {
  const pending = (index: number): PendingPromptAttachment => ({
    dataUrl: "data:image/png;base64,AAAA",
    sizeBytes: 3,
    mimeType: "image/png",
    name: `img${index}.png`,
    type: "image",
    id: `att-${index}`,
  });

  it("keeps a Stop restore of 5 + 4 at 8 and refuses the ninth with the composer's message", () => {
    const restored = [1, 2, 3, 4].map(pending);
    const { kept, rejections } = capRestoredAttachments(restored, 5);
    expect(kept.map((attachment) => attachment.id)).toEqual(["att-1", "att-2", "att-3"]);
    expect(rejections).toEqual([
      {
        name: "img4.png",
        title: "Can't attach img4.png",
        description: "A message can carry at most 8 attachments.",
      },
    ]);
    // Same wording as a fresh attach past the limit.
    const fresh = partitionIncomingAttachmentFiles([makeFile("img4.png", "image/png", 3)], 8);
    expect(fresh.rejections).toEqual(rejections);
  });

  it("keeps everything under the limit and nothing when the composer is already full", () => {
    expect(capRestoredAttachments([1, 2].map(pending), 0).kept).toHaveLength(2);
    expect(capRestoredAttachments([1, 2].map(pending), 0).rejections).toEqual([]);
    expect(capRestoredAttachments([1].map(pending), 9).kept).toEqual([]);
  });
});
