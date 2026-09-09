/**
 * Record acceptance of a specific published document version.
 *
 * Accepting version 0.1 never satisfies a later published version: the app
 * re-asks whenever the current published version changes.
 */
import { fail, notFound, ok, readJson, serverError, unauthorized } from "../../shared/http.ts";
import { audit, buildContext } from "../../shared/runtime.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const ctx = await buildContext(req);
    if (!ctx.user || !ctx.principal) return unauthorized();

    const body = await readJson(req);
    const documentId = String(body?.legal_document_id ?? "");
    const roleContext = body?.role_context ? String(body.role_context) : "";
    if (!documentId) return fail("missing_fields", "legal_document_id is required.", 400);

    const rows = await ctx.base44.asServiceRole.entities.LegalDocument.filter({ id: documentId }, undefined, 1);
    const doc = (rows ?? [])[0];
    if (!doc || !doc.published) return notFound("That document is not available.");

    const now = new Date().toISOString();
    const existing = await ctx.base44.asServiceRole.entities.LegalAcceptance.filter({
      user_id: ctx.principal.userId, legal_document_id: documentId,
    });
    if ((existing ?? []).length > 0) {
      return ok({ already_accepted: true, document_key: doc.document_key, document_version: doc.version });
    }

    await ctx.base44.asServiceRole.entities.LegalAcceptance.create({
      user_id: ctx.principal.userId,
      user_email: ctx.principal.email,
      legal_document_id: documentId,
      document_key: doc.document_key,
      document_version: doc.version,
      role_context: roleContext,
      accepted_at: now,
      user_agent: req.headers.get("user-agent") ?? "",
    });

    await audit(ctx, {
      event_type: "legal.accept", action: "create", subject_entity: "LegalDocument", subject_id: documentId,
      metadata: { document_key: doc.document_key, version: doc.version, review_status: doc.review_status },
    });

    return ok({
      accepted: true,
      document_key: doc.document_key,
      document_version: doc.version,
      review_status: doc.review_status,
    });
  } catch (e) {
    console.error("accept_legal_document_failed", String(e));
    return serverError();
  }
}
