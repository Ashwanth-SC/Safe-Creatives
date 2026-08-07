// ============================================================================
// Safe Creatives — turnkey payment receipt renderer
// ============================================================================
//
// One printed page from ?number=<receipt_number> (e.g. 29/1.1/06/08/2026 —
// project number / 1.<milestone number> / date). Reads the receipt row (which
// already snapshots the client + project details at issue time) and the
// company header from seller_settings, then renders a printable receipt.
//
// RLS decides access: turnkey_receipts is admin-only, so a non-admin (or a
// logged-out visitor, who is bounced to login by data-requires-auth) simply
// gets "not found" rather than any hint the receipt exists.
// ============================================================================

(async function () {
  await SC.ready;

  const sheet = document.querySelector("#sheet");
  const errorEl = document.querySelector("#receipt-error");
  const printBtn = document.querySelector("#print-btn");

  function fail(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  const number = new URLSearchParams(window.location.search).get("number");
  if (!number) {
    fail("No receipt specified.");
    return;
  }

  const [{ data: receipt, error }, { data: seller }] = await Promise.all([
    sb.from("turnkey_receipts").select("*").eq("receipt_number", number).maybeSingle(),
    sb.from("seller_settings").select("*").maybeSingle(),
  ]);

  if (error || !receipt) {
    fail("Receipt not found, or you don't have access to it.");
    return;
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

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

  // Indian numbering (crore / lakh / thousand). Whole rupees; paise appended.
  function rupeesInWords(rupees) {
    rupees = Math.floor(rupees);
    if (rupees === 0) return "Zero";
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
      "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
      "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    const two = (n) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : ""));
    const three = (n) => {
      const h = Math.floor(n / 100);
      const r = n % 100;
      return (h ? ones[h] + " Hundred" + (r ? " " : "") : "") + (r ? two(r) : "");
    };
    let words = "";
    const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
    const lakh = Math.floor(rupees / 100000); rupees %= 100000;
    const thousand = Math.floor(rupees / 1000); rupees %= 1000;
    if (crore) words += three(crore) + " Crore ";
    if (lakh) words += three(lakh) + " Lakh ";
    if (thousand) words += three(thousand) + " Thousand ";
    if (rupees) words += three(rupees);
    return words.trim();
  }

  function amountInWords(paise) {
    const total = Number(paise);
    const rupees = Math.floor(total / 100);
    const p = total % 100;
    let text = `Rupees ${rupeesInWords(rupees)}`;
    if (p) text += ` and ${rupeesInWords(p)} Paise`;
    return text + " only";
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const coName = seller?.trade_name || seller?.legal_name || "Safe Creatives";
  const coAddress = seller
    ? [seller.address_line, seller.city, seller.state_name && `${seller.state_name} ${seller.pin_code || ""}`.trim()]
        .filter(Boolean)
        .join(", ")
    : "Chennai, Tamil Nadu";
  const coContact = seller
    ? [seller.phone && `Ph: ${seller.phone}`, seller.email].filter(Boolean).join("  ·  ")
    : "";

  const line = (label, value) =>
    value ? `<div class="r-line"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>` : "";

  sheet.innerHTML = `
    <div class="r-head">
      <div>
        <div class="r-co-name">${escapeHtml(coName)}</div>
        <div class="r-co-sub">${escapeHtml(coAddress)}</div>
        ${coContact ? `<div class="r-co-sub">${escapeHtml(coContact)}</div>` : ""}
        ${seller?.gstin ? `<div class="r-co-sub">GSTIN: ${escapeHtml(seller.gstin)}</div>` : ""}
      </div>
      <div class="r-title">
        <div class="r-title-word">RECEIPT</div>
        <div class="r-num">${escapeHtml(receipt.receipt_number)}</div>
        <div class="r-date">${fmtDate(receipt.receipt_date)}</div>
      </div>
    </div>

    <div class="r-body">
      ${line("Received with thanks from", receipt.client_name)}
      ${line("Phone", receipt.client_phone)}
      ${line("Project", receipt.project_name)}
      ${line("Site address", receipt.site_address)}

      <div class="r-amount">
        <div class="r-amount-words"><b>${escapeHtml(amountInWords(receipt.amount_paise))}</b></div>
        <div class="r-amount-fig">${SC.money(Number(receipt.amount_paise))}</div>
      </div>

      <div class="r-meta">
        <div><span>Towards</span>${escapeHtml(receipt.receipt_name)}</div>
        <div><span>Mode of payment</span>${escapeHtml(receipt.payment_mode)}</div>
        <div><span>Date</span>${fmtDate(receipt.receipt_date)}</div>
      </div>

      ${receipt.notes ? `<div class="r-note-block"><span>Note</span>${escapeHtml(receipt.notes)}</div>` : ""}
    </div>

    <div class="r-foot">
      <div class="r-note">This is a computer-generated receipt and does not require a physical signature.</div>
      <div class="r-sign">
        <div class="r-sign-line"></div>
        For ${escapeHtml(coName)}<br />Authorised signatory
      </div>
    </div>
  `;

  sheet.hidden = false;
  printBtn.addEventListener("click", () => window.print());
})();
