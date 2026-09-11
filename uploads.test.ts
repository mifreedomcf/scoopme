import { describe, expect, it } from "vitest";
import { mayServeAttachment, scanStatusFor, unavailableScanner, UPLOAD_POLICIES, validateUpload } from "@shared/uploads";

const good = { filename: "insurance.pdf", contentType: "application/pdf", sizeBytes: 200_000, purpose: "driver_credential" as const };

describe("upload validation", () => {
  it("accepts an ordinary credential document", () => {
    expect(validateUpload(good).ok).toBe(true);
  });

  it("rejects a disguised executable", () => {
    expect(validateUpload({ ...good, filename: "scan.pdf.exe" }).code).toBe("double_extension");
    expect(validateUpload({ ...good, filename: "payload.exe", contentType: "application/octet-stream" }).ok).toBe(false);
  });

  it("rejects a file whose name and declared type disagree", () => {
    expect(validateUpload({ ...good, filename: "licence.png", contentType: "application/pdf" }).code)
      .toBe("type_extension_mismatch");
  });

  it("rejects path traversal and control characters in a name", () => {
    expect(validateUpload({ ...good, filename: "../../etc/passwd" }).code).toBe("unsafe_filename");
    expect(validateUpload({ ...good, filename: "a\u0000b.pdf" }).code).toBe("unsafe_filename");
  });

  it("enforces the size ceiling and rejects an empty file", () => {
    expect(validateUpload({ ...good, sizeBytes: UPLOAD_POLICIES.driver_credential.maxBytes + 1 }).code).toBe("too_large");
    expect(validateUpload({ ...good, sizeBytes: 0 }).code).toBe("empty_file");
  });

  it("applies a different policy per purpose", () => {
    expect(validateUpload({ ...good, purpose: "vehicle_photo" }).code).toBe("extension_not_allowed");
    expect(validateUpload({ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 5_000_000, purpose: "incident_evidence" }).ok).toBe(true);
    expect(validateUpload({ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 5_000_000, purpose: "driver_credential" }).ok).toBe(false);
  });
});

describe("malware scanning", () => {
  it("reports unavailable rather than clean when no scanner is configured", async () => {
    const result = await unavailableScanner.scan("private://x");
    expect(result.verdict).toBe("unavailable");
    expect(unavailableScanner.isLive).toBe(false);
  });

  it("maps an unavailable scan to pending, which is never servable", () => {
    expect(scanStatusFor("unavailable")).toBe("pending");
    expect(mayServeAttachment("pending")).toBe(false);
    expect(mayServeAttachment("flagged")).toBe(false);
    expect(mayServeAttachment("not_applicable")).toBe(false);
    expect(mayServeAttachment("clean")).toBe(true);
  });
});
