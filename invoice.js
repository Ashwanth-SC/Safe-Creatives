// ============================================================================
// Safe Creatives — GST tax invoice renderer
// ============================================================================
//
// Renders one invoice by ?number=SCSR-27-01-1-001 for printing. Everything on
// the page comes from the invoices/invoice_lines snapshot -- nothing is
// recomputed here, because a printed invoice must match the stored record to
// the paisa, every time it is printed.
//
// RLS decides who sees it: the customer it belongs to, or an admin. Anyone
// else gets "not found" rather than a hint that the number exists.
// ============================================================================

(async function () {
  await SC.ready;

  const sheet = document.querySelector("#sheet");
  const errorEl = document.querySelector("#invoice-error");

  const number = new URLSearchParams(window.location.search).get("number");

  function fail(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  if (!number) return fail("No invoice number was provided.");

  const { data: invoice, error } = await sb
    .from("invoices")
    .select("*, invoice_lines ( * )")
    .eq("invoice_number", number)
    .maybeSingle();

  if (error || !invoice) {
    return fail(
      "This invoice could not be found on your account. Check the number, or contact us if you believe this is a mistake."
    );
  }

  invoice.invoice_lines.sort((a, b) => a.line_number - b.line_number);

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  const rupees = (paise) =>
    (Number(paise || 0) / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // Indian-system amount in words: crore / lakh / thousand.
  function amountInWords(paise) {
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
      "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
      "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty",
      "Seventy", "Eighty", "Ninety"];

    function twoDigits(n) {
      if (n < 20) return ones[n];
      return (tens[Math.floor(n / 10)] + " " + ones[n % 10]).trim();
    }
    function threeDigits(n) {
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      return ((hundred ? ones[hundred] + " Hundred " : "") + twoDigits(rest)).trim();
    }
    function inWords(n) {
      if (n === 0) return "Zero";
      const crore = Math.floor(n / 10000000);
      const lakh = Math.floor((n % 10000000) / 100000);
      const thousand = Math.floor((n % 100000) / 1000);
      const rest = n % 1000;
      return [
        crore ? twoDigits(crore) + " Crore" : "",
        lakh ? twoDigits(lakh) + " Lakh" : "",
        thousand ? twoDigits(thousand) + " Thousand" : "",
        rest ? threeDigits(rest) : "",
      ]
        .filter(Boolean)
        .join(" ");
    }

    const whole = Math.floor(Number(paise) / 100);
    const fraction = Number(paise) % 100;
    let words = `Rupees ${inWords(whole)}`;
    if (fraction) words += ` and ${twoDigits(fraction)} Paise`;
    return words + " Only";
  }

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const inter = invoice.is_interstate;
  const issued = new Date(invoice.issue_date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  // Tax columns switch with the split: CGST+SGST inside the seller's state,
  // IGST outside it. Showing both would be wrong on either kind of invoice.
  const taxHead = inter
    ? `<th colspan="2">IGST</th>`
    : `<th colspan="2">CGST</th><th colspan="2">SGST</th>`;
  const taxSubHead = inter
    ? `<th>Rate</th><th>Amount</th>`
    : `<th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th>`;

  const lineRows = invoice.invoice_lines
    .map((line) => {
      const half = (Number(line.gst_rate) / 2).toFixed(1).replace(/\.0$/, "");
      const taxCells = inter
        ? `<td class="num">${line.gst_rate}%</td><td class="num">${rupees(line.igst_paise)}</td>`
        : `<td class="num">${half}%</td><td class="num">${rupees(line.cgst_paise)}</td>` +
          `<td class="num">${half}%</td><td class="num">${rupees(line.sgst_paise)}</td>`;
      return `<tr>
        <td class="num">${line.line_number}</td>
        <td>${esc(line.description)}${line.detail ? `<span class="line-detail">${esc(line.detail)}</span>` : ""}</td>
        <td class="num">${esc(line.hsn_code) || "—"}</td>
        <td class="num">${Number(line.quantity)}</td>
        <td class="num">${esc(line.unit)}</td>
        <td class="num">${rupees(line.unit_price_paise)}</td>
        <td class="num">${rupees(line.taxable_value_paise)}</td>
        ${taxCells}
        <td class="num">${rupees(line.line_total_paise)}</td>
      </tr>`;
    })
    .join("");

  const taxFoot = inter
    ? `<td></td><td class="num">${rupees(invoice.igst_paise)}</td>`
    : `<td></td><td class="num">${rupees(invoice.cgst_paise)}</td>` +
      `<td></td><td class="num">${rupees(invoice.sgst_paise)}</td>`;

  sheet.innerHTML = `
    <div class="doc-head">
      <h1>TAX INVOICE</h1>
      <span>ORIGINAL FOR RECIPIENT</span>
    </div>

    <div class="parties">
      <div class="box">
        <h2>Supplier</h2>
        <strong class="name">${esc(invoice.seller_name)}</strong>
        ${esc(invoice.seller_address)}<br />
        ${esc(invoice.seller_state_name)} — ${esc(invoice.seller_state_code)}<br />
        ${invoice.seller_gstin ? `GSTIN: ${esc(invoice.seller_gstin)}` : "<em>GSTIN pending registration</em>"}
      </div>
      <div class="box">
        <h2>Invoice</h2>
        <strong class="name">${esc(invoice.invoice_number)}</strong>
        Date: ${issued}<br />
        Phase: ${esc(invoice.phase_label || invoice.phase_number)}<br />
        Reverse charge: ${invoice.reverse_charge ? "Yes" : "No"}
      </div>
    </div>

    <div class="meta-grid">
      <div class="box">
        <h2>Billed &amp; shipped to</h2>
        <strong class="name">${esc(invoice.buyer_name)}</strong>
        ${esc(invoice.buyer_address)}<br />
        ${invoice.buyer_gstin ? `GSTIN: ${esc(invoice.buyer_gstin)}` : "Unregistered (B2C)"}
      </div>
      <div class="box">
        <h2>Place of supply</h2>
        ${esc(invoice.place_of_supply_state)} — ${esc(invoice.place_of_supply_code)}<br />
        Supply type: ${inter ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}
      </div>
    </div>

    <table class="lines">
      <thead>
        <tr>
          <th rowspan="2">#</th><th rowspan="2">Description</th>
          <th rowspan="2">HSN/SAC</th><th rowspan="2">Qty</th>
          <th rowspan="2">Unit</th><th rowspan="2">Rate (₹)</th>
          <th rowspan="2">Taxable (₹)</th>
          ${taxHead}
          <th rowspan="2">Total (₹)</th>
        </tr>
        <tr>${taxSubHead}</tr>
      </thead>
      <tbody>${lineRows}</tbody>
      <tfoot>
        <tr>
          <td colspan="6">Total</td>
          <td class="num">${rupees(invoice.taxable_value_paise)}</td>
          ${taxFoot}
          <td class="num">${rupees(invoice.total_paise)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="words">Amount in words: <em>${amountInWords(invoice.total_paise)}</em></div>

    <div class="foot">
      <div class="box">
        <h2>Notes</h2>
        ${esc(invoice.notes) || "The reservation advance is refundable as per the accepted terms and conditions."}
      </div>
      <div class="box signature">
        <span class="for">For ${esc(invoice.seller_name)}</span>
        <span class="line">Authorised signatory</span>
      </div>
    </div>

    <p class="doc-note">This is a computer-generated invoice.</p>
  `;

  sheet.hidden = false;
  document.title = `${invoice.invoice_number} | Safe Creatives`;
})();
