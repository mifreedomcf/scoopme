/**
 * Upload validation and the malware-scanning adapter contract. Pure module.
 *
 * Nothing uploaded is served until it has been scanned. When no scanner is
 * configured the verdict is "unavailable", the file stays `pending`, and it is
 * not served — the absence of a scanner never reads as a clean result.
 */

export type UploadPurpose = "driver_credential" | "vehicle_photo" | "incident_evidence" | "profile_photo";

export interface UploadDescriptor {
  filename: string;
  contentType: string;
  sizeBytes: number;
  purpose: UploadPurpose;
}

export interface UploadPolicy {
  maxBytes: number;
  allowedContentTypes: string[];
  allowedExtensions: string[];
}

export const UPLOAD_POLICIES: Record<UploadPurpose, UploadPolicy> = {
  driver_credential: {
    maxBytes: 10 * 1024 * 1024,
    allowedContentTypes: ["application/pdf", "image/jpeg", "image/png", "image/heic"],
    allowedExtensions: ["pdf", "jpg", "jpeg", "png", "heic"],
  },
  vehicle_photo: {
    maxBytes: 8 * 1024 * 1024,
    allowedContentTypes: ["image/jpeg", "image/png", "image/heic"],
    allowedExtensions: ["jpg", "jpeg", "png", "heic"],
  },
  incident_evidence: {
    maxBytes: 25 * 1024 * 1024,
    allowedContentTypes: ["application/pdf", "image/jpeg", "image/png", "image/heic", "video/mp4", "audio/mpeg"],
    allowedExtensions: ["pdf", "jpg", "jpeg", "png", "heic", "mp4", "mp3"],
  },
  profile_photo: {
    maxBytes: 4 * 1024 * 1024,
    allowedContentTypes: ["image/jpeg", "image/png"],
    allowedExtensions: ["jpg", "jpeg", "png"],
  },
};

export interface UploadVerdict {
  ok: boolean;
  code: string;
  message: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}$/;

export function validateUpload(descriptor: UploadDescriptor): UploadVerdict {
  const policy = UPLOAD_POLICIES[descriptor.purpose];
  if (!policy) return { ok: false, code: "unknown_purpose", message: "That kind of upload is not accepted." };

  const name = descriptor.filename ?? "";
  if (!SAFE_NAME.test(name)) {
    return { ok: false, code: "unsafe_filename", message: "Rename the file using letters, numbers, spaces, dots, dashes or underscores." };
  }
  // Reject a name that carries a second extension, e.g. scan.pdf.exe
  const parts = name.split(".");
  if (parts.length > 2) {
    return { ok: false, code: "double_extension", message: "Remove the extra dots from the file name." };
  }
  const ext = (parts[1] ?? "").toLowerCase();
  if (!policy.allowedExtensions.includes(ext)) {
    return { ok: false, code: "extension_not_allowed", message: `Upload one of: ${policy.allowedExtensions.join(", ")}.` };
  }
  if (!policy.allowedContentTypes.includes(descriptor.contentType)) {
    return { ok: false, code: "content_type_not_allowed", message: "That file type is not accepted." };
  }
  // The declared type and the extension must agree, so a renamed file is caught.
  const typeMatchesExt =
    (descriptor.contentType === "application/pdf" && ext === "pdf") ||
    (descriptor.contentType.startsWith("image/") && ["jpg", "jpeg", "png", "heic"].includes(ext)) ||
    (descriptor.contentType === "video/mp4" && ext === "mp4") ||
    (descriptor.contentType === "audio/mpeg" && ext === "mp3");
  if (!typeMatchesExt) {
    return { ok: false, code: "type_extension_mismatch", message: "The file name and the file type do not match." };
  }
  if (!Number.isFinite(descriptor.sizeBytes) || descriptor.sizeBytes <= 0) {
    return { ok: false, code: "empty_file", message: "That file is empty." };
  }
  if (descriptor.sizeBytes > policy.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `That file is over ${Math.round(policy.maxBytes / (1024 * 1024))} MB.`,
    };
  }
  return { ok: true, code: "ok", message: "Accepted." };
}

export type ScanVerdict = "clean" | "flagged" | "unavailable";

/** The contract a real scanner implements in place of the stub. */
export interface MalwareScanner {
  readonly name: string;
  readonly isLive: boolean;
  scan(fileReference: string): Promise<{ verdict: ScanVerdict; detail?: string }>;
}

/**
 * No scanner configured. Returns "unavailable", never "clean".
 */
export const unavailableScanner: MalwareScanner = {
  name: "none",
  isLive: false,
  async scan() {
    return { verdict: "unavailable", detail: "no_scanner_configured" };
  },
};

export function scanStatusFor(verdict: ScanVerdict): "pending" | "clean" | "flagged" {
  if (verdict === "clean") return "clean";
  if (verdict === "flagged") return "flagged";
  return "pending";
}

/** An attachment is served only when it has actually been scanned clean. */
export function mayServeAttachment(scanStatus: string): boolean {
  return scanStatus === "clean";
}
