// ============================================================================
// Safe Creatives — order summary + GST tax invoice renderer
// ============================================================================
//
// Two printed pages from one URL (?number=SCSR-27-01-1-001):
//
//   Page 1  ORDER SUMMARY  — every package with its options, add-ons and the
//           full money breakdown, read from the order_item_* snapshots.
//   Page 2  TAX INVOICE    — the advance only, read from the invoice
//           snapshot. This is the legal document; the summary is context.
//
// Nothing on either page is recomputed. A printed document must match the
// stored record to the paisa, every time it is printed, whatever the catalog
// says today.
//
// RLS decides who sees it: the customer it belongs to, or an admin. Anyone
// else gets "not found" rather than a hint that the number exists.
// ============================================================================

(async function () {
  await SC.ready;

  const summarySheet = document.querySelector("#summary");
  const invoiceSheet = document.querySelector("#sheet");
  const errorEl = document.querySelector("#invoice-error");

  const params = new URLSearchParams(window.location.search);
  const number = params.get("number");
  const orderNumber = params.get("order");

  function fail(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  // The order query is the same whether it is reached via an invoice or an
  // order number, so it lives in one place.
  const ORDER_SELECT = `order_number, status, placed_at,
    subtotal_paise, gst_percent, gst_paise, total_paise,
    advance_amount_paise, balance_paise,
    contact_name, contact_email, contact_phone,
    delivery_address_line, delivery_city, delivery_state_name,
    delivery_pin_code,
    order_items (
      package_name, hsn_code, base_price_paise, line_total_paise,
      order_item_options ( product_name, group_name, option_name,
                           finish, material, price_delta_paise ),
      order_item_addons ( addon_name, hsn_code, price_paise )
    )`;

  let invoice = null;
  let order = null;

  if (number) {
    // Full document: order summary page + tax invoice page.
    const { data, error } = await sb
      .from("invoices")
      .select("*, invoice_lines ( * )")
      .eq("invoice_number", number)
      .maybeSingle();

    if (error || !data) {
      return fail(
        "This invoice could not be found on your account. Check the number, or contact us if you believe this is a mistake."
      );
    }
    invoice = data;
    invoice.invoice_lines.sort((a, b) => a.line_number - b.line_number);

    if (invoice.order_id) {
      const { data: ord } = await sb
        .from("orders")
        .select(ORDER_SELECT)
        .eq("id", invoice.order_id)
        .maybeSingle();
      order = ord;
    }
  } else if (orderNumber) {
    // Summary only: an order that has no invoice yet (advance unpaid) still
    // has a project summary worth printing.
    const { data, error } = await sb
      .from("orders")
      .select(ORDER_SELECT)
      .eq("order_number", orderNumber)
      .maybeSingle();

    if (error || !data) {
      return fail(
        "This order could not be found on your account. Check the reference, or contact us if you believe this is a mistake."
      );
    }
    order = data;
  } else {
    return fail("No invoice or order reference was provided.");
  }

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

  const dateOf = (value) =>
    new Date(value).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

  // ------------------------------------------------------------------
  // Page 1 — order summary
  // ------------------------------------------------------------------

  function renderSummary() {
    const address = [
      order.delivery_address_line,
      order.delivery_city,
      order.delivery_state_name,
      order.delivery_pin_code,
    ]
      .filter(Boolean)
      .join(", ");

    const itemBlocks = order.order_items
      .map((item, index) => {
        // Options grouped by product, so a three-product package reads as
        // three specification blocks rather than one flat list.
        const byProduct = new Map();
        (item.order_item_options || []).forEach((option) => {
          if (!byProduct.has(option.product_name)) byProduct.set(option.product_name, []);
          byProduct.get(option.product_name).push(option);
        });

        const productBlocks = [...byProduct.entries()]
          .map(([productName, options]) => {
            const rows = options
              .map((option) => {
                const delta = Number(option.price_delta_paise || 0);
                const spec = [option.finish, option.material].filter(Boolean).join(", ");
                return `<li>${esc(option.group_name)}: <strong>${esc(option.option_name)}</strong>${
                  delta ? ` (+₹${rupees(delta)})` : ""
                }${spec ? ` — ${esc(spec)}` : ""}</li>`;
              })
              .join("");
            return `<div class="oi-product"><h3>${esc(productName)}</h3><ul>${rows}</ul></div>`;
          })
          .join("");

        const addons = item.order_item_addons || [];
        const addonRows = addons.length
          ? addons
              .map(
                (addon) =>
                  `<li>${esc(addon.addon_name)}${
                    addon.hsn_code ? ` (HSN ${esc(addon.hsn_code)})` : ""
                  } — ₹${rupees(addon.price_paise)}</li>`
              )
              .join("")
          : `<li class="oi-none">None selected</li>`;

        return `<div class="order-item">
          <div class="oi-head">
            <strong>${index + 1}. ${esc(item.package_name)}</strong>
            <span>₹${rupees(item.line_total_paise)}</span>
          </div>
          <p class="oi-base">Base price ₹${rupees(item.base_price_paise)}${
            item.hsn_code ? ` · HSN ${esc(item.hsn_code)}` : ""
          }</p>
          ${productBlocks}
          <div class="oi-product"><h3>Add-ons</h3><ul>${addonRows}</ul></div>
        </div>`;
      })
      .join("");

    summarySheet.innerHTML = `
      <div class="doc-head">
        <h1>ORDER SUMMARY</h1>
        <span>${
          invoice
            ? `ACCOMPANIES INVOICE ${esc(invoice.invoice_number)}`
            : `ORDER ${esc(order.order_number)}`
        }</span>
      </div>

      <div class="parties">
        <div class="box">
          <h2>Customer</h2>
          <strong class="name">${esc(order.contact_name)}</strong>
          ${esc(address)}<br />
          ${esc(order.contact_email || "")}${order.contact_phone ? ` · ${esc(order.contact_phone)}` : ""}
        </div>
        <div class="box">
          <h2>Order</h2>
          <strong class="name">${esc(order.order_number)}</strong>
          Placed: ${dateOf(order.placed_at)}<br />
          Packages: ${order.order_items.length}
        </div>
      </div>

      ${itemBlocks}

      <div class="sum-totals">
        <div class="row"><span>Package total (ex GST)</span><span>₹${rupees(order.subtotal_paise)}</span></div>
        <div class="row"><span>GST (${Number(order.gst_percent)}%)</span><span>₹${rupees(order.gst_paise)}</span></div>
        <div class="row grand"><span>Total payable</span><span>₹${rupees(order.total_paise)}</span></div>
        <div class="row paid"><span>Refundable advance — this invoice (incl. GST)</span><span>₹${rupees(order.advance_amount_paise)}</span></div>
        <div class="row"><span>Balance after site verification</span><span>₹${rupees(order.balance_paise)}</span></div>
      </div>

      <p class="doc-note">${
        invoice
          ? "This summary describes the order as configured. The tax invoice on the following page covers the reservation advance only; the balance is invoiced at later phases."
          : "This summary describes the order as configured. It is not a tax invoice; a tax invoice is issued once the reservation advance is paid."
      }</p>
    `;
    summarySheet.hidden = false;
  }

  // ------------------------------------------------------------------
  // Page 2 — tax invoice
  // ------------------------------------------------------------------

  function renderInvoice() {
    const inter = invoice.is_interstate;

    // Tax columns switch with the split: CGST+SGST inside the seller's
    // state, IGST outside it. Showing both would be wrong on either kind.
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

    invoiceSheet.innerHTML = `
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
          Date: ${dateOf(invoice.issue_date)}<br />
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
    invoiceSheet.hidden = false;
  }

  if (order) renderSummary();
  if (invoice) renderInvoice();
  document.title = `${
    invoice ? invoice.invoice_number : order.order_number
  } | Safe Creatives`;
})();
