// ============================================================================
// Safe Creatives — turnkey signed-document viewer
// ============================================================================
//
// Opens from ?id=<uuid>. Loads the turnkey_documents row, mints a short-lived
// signed URL for the file in the private 'turnkey-documents' bucket, and shows
// the details plus an inline preview (PDF / image) or a download fallback.
//
// Three actions, mirroring the receipt page: Download, Send email to customer
// (deliberate — never automatic), and Back to dashboard.
//
// RLS decides access: turnkey_documents + the bucket are admin-only, so a
// non-admin (or a logged-out visitor, bounced by data-requires-auth) simply
// gets "not found".
// ============================================================================

(async function () {
  await SC.ready;

  const sheet = document.querySelector("#sheet");
  const errorEl = document.querySelector("#document-error");
  const downloadBtn = document.querySelector("#download-btn");
  const emailBtn = document.querySelector("#email-btn");
  const emailStatus = document.querySelector("#email-status");

  function fail(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtDate(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = String(ymd).split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${months[Number(m) - 1] || m} ${y}`;
  }

  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    fail("No document specified.");
    return;
  }

  const { data: doc, error } = await sb
    .from("turnkey_documents")
    .select("*, turnkey_projects ( project_number )")
    .eq("id", id)
    .maybeSingle();

  if (error || !doc) {
    fail("Document not found, or you don't have access to it.");
    return;
  }

  // Short-lived signed URL for the private file — used for both preview and
  // download (the bucket is not public).
  let fileUrl = null;
  const { data: signed } = await sb.storage
    .from("turnkey-documents")
    .createSignedUrl(doc.storage_path, 3600);
  fileUrl = signed?.signedUrl || null;

  const projectNo = doc.turnkey_projects?.project_number;
  const projectLabel =
    (projectNo != null ? `#${projectNo}` : "") +
    (doc.project_name ? `${projectNo != null ? " — " : ""}${doc.project_name}` : "");

  const meta = (label, value) =>
    value ? `<div><span>${label}</span>${escapeHtml(value)}</div>` : "";

  const mime = String(doc.mime_type || "");
  const canEmbed = fileUrl && (mime === "application/pdf" || mime.startsWith("image/"));
  const preview = canEmbed
    ? `<iframe class="d-frame" src="${escapeHtml(fileUrl)}" title="Document preview"></iframe>`
    : `<div class="d-fallback">This file type can't be previewed here.${
        fileUrl ? ` <a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Open the file ↗︎</a> or use Download above.` : ""
      }</div>`;

  sheet.innerHTML = `
    <div class="d-head">
      <div class="d-eyebrow">PROJECT DOCUMENT</div>
      <div class="d-title">${escapeHtml(doc.document_type || "Document")}</div>
      ${doc.annexure_name ? `<div class="d-annexure">${escapeHtml(doc.annexure_name)}</div>` : ""}
    </div>

    <div class="d-meta">
      ${meta("Document number", doc.document_number)}
      ${meta("Date of signing", doc.signed_date ? fmtDate(doc.signed_date) : "")}
      ${meta("Project", projectLabel)}
      ${meta("Client", doc.client_name)}
      ${meta("File", doc.file_name)}
    </div>

    ${doc.notes ? `<div class="d-fallback" style="text-align:left;background:#faf7f2;border-color:rgba(111,34,42,.25);margin-bottom:14px;">${escapeHtml(doc.notes)}</div>` : ""}

    ${preview}
  `;
  sheet.hidden = false;

  // --- Download -------------------------------------------------------------
  downloadBtn.addEventListener("click", async () => {
    if (!fileUrl) return;
    const label = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Preparing…";
    try {
      const res = await fetch(fileUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name || `${doc.document_type || "document"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      console.error("Download failed:", downloadError);
      window.open(fileUrl, "_blank", "noopener");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = label;
    }
  });

  // --- Send to customer -----------------------------------------------------
  function setStatus(text, isError) {
    emailStatus.textContent = text || "";
    emailStatus.hidden = !text;
    emailStatus.className = `email-status no-print${isError ? " is-error" : " is-ok"}`;
  }

  emailBtn.addEventListener("click", async () => {
    if (!window.confirm("Send this document to the customer's email?")) return;
    const label = emailBtn.textContent;
    emailBtn.disabled = true;
    emailBtn.textContent = "Sending…";
    setStatus("");
    try {
      const { data, error: sendError } = await sb.functions.invoke("send-turnkey-document", {
        body: { id },
      });
      if (sendError) throw sendError;
      if (data?.ok) setStatus(`Emailed to ${data.to}.`);
      else if (data?.reason === "no_email")
        setStatus("No email is on file for this client. Add one on the lead, then try again.", true);
      else setStatus(`Could not send: ${data?.error || data?.reason || "unknown error"}.`, true);
    } catch (sendError) {
      console.error("Send document email failed:", sendError);
      setStatus(`Could not send: ${sendError?.message || sendError}.`, true);
    } finally {
      emailBtn.disabled = false;
      emailBtn.textContent = label;
    }
  });
})();
