/*
 * Shopping Trips card for Home Assistant.
 * Plain web component (no build step). Talks to the shopping_trips integration over the websocket API.
 *
 * Views: the shopping list, trip history, and one trip. Trip items open in a full-screen editor.
 */
const CARD_VERSION = "0.6.4";

const GREEN = "#4CAF50";
const ORANGE = "#E08A3C";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => "$" + Number(n).toFixed(2);
/** 2 → "2", 0.75 → "0.75" */
const qtyText = (q) => String(Number(q));
/** Parses typed amounts like "$3.50" or "3,50"; blank → null. */
const parseNum = (s) => {
  const v = String(s ?? "").replace("$", "").replace(",", ".").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dateText = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const icon = (name) => `<ha-icon icon="mdi:${name}"></ha-icon>`;

// ── Receipts: image shrinking, text reading (Tesseract.js in the browser) and line parsing ──

/** Resizes a photo to at most `max` px on its longest side as JPEG; returns the original if it can't be decoded. */
async function shrinkImage(file, max = 2000) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob || file;
  } catch (e) {
    return file;
  }
}

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const HTML5_QRCODE_URL ="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
const scriptLoads = {};
let tesseractWorker = null;

/** Loads a library script once and resolves to the global it defines. */
function loadScript(url, globalName, what) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptLoads[url]) {
    scriptLoads[url] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve(window[globalName]);
      s.onerror = () => {
        delete scriptLoads[url];
        reject(new Error(`Couldn't load the ${what}. It needs an internet connection the first time.`));
      };
      document.head.appendChild(s);
    });
  }
  return scriptLoads[url];
}

/** Reads the text on a receipt image, line by line (amounts stay on the same line as their items). */
async function readReceiptText(blob) {
  const T = await loadScript(TESSERACT_URL, "Tesseract", "text reader");
  if (!tesseractWorker) tesseractWorker = T.createWorker("eng");
  const worker = await tesseractWorker;
  const { data } = await worker.recognize(blob);
  return data.text || "";
}

const PRICE_RE = /\$?\d+\.\d{2}/g;
const NON_ITEM_WORDS = ["total", "subtotal", "tax", "gst", "change", "cash", "card", "visa", "eftpos", "mastercard",
  "receipt", "thank", "abn", "rounding", "balance", "tender", "savings"];

/** Splits a receipt line into its description and the last price on it, if any. */
function parseReceiptLine(line) {
  const prices = line.match(PRICE_RE);
  const price = prices ? Number(prices[prices.length - 1].replace("$", "")) : null;
  const name = line.replace(PRICE_RE, "").replace(/^\d+\s*[xX]\s*/, "").replace(/\s{2,}/g, " ").trim();
  return { name, price: Number.isFinite(price) ? price : null };
}

/** True for lines that look like purchased items rather than totals, payment or store details. */
function looksLikeItemLine(line) {
  const lower = line.toLowerCase();
  return !NON_ITEM_WORDS.some((w) => lower.includes(w)) && parseReceiptLine(line).name.length >= 3;
}

/** Reads a barcode from a photo: the browser's own detector where there is one, otherwise html5-qrcode. */
async function decodeBarcode(file) {
  if ("BarcodeDetector" in window) {
    try {
      const codes = await new window.BarcodeDetector().detect(await createImageBitmap(file));
      if (codes.length) return codes[0].rawValue;
    } catch (e) {
      // fall back to the library
    }
  }
  const Html5Qrcode = await loadScript(HTML5_QRCODE_URL, "Html5Qrcode", "barcode reader");
  let host = document.getElementById("shopping-trips-barcode");
  if (!host) {
    host = Object.assign(document.createElement("div"), { id: "shopping-trips-barcode" });
    host.style.display = "none";
    document.body.appendChild(host);
  }
  const scanner = new Html5Qrcode("shopping-trips-barcode");
  try {
    return await scanner.scanFile(file, false);
  } catch (e) {
    return null;
  } finally {
    try {
      scanner.clear();
    } catch (e) {
      // nothing to clear
    }
  }
}

// ── CSV (same format as the Android app's export) ──

/** Quotes a CSV field when it contains a comma, quote or line break. */
const csvField = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Parses CSV into records, honouring quoted fields with "" escapes and embedded line breaks. */
function parseCsv(text) {
  const records = [];
  let record = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { record.push(field); field = ""; }
    else if (c === "\n") { record.push(field); records.push(record); record = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  return records;
}

const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
const containsAll = (a, b) => [...b].every((w) => a.has(w));

class ShoppingTripsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._listId = null;
    this._unsub = null;
    this._subscribing = false;
    this._built = false;
    this._view = { name: "list" };
    this._editors = []; // stack of open editors: { tripId, recordId, parentId, override }
    this._unpricedFirst = false;
    this._search = "";
    this._signed = {}; // receipt id → { url, exp } signed image URLs
    this._status = ""; // progress line on the trip view while receipts are saved and read
    this._viewer = null; // open receipt: { receiptId, showText, mapped }
    this._newTrip = null; // "new trip from receipt" draft
  }

  setConfig(config) {
    this._config = config || {};
  }

  set hass(hass) {
    this._hass = hass;
    this._build();
    if (!this._unsub && !this._subscribing && this.isConnected) this._subscribe();
  }

  connectedCallback() {
    this._build();
    if (this._hass && !this._unsub && !this._subscribing) this._subscribe();
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig() {
    return {};
  }

  // ── Data ────────────────────────────────────────────────────────────────

  async _subscribe() {
    this._subscribing = true;
    try {
      this._unsub = await this._hass.connection.subscribeMessage(
        (data) => {
          this._data = data;
          this._render();
        },
        { type: "shopping_trips/subscribe" }
      );
    } catch (err) {
      this._body.innerHTML = `<div class="empty">Shopping Trips isn't set up yet. Add the integration under
        Settings → Devices &amp; services.</div>`;
    } finally {
      this._subscribing = false;
    }
  }

  async _ws(type, params = {}) {
    try {
      return await this._hass.callWS({ type: `shopping_trips/${type}`, ...params });
    } catch (err) {
      await this._dialog({ title: "Something went wrong", message: err.message || String(err), cancel: null });
      return undefined;
    }
  }

  _currentList() {
    const lists = this._data?.lists || [];
    let list = lists.find((l) => l.id === this._listId);
    if (!list && this._config.list) {
      list = lists.find((l) => l.name.toLowerCase() === String(this._config.list).toLowerCase());
    }
    list = list || lists[0];
    this._listId = list?.id || null;
    return list;
  }

  _trip(id) {
    return this._data?.trips.find((t) => t.id === id);
  }

  _record(id) {
    return this._data?.records.find((r) => r.id === id);
  }

  /** Records that carry their own price: items without sub-items, and sub-items. */
  _leaves(records) {
    const parents = new Set(records.filter((r) => r.parent_id).map((r) => r.parent_id));
    return records.filter((r) => !parents.has(r.id));
  }

  _tripSummary(trip) {
    const records = this._data.records.filter((r) => r.trip_id === trip.id);
    const leaves = this._leaves(records);
    const priced = leaves.filter((r) => r.total != null);
    return {
      count: leaves.length,
      unpriced: leaves.filter((r) => r.unit_price == null && !r.total_override).length,
      total: priced.length ? priced.reduce((s, r) => s + r.total, 0) : null,
    };
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div id="top"></div>
        <div id="body"><div class="empty">Loading…</div></div>
        <div id="footer"></div>
      </ha-card>
      <div id="editor" class="fullscreen hidden"></div>
      <div id="panel" class="fullscreen hidden"></div>
      <div id="subpanel" class="fullscreen hidden"></div>
      <div id="dialog" class="overlay hidden"></div>
      <input id="tripPhotos" type="file" accept="image/*" multiple hidden>
      <input id="onePhoto" class="pick" type="file" accept="image/*" hidden>
      <input id="onePhotoCam" class="pick" type="file" accept="image/*" capture="environment" hidden>
      <input id="csvFile" class="pick" type="file" accept=".csv,text/csv,text/plain" hidden>
      <input id="zipFile" class="pick" type="file" accept=".zip,application/zip" hidden>`;
    this._panelEl = this.shadowRoot.getElementById("panel");
    this.shadowRoot.querySelectorAll("input.pick").forEach((input) =>
      input.addEventListener("change", (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (file && this._fileTarget) this._fileTarget(file);
      })
    );
    this.shadowRoot.getElementById("tripPhotos").addEventListener("change", (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length && this._photoTarget) this._photoTarget(files);
    });
    this._top = this.shadowRoot.getElementById("top");
    this._body = this.shadowRoot.getElementById("body");
    this._footer = this.shadowRoot.getElementById("footer");
    this._editorEl = this.shadowRoot.getElementById("editor");
    this._setView({ name: "list" });
  }

  /** Builds the header for a view; the body is filled by _render(). */
  _setView(view) {
    this._view = view;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (view.name === "list") {
      this._top.innerHTML = `
        <div class="header">
          <select id="list" aria-label="List"></select>
          <button id="history" class="icon" title="Shopping trips">${icon("history")}</button>
          <button id="menu" class="icon" title="Manage lists">${icon("dots-vertical")}</button>
        </div>
        <form id="addForm" class="add">
          <input id="addInput" list="names" placeholder="Add item (type or pick)" autocomplete="off" enterkeyhint="done">
          <datalist id="names"></datalist>
          <button type="submit">Add</button>
        </form>`;
      $("list").addEventListener("change", (e) => {
        this._listId = e.target.value;
        this._render();
      });
      $("history").addEventListener("click", () => this._setView({ name: "trips" }));
      $("menu").addEventListener("click", () => this._listMenu());
      $("addForm").addEventListener("submit", (e) => {
        e.preventDefault();
        this._addItem();
      });
    } else if (view.name === "trips") {
      this._top.innerHTML = `
        <div class="header">
          <button id="back" class="icon" title="Back">${icon("arrow-left")}</button>
          <div class="title">Shopping Trips</div>
          <button id="newFromReceipt" class="icon" title="New trip from receipt photos">${icon("camera")}</button>
        </div>
        <div class="add"><input id="search" placeholder="Search item or store" value="${esc(this._search)}" enterkeyhint="search"></div>`;
      $("back").addEventListener("click", () => this._setView({ name: "list" }));
      $("newFromReceipt").addEventListener("click", () => this._openNewTrip());
      $("search").addEventListener("input", (e) => {
        this._search = e.target.value;
        this._render();
      });
    } else if (view.name === "trip") {
      this._top.innerHTML = `
        <div class="header">
          <button id="back" class="icon" title="Back">${icon("arrow-left")}</button>
          <div class="title"><div id="tripTitle"></div><div id="tripSub" class="sub"></div></div>
          <button id="tripCamera" class="icon" title="Add receipt photos">${icon("camera")}</button>
          <button id="addRecord" class="icon" title="Add item">${icon("plus")}</button>
          <button id="tripMenu" class="icon" title="More">${icon("dots-vertical")}</button>
        </div>`;
      $("back").addEventListener("click", () => this._setView({ name: "trips" }));
      $("tripCamera").addEventListener("click", () => this._pickPhotos((files) => this._addReceiptPhotos(view.id, files)));
      $("addRecord").addEventListener("click", () => this._openEditor({ tripId: view.id, recordId: null, parentId: null }));
      $("tripMenu").addEventListener("click", () => this._tripMenu(view.id));
    } else if (view.name === "settings") {
      this._top.innerHTML = `
        <div class="header">
          <button id="back" class="icon" title="Back">${icon("arrow-left")}</button>
          <div class="title">Settings</div>
        </div>`;
      $("back").addEventListener("click", () => this._setView({ name: "list" }));
    } else if (view.name === "receipts") {
      this._top.innerHTML = `
        <div class="header">
          <button id="back" class="icon" title="Back">${icon("arrow-left")}</button>
          <div class="title">Receipts</div>
          <button id="recCamera" class="icon" title="Add receipt photos">${icon("camera")}</button>
        </div>`;
      $("back").addEventListener("click", () => this._setView({ name: "trip", id: view.tripId }));
      $("recCamera").addEventListener("click", () => this._pickPhotos((files) => this._addReceiptPhotos(view.tripId, files)));
    }
    this._render();
  }

  _render() {
    if (!this._data) return;
    if (this._view.name === "list") this._renderList();
    else if (this._view.name === "trips") this._renderTrips();
    else if (this._view.name === "trip") this._renderTrip();
    else if (this._view.name === "receipts") this._renderReceipts();
    else if (this._view.name === "settings") this._renderSettings();
    if (this._editors.length) this._refreshEditor();
    if (this._viewer) this._refreshViewer();
  }

  // ── Shopping list view ──────────────────────────────────────────────────

  _renderList() {
    const list = this._currentList();
    if (!list) return;
    const $ = (id) => this.shadowRoot.getElementById(id);

    $("list").innerHTML = this._data.lists
      .map((l) => `<option value="${esc(l.id)}"${l.id === list.id ? " selected" : ""}>${esc(l.name)}</option>`)
      .join("");

    const items = this._data.items.filter((i) => i.list_id === list.id);
    $("names").innerHTML = [...new Set(items.map((i) => i.name))]
      .sort((a, b) => a.localeCompare(b))
      .map((n) => `<option value="${esc(n)}"></option>`)
      .join("");

    const pending = items.filter((i) => !i.is_purchased).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const crossed = items.filter((i) => i.is_purchased).sort((a, b) => (b.purchased_at || 0) - (a.purchased_at || 0));

    let html = "";
    if (pending.length === 0) html += `<div class="empty">Your list is empty<br>Add items above</div>`;
    html += pending.map((i) => this._itemRowHtml(i)).join("");
    if (pending.length) html += `<div class="hint">Swipe right ✓ bought · Swipe left ✗ not bought</div>`;
    if (crossed.length) {
      html += `<div class="section">CROSSED OFF</div>`;
      html += `<button class="link" id="deleteCrossed">Delete all crossed-off items</button>`;
      html += crossed.map((i) => this._itemRowHtml(i)).join("");
    }
    this._body.innerHTML = html;

    this._body.querySelectorAll(".row-wrap").forEach((wrap) => {
      const item = items.find((i) => i.id === wrap.dataset.id);
      if (item) this._wireItemRow(wrap, item);
    });
    const del = $("deleteCrossed");
    if (del) del.addEventListener("click", () => this._deleteCrossed(list));

    // Finish Shopping: crossed off as bought and not yet saved in a trip
    const bought = items.filter((i) => i.is_purchased && !i.is_skipped && i.in_trip !== false).length;
    this._footer.innerHTML = bought
      ? `<button id="finish" class="finish">${icon("check")} Finish Shopping (${bought})</button>`
      : "";
    if (bought) $("finish").addEventListener("click", () => this._finishShopping(list, bought));
  }

  _itemRowHtml(item) {
    const qty = item.unit ? `(${item.quantity} ${item.unit})` : item.quantity > 1 ? `(${item.quantity})` : "";
    const price = item.last_unit_price != null ? money(item.last_unit_price) : "";
    return `
      <div class="row-wrap" data-id="${esc(item.id)}">
        <div class="swipe-bg"><span class="lbl"></span></div>
        <div class="row${item.is_purchased ? " crossed" : ""}">
          <div class="text">
            <div class="name">${esc(item.name)}</div>
            ${qty ? `<div class="qty">${esc(qty)}</div>` : ""}
          </div>
          ${price ? `<div class="price">${esc(price)}</div>` : ""}
          <button class="info" title="Item details">${icon("information-outline")}</button>
        </div>
      </div>`;
  }

  /** Tap: pending → bought, crossed → back on the list. Swipe (pending only): right bought, left not bought. */
  _wireItemRow(wrap, item) {
    const row = wrap.querySelector(".row");
    const bg = wrap.querySelector(".swipe-bg");
    const lbl = wrap.querySelector(".lbl");
    const canSwipe = !item.is_purchased;
    let startX = 0, startY = 0, dx = 0, tracking = false, swiping = false, suppressClick = false;

    // The info button opens item details and must not count as a tap or swipe on the row
    const info = wrap.querySelector(".info");
    info.addEventListener("pointerdown", (e) => e.stopPropagation());
    info.addEventListener("click", (e) => {
      e.stopPropagation();
      this._openItemDetail(item.id);
    });

    const reset = (animate) => {
      row.style.transition = animate ? "transform .15s ease-out" : "";
      row.style.transform = "";
      bg.style.visibility = "hidden";
    };

    row.addEventListener("pointerdown", (e) => {
      if (!canSwipe) return;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      tracking = true;
      swiping = false;
      row.style.transition = "";
    });

    row.addEventListener("pointermove", (e) => {
      if (!tracking) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (!swiping) {
        if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) {
          swiping = true;
          row.setPointerCapture(e.pointerId);
        } else if (Math.abs(my) > 10) {
          tracking = false;
          return;
        } else return;
      }
      dx = mx;
      row.style.transform = `translateX(${dx}px)`;
      bg.style.visibility = "visible";
      bg.style.background = dx > 0 ? GREEN : ORANGE;
      bg.style.justifyContent = dx > 0 ? "flex-start" : "flex-end";
      lbl.textContent = dx > 0 ? "✓  Bought" : "Not bought  ✗";
    });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!swiping) return;
      suppressClick = true;
      const width = row.offsetWidth;
      if (Math.abs(dx) > width * 0.35) {
        row.style.transition = "transform .15s ease-out";
        row.style.transform = `translateX(${dx > 0 ? width : -width}px)`;
        this._ws("item/set_state", { item_id: item.id, state: dx > 0 ? "bought" : "skipped" });
      } else {
        reset(true);
      }
    };
    row.addEventListener("pointerup", end);
    row.addEventListener("pointercancel", () => {
      tracking = false;
      reset(true);
    });

    row.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      this._ws("item/set_state", { item_id: item.id, state: item.is_purchased ? "pending" : "bought" });
    });
  }

  async _addItem() {
    const input = this.shadowRoot.getElementById("addInput");
    const name = input.value.trim();
    if (!name || !this._listId) return;
    input.value = "";
    await this._ws("item/add", { list_id: this._listId, name });
  }

  async _deleteCrossed(list) {
    const ok = await this._dialog({ title: "Delete all crossed-off items?", ok: "Delete" });
    if (ok) await this._ws("items/delete_crossed", { list_id: list.id });
  }

  async _finishShopping(list, bought) {
    const store = await this._dialog({
      title: "Finish shopping?",
      message: `Save ${bought} bought item${bought === 1 ? "" : "s"} as a trip in history.`,
      input: "Store (optional)",
      optional: true,
      ok: "Save Trip",
    });
    if (store !== null) await this._ws("finish", { list_id: list.id, store });
  }

  async _listMenu() {
    const list = this._currentList();
    const choice = await this._dialog({
      title: "Lists",
      choices: [
        ["new", "New list"],
        ["rename", `Rename “${list?.name ?? ""}”`],
        ["delete", `Delete “${list?.name ?? ""}”`],
        ["export", "Export list (CSV)"],
        ["import", "Import list (CSV)"],
        ["settings", "Settings"],
      ],
    });
    if (choice === "export" && list) this._exportList(list);
    else if (choice === "import" && list) this._pickFile("csvFile", (file) => this._importList(list, file));
    else if (choice === "settings") this._setView({ name: "settings" });
    else if (choice === "new") {
      const name = await this._dialog({ title: "New List", input: "List name", ok: "Create" });
      if (name) {
        const created = await this._ws("list/create", { name });
        if (created) {
          this._listId = created.id;
          this._render();
        }
      }
    } else if (choice === "rename" && list) {
      const name = await this._dialog({ title: "Rename List", input: "List name", value: list.name, ok: "Save" });
      if (name) await this._ws("list/rename", { list_id: list.id, name });
    } else if (choice === "delete" && list) {
      const ok = await this._dialog({
        title: `Delete “${list.name}”?`,
        message: "All items in this list will be deleted.",
        ok: "Delete",
      });
      if (ok) {
        await this._ws("list/delete", { list_id: list.id });
        this._listId = null;
      }
    }
  }

  // ── Settings, export and import ─────────────────────────────────────────

  _renderSettings() {
    this._footer.innerHTML = "";
    const backend = this._data.version || "unknown";
    const mismatch = backend !== CARD_VERSION;
    this._body.innerHTML = `
      <div class="section">ABOUT</div>
      <div class="srow"><span>Card version</span><span class="sval">${esc(CARD_VERSION)}</span></div>
      <div class="srow"><span>Integration version</span><span class="sval">${esc(backend)}</span></div>
      ${
        mismatch
          ? `<div class="warn">These versions differ. Restart Home Assistant, then refresh this page
             (in the Companion app: Settings → Companion app → Debugging → Reset frontend cache).</div>`
          : ""
      }
      <div class="section">DATA</div>
      <button id="importAndroid" class="srow tapr"${this._importing ? " disabled" : ""}>
        <span>Import from Android backup<br><span class="sval small">The .zip from the Android app's Settings → Export everything</span></span>
        ${icon("upload")}
      </button>
      ${this._importStatus ? `<div class="hint status">${esc(this._importStatus)}</div>` : ""}`;
    const btn = this.shadowRoot.getElementById("importAndroid");
    btn.addEventListener("click", () => {
      if (!this._importing) this._pickFile("zipFile", (file) => this._importAndroid(file));
    });
  }

  _setImportStatus(text) {
    this._importStatus = text;
    if (this._view.name === "settings") this._render();
  }

  /**
   * Imports the Android app's "Export everything" zip: the data goes up first, then each receipt and item photo
   * is shrunk and uploaded on its own, so no single upload is too big for Home Assistant.
   */
  async _importAndroid(file) {
    this._importing = true;
    try {
      this._setImportStatus("Opening backup…");
      const JSZip = await loadScript(JSZIP_URL, "JSZip", "backup reader");
      const zip = await JSZip.loadAsync(file);
      const json = zip.file("backup.json");
      if (!json) throw new Error("That zip isn't a Shopping List backup (no backup.json inside).");
      const backup = JSON.parse(await json.async("string"));

      this._setImportStatus("Importing lists, items and trips…");
      const res = await this._hass.fetchWithAuth("/api/shopping_trips/import_android", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || `Import failed (${res.status})`);

      const receipts = (backup.receipts || []).filter((r) => r.file && result.trips[r.trip_id] && zip.file(r.file));
      const photos = (backup.items || []).filter((i) => i.photo && result.items[i.id] && zip.file(i.photo));
      let failed = 0;
      for (const [n, r] of receipts.entries()) {
        this._setImportStatus(`Uploading receipt ${n + 1} of ${receipts.length}…`);
        try {
          const form = new FormData();
          form.append("trip_id", result.trips[r.trip_id]);
          form.append("text", r.text || "");
          if (r.scanned_at) form.append("scanned_at", String(r.scanned_at));
          form.append("image", await shrinkImage(await zip.file(r.file).async("blob")), "receipt.jpg");
          const up = await this._hass.fetchWithAuth("/api/shopping_trips/receipt", { method: "POST", body: form });
          if (!up.ok) failed++;
        } catch (e) {
          failed++;
        }
      }
      for (const [n, i] of photos.entries()) {
        this._setImportStatus(`Uploading item photo ${n + 1} of ${photos.length}…`);
        try {
          const form = new FormData();
          form.append("item_id", result.items[i.id]);
          form.append("image", await shrinkImage(await zip.file(i.photo).async("blob"), 1600), "photo.jpg");
          const up = await this._hass.fetchWithAuth("/api/shopping_trips/item_photo", { method: "POST", body: form });
          if (!up.ok) failed++;
        } catch (e) {
          failed++;
        }
      }

      const c = result.counts;
      this._setImportStatus("");
      await this._dialog({
        title: "Import finished",
        message:
          `Added ${c.items} items (in ${c.lists} lists), ${c.trips} trips with ${c.trip_items} trip items, ` +
          `${receipts.length + c.text_only_receipts} receipts and ${photos.length} item photos.` +
          (failed ? ` ${failed} image${failed === 1 ? "" : "s"} couldn't be uploaded.` : "") +
          " Items already in Home Assistant were kept as they were.",
        cancel: null,
      });
    } catch (err) {
      this._setImportStatus("");
      await this._dialog({ title: "Import failed", message: err.message || String(err), cancel: null });
    } finally {
      this._importing = false;
      if (this._view.name === "settings") this._render();
    }
  }

  _pickFile(inputId, callback) {
    this._fileTarget = callback;
    this.shadowRoot.getElementById(inputId).click();
  }

  /** Exports a list as CSV in the Android app's format; uses the share sheet where available. */
  async _exportList(list) {
    const items = this._data.items.filter((i) => i.list_id === list.id).sort((a, b) => a.name.localeCompare(b.name));
    const rows = [
      csvField(`Shopping List: ${list.name}`),
      "name,quantity,unit,notes,purchased",
      ...items.map((i) => [i.name, i.quantity, i.unit || "", i.notes || "", i.is_purchased].map(csvField).join(",")),
    ];
    const name = `${list.name.replace(/[\\/:*?"<>|]/g, "_")}.csv`;
    const file = new File([rows.join("\n") + "\n"], name, { type: "text/csv" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Shopping List: ${list.name}` });
        return;
      }
    } catch (e) {
      if (e.name === "AbortError") return; // share sheet closed
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** Imports a CSV exported by this card or the Android app (a plain name,quantity,unit,notes file works too). */
  async _importList(list, file) {
    let records = parseCsv(await file.text()).filter((r) => r.some((f) => f.trim()));
    if (records[0]?.[0]?.startsWith("Shopping List:")) records = records.slice(1);
    if (records[0]?.[0]?.trim().toLowerCase() === "name") records = records.slice(1);
    const items = records
      .filter((r) => r[0]?.trim())
      .map((r) => {
        const row = { name: r[0].trim(), quantity: Math.max(1, parseInt(r[1], 10) || 1) };
        if (r[2]?.trim()) row.unit = r[2].trim();
        if (r[3]?.trim()) row.notes = r[3].trim();
        return row;
      });
    if (!items.length) {
      await this._dialog({ title: "Nothing to import", message: "No items were found in that file.", cancel: null });
      return;
    }
    const result = await this._ws("items/import", { list_id: list.id, items });
    if (result) await this._dialog({ title: `Imported ${result.count} item${result.count === 1 ? "" : "s"}`, cancel: null });
  }

  // ── Item details (the ⓘ button) ─────────────────────────────────────────

  /** Full-screen details for a shopping list item; changes are kept until Save. */
  _openItemDetail(itemId) {
    const item = this._data.items.find((i) => i.id === itemId);
    if (!item) return;
    const draft = {
      quantity: item.quantity || 1,
      category: item.category || "",
      list_id: item.list_id,
      is_favourite: !!item.is_favourite,
    };
    this._panelEl.innerHTML = `
      <div class="ed-top">
        <button id="idBack" class="icon" title="Back without saving">${icon("arrow-left")}</button>
        <div class="title">Item</div>
        <button id="idDelete" class="icon" title="Delete item">${icon("delete")}</button>
        <button id="idSave" class="primary">Save</button>
      </div>
      <div class="ed-body">
        <input id="idName" class="big" placeholder="Item name" value="${esc(item.name)}" autocomplete="off">
        <div class="qtyrow">
          <button id="idFewer" class="outline">− FEWER</button>
          <div id="idQty" class="qtyval"></div>
          <button id="idMore" class="outline">+ MORE</button>
          <button id="idFav" class="icon fav" title="Favourite"></button>
        </div>
        <button id="idCategory" class="field"></button>
        <button id="idList" class="field"></button>
        ${item.last_unit_price != null ? `<div class="field static">LAST UNIT PRICE: ${esc(money(item.last_unit_price))}</div>` : ""}
        ${(() => {
          // Newest trip with an item of this name (case-insensitive)
          const name = item.name.toLowerCase();
          const tripIds = new Set(this._data.records.filter((r) => r.name.toLowerCase() === name).map((r) => r.trip_id));
          const last = Math.max(...this._data.trips.filter((t) => tripIds.has(t.id)).map((t) => t.finished_at));
          return Number.isFinite(last)
            ? `<div class="field static">LAST PURCHASED: ${esc(shortDate(last).toUpperCase())}</div>
               <button id="idHistory" class="field">PURCHASE HISTORY</button>`
            : "";
        })()}
        <div class="barrow">
          <input id="idBarcode" placeholder="Barcode" inputmode="numeric" value="${esc(item.barcode || "")}" autocomplete="off">
          <button id="idScan" class="outline">${icon("barcode-scan")} SCAN</button>
        </div>
        <textarea id="idNotes" class="notes" placeholder="Note" rows="3">${esc(item.notes || "")}</textarea>
        <div class="section">PHOTO</div>
        <div class="photorow">
          <button id="idTake" class="outline">${icon("camera")} TAKE PHOTO</button>
          <button id="idChoose" class="outline">${icon("image")} CHOOSE PHOTO</button>
        </div>
        <div id="idStatus" class="hint status hidden"></div>
        <img id="idPhoto" class="itemphoto hidden" alt="Item photo">
        <button id="idRemovePhoto" class="link hidden">Remove photo</button>
      </div>`;
    this._panelEl.classList.remove("hidden");
    const $ = (id) => this.shadowRoot.getElementById(id);

    const show = () => {
      $("idQty").textContent = `Quantity: ${draft.quantity}`;
      $("idFewer").disabled = draft.quantity <= 1;
      $("idFav").innerHTML = icon(draft.is_favourite ? "star" : "star-outline");
      $("idFav").classList.toggle("on", draft.is_favourite);
      $("idCategory").textContent = `CATEGORY: ${(draft.category || "Uncategorized").toUpperCase()}`;
      const list = this._data.lists.find((l) => l.id === draft.list_id);
      $("idList").textContent = `LIST: ${(list?.name || "").toUpperCase()}`;
    };
    show();

    $("idBack").addEventListener("click", () => this._closePanel());
    $("idHistory")?.addEventListener("click", () => this._openItemHistory(item.name));
    $("idFewer").addEventListener("click", () => {
      if (draft.quantity > 1) draft.quantity--;
      show();
    });
    $("idMore").addEventListener("click", () => {
      draft.quantity++;
      show();
    });
    $("idFav").addEventListener("click", () => {
      draft.is_favourite = !draft.is_favourite;
      show();
    });
    $("idCategory").addEventListener("click", async () => {
      const categories = [...new Set(this._data.items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const choice = await this._dialog({
        title: "Category",
        choices: [["none", "Uncategorized"], ...categories.map((c) => [`c:${c}`, c]), ["new", "New category…"]],
      });
      if (choice === null) return;
      if (choice === "new") {
        const name = await this._dialog({ title: "New Category", input: "Category name", ok: "OK" });
        if (name) draft.category = name;
      } else draft.category = choice.startsWith("c:") ? choice.slice(2) : "";
      show();
    });
    $("idList").addEventListener("click", async () => {
      const choice = await this._dialog({
        title: "Move to list",
        choices: this._data.lists.map((l) => [l.id, `${l.id === draft.list_id ? "✓ " : ""}${l.name}`]),
      });
      if (choice) {
        draft.list_id = choice;
        show();
      }
    });
    $("idDelete").addEventListener("click", async () => {
      if ((await this._ws("item/delete", { item_id: item.id })) !== undefined) this._closePanel();
    });

    // Photo and barcode take effect straight away; the other fields wait for Save
    const status = (text) => {
      $("idStatus").textContent = text;
      $("idStatus").classList.toggle("hidden", !text);
    };
    const showPhoto = async (photo) => {
      const img = $("idPhoto");
      if (!img) return;
      img.classList.toggle("hidden", !photo);
      $("idRemovePhoto").classList.toggle("hidden", !photo);
      if (photo) img.src = await this._signedUrl(`/api/shopping_trips/item_photo/${photo}`);
    };
    showPhoto(item.photo);
    const uploadPhoto = async (file) => {
      status("Saving photo…");
      try {
        const form = new FormData();
        form.append("item_id", item.id);
        form.append("image", await shrinkImage(file, 1600), "photo.jpg");
        const res = await this._hass.fetchWithAuth("/api/shopping_trips/item_photo", { method: "POST", body: form });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        await showPhoto((await res.json()).photo);
        status("");
      } catch (err) {
        status("");
        await this._dialog({ title: "Couldn't save the photo", message: err.message, cancel: null });
      }
    };
    $("idTake").addEventListener("click", () => this._pickFile("onePhotoCam", uploadPhoto));
    $("idChoose").addEventListener("click", () => this._pickFile("onePhoto", uploadPhoto));
    $("idRemovePhoto").addEventListener("click", async () => {
      if ((await this._ws("item/remove_photo", { item_id: item.id })) !== undefined) showPhoto(null);
    });
    $("idScan").addEventListener("click", () =>
      this._pickFile("onePhotoCam", async (file) => {
        status("Reading barcode…");
        let code = null;
        try {
          code = await decodeBarcode(file);
        } catch (err) {
          status("");
          await this._dialog({ title: "Couldn't read the barcode", message: err.message, cancel: null });
          return;
        }
        status("");
        if (code) $("idBarcode").value = code;
        else
          await this._dialog({
            title: "No barcode found",
            message: "Try again a little closer with the barcode flat and in focus, or type the number in.",
            cancel: null,
          });
      })
    );
    $("idSave").addEventListener("click", async () => {
      const name = $("idName").value.trim();
      if (!name) {
        $("idName").focus();
        return;
      }
      const saved = await this._ws("item/update", {
        item_id: item.id,
        name,
        quantity: draft.quantity,
        category: draft.category,
        list_id: draft.list_id,
        is_favourite: draft.is_favourite,
        notes: $("idNotes").value.trim(),
        barcode: $("idBarcode").value.trim() || null,
      });
      if (saved !== undefined) this._closePanel();
    });
  }

  /** Full screen over the item details: every purchase of an item with this name, newest trip first. */
  _openItemHistory(itemName) {
    const name = itemName.toLowerCase();
    const rows = this._data.records
      .filter((r) => r.name.toLowerCase() === name)
      .map((r) => ({ r, trip: this._trip(r.trip_id) }))
      .filter((x) => x.trip)
      .sort((a, b) => b.trip.finished_at - a.trip.finished_at);
    const sub = this.shadowRoot.getElementById("subpanel");
    sub.innerHTML = `
      <div class="ed-top">
        <button id="ihBack" class="icon" title="Back">${icon("arrow-left")}</button>
        <div class="title">${esc(itemName)}<div class="sub">Purchase history</div></div>
      </div>
      <div class="section hrow"><span>DATE</span><span>UNIT PRICE</span></div>
      <div class="ed-body flush">
        ${
          rows.length
            ? rows
                .map(
                  ({ r, trip }) => `
              <div class="hrow line">
                <span>${esc(dateText(trip.finished_at))}</span>
                <span class="${r.unit_price != null ? "hprice" : "hnone"}">${r.unit_price != null ? esc(money(r.unit_price)) : "—"}</span>
              </div>`
                )
                .join("")
            : `<div class="empty">No purchases yet</div>`
        }
      </div>`;
    sub.classList.remove("hidden");
    this.shadowRoot.getElementById("ihBack").addEventListener("click", () => {
      sub.classList.add("hidden");
      sub.innerHTML = "";
    });
  }

  // ── Trip history view ───────────────────────────────────────────────────

  _renderTrips() {
    this._footer.innerHTML = "";
    const q = this._search.trim().toLowerCase();
    const trips = [...this._data.trips]
      .filter(
        (t) =>
          !q ||
          (t.store || "").toLowerCase().includes(q) ||
          this._data.records.some((r) => r.trip_id === t.id && r.name.toLowerCase().includes(q))
      )
      .sort((a, b) => b.finished_at - a.finished_at);
    if (!trips.length) {
      this._body.innerHTML = q
        ? `<div class="empty">No trips match “${esc(this._search)}”</div>`
        : `<div class="empty">No shopping trips yet.<br>Swipe items right as you shop, then tap Finish Shopping.</div>`;
      return;
    }
    this._body.innerHTML = trips
      .map((t) => {
        const s = this._tripSummary(t);
        const title = t.store ? `${dateText(t.finished_at)} · ${t.store}` : dateText(t.finished_at);
        const sub = `${s.count} item${s.count === 1 ? "" : "s"}${s.unpriced ? ` · ${s.unpriced} need price` : ""}`;
        const hasReceipt = this._data.receipts.some((r) => r.trip_id === t.id);
        return `
          <div class="trip" data-id="${esc(t.id)}">
            ${hasReceipt ? `<span class="receipt-mark" title="Has receipts">${icon("camera")}</span>` : ""}
            <div class="text"><div class="name strong">${esc(title)}</div><div class="qty">${esc(sub)}</div></div>
            <div class="total">${s.total != null ? esc(money(s.total)) : ""}</div>
          </div>`;
      })
      .join("");
    this._body.querySelectorAll(".trip").forEach((el) =>
      el.addEventListener("click", () => this._setView({ name: "trip", id: el.dataset.id }))
    );
  }

  // ── Trip view ───────────────────────────────────────────────────────────

  /** Each item followed by its sub-items; with unpricedFirst, items still needing a price come first. */
  _tripRows(tripId) {
    const records = this._data.records.filter((r) => r.trip_id === tripId);
    const parents = records.filter((r) => !r.parent_id);
    let groups = parents.map((p) => {
      const kids = records.filter((r) => r.parent_id === p.id);
      const priced = kids.filter((k) => k.total != null);
      return {
        parent: p,
        kids,
        childTotal: priced.length ? priced.reduce((s, k) => s + k.total, 0) : null,
      };
    });
    if (this._unpricedFirst) {
      const needs = (g) =>
        g.kids.length
          ? g.kids.some((k) => k.unit_price == null && !k.total_override)
          : g.parent.unit_price == null && !g.parent.total_override;
      groups = [...groups.filter(needs), ...groups.filter((g) => !needs(g))];
      groups.forEach((g) => (g.kids = [...g.kids.filter((k) => k.unit_price == null), ...g.kids.filter((k) => k.unit_price != null)]));
    }
    return groups;
  }

  _recordRowHtml(r, { child = false, hasChildren = false, childTotal = null } = {}) {
    let qty = "";
    if (r.quantity !== 1 && r.unit_price != null && !hasChildren) qty = `${qtyText(r.quantity)} × ${money(r.unit_price)}`;
    else if (r.quantity !== 1) qty = `×${qtyText(r.quantity)}`;
    const amount = hasChildren ? childTotal : r.total;
    const price =
      amount != null ? `<div class="tprice">${esc(money(amount))}</div>` : hasChildren ? "" : `<div class="tprice hintc">+ price</div>`;
    return `
      <div class="trow${child ? " child" : ""}" data-id="${esc(r.id)}">
        <div class="tname">${esc(r.name)}</div>
        ${qty ? `<div class="tqty">${esc(qty)}</div>` : ""}
        ${price}
      </div>`;
  }

  _renderTrip() {
    const trip = this._trip(this._view.id);
    if (!trip) {
      this._setView({ name: "trips" });
      return;
    }
    this._footer.innerHTML = "";
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("tripTitle").textContent = trip.store || "Shopping Trip";
    $("tripSub").textContent = dateText(trip.finished_at);

    const groups = this._tripRows(trip.id);
    const s = this._tripSummary(trip);
    let html = `<div class="section">${s.count} ITEM${s.count === 1 ? "" : "S"}${
      s.total != null ? `  ·  TOTAL ${money(s.total)}` : ""
    }${s.unpriced ? `  ·  ${s.unpriced} NEED PRICE` : ""}</div>`;
    if (this._status) html += `<div class="hint status">${esc(this._status)}</div>`;
    if (!groups.length) html += `<div class="empty">No items in this trip<br>Tap + to add one</div>`;
    else html += `<div class="hint">Tap an item to edit${this._unpricedFirst ? " · Unpriced first" : ""}</div>`;
    html += groups
      .map(
        (g) =>
          this._recordRowHtml(g.parent, { hasChildren: g.kids.length > 0, childTotal: g.childTotal }) +
          g.kids.map((k) => this._recordRowHtml(k, { child: true })).join("")
      )
      .join("");
    this._body.innerHTML = html;
    this._body.querySelectorAll(".trow").forEach((el) =>
      el.addEventListener("click", () => {
        const r = this._record(el.dataset.id);
        if (r) this._openEditor({ tripId: trip.id, recordId: r.id, parentId: r.parent_id || null });
      })
    );
  }

  async _tripMenu(tripId) {
    const trip = this._trip(tripId);
    if (!trip) return;
    const receiptCount = this._data.receipts.filter((r) => r.trip_id === tripId).length;
    const choice = await this._dialog({
      title: "Trip",
      choices: [
        ["receipts", `Receipts (${receiptCount})`],
        ["unpriced", `${this._unpricedFirst ? "✓ " : ""}Unpriced first`],
        ["date", "Edit date"],
        ["store", "Edit store"],
        ["delete", "Delete trip"],
      ],
    });
    if (choice === "receipts") {
      this._setView({ name: "receipts", tripId });
    } else if (choice === "unpriced") {
      this._unpricedFirst = !this._unpricedFirst;
      this._render();
    } else if (choice === "date") {
      const d = new Date(trip.finished_at);
      const pad = (n) => String(n).padStart(2, "0");
      const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const picked = await this._dialog({ title: "Trip date", input: "Date", inputType: "date", value, ok: "Save" });
      if (picked) {
        const [y, m, day] = picked.split("-").map(Number);
        d.setFullYear(y, m - 1, day); // keeps the time of day
        await this._ws("trip/update", { trip_id: trip.id, finished_at: d.getTime() });
      }
    } else if (choice === "store") {
      const store = await this._dialog({ title: "Store", input: "Store", value: trip.store, optional: true, ok: "Save" });
      if (store !== null) await this._ws("trip/update", { trip_id: trip.id, store });
    } else if (choice === "delete") {
      const ok = await this._dialog({
        title: "Delete this trip?",
        message: "The trip and all its items will be removed from history.",
        ok: "Delete",
      });
      if (ok && (await this._ws("trip/delete", { trip_id: trip.id })) !== undefined) this._setView({ name: "trips" });
    }
  }

  // ── Receipts ────────────────────────────────────────────────────────────

  /** Opens the photo picker (on phones it offers the camera or the gallery); several photos can be chosen. */
  _pickPhotos(callback) {
    this._photoTarget = callback;
    this.shadowRoot.getElementById("tripPhotos").click();
  }

  _setStatus(text) {
    this._status = text;
    this._render();
  }

  async _uploadReceipt(tripId, blob, text = "") {
    const form = new FormData();
    form.append("trip_id", tripId);
    form.append("text", text);
    form.append("image", blob, "receipt.jpg");
    const res = await this._hass.fetchWithAuth("/api/shopping_trips/receipt", { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return res.json();
  }

  /** A signed URL for one of our image endpoints, so it can be shown in an <img> without a login header. */
  async _signedUrl(path) {
    const cached = this._signed[path];
    if (cached && cached.exp > Date.now()) return cached.url;
    const res = await this._hass.callWS({ type: "auth/sign_path", path, expires: 3600 });
    const url = this._hass.hassUrl(res.path);
    this._signed[path] = { url, exp: Date.now() + 3500 * 1000 };
    return url;
  }

  _imageUrl(receiptId) {
    return this._signedUrl(`/api/shopping_trips/receipt/${receiptId}`);
  }

  /** Saves each photo to the trip, then reads its text in the background and saves that too. */
  async _addReceiptPhotos(tripId, files) {
    for (const [i, file] of files.entries()) {
      const n = files.length > 1 ? ` ${i + 1} of ${files.length}` : "";
      this._setStatus(`Saving receipt${n}…`);
      const blob = await shrinkImage(file);
      let receipt;
      try {
        receipt = await this._uploadReceipt(tripId, blob);
      } catch (err) {
        this._setStatus("");
        await this._dialog({ title: "Couldn't save the receipt", message: err.message, cancel: null });
        return;
      }
      this._setStatus(`Reading receipt${n}…`);
      try {
        const text = await readReceiptText(blob);
        if (text.trim()) await this._ws("receipt/set_text", { receipt_id: receipt.id, text });
      } catch (err) {
        // The text can still be read later from the receipt viewer
      }
    }
    this._setStatus("");
  }

  _renderReceipts() {
    const tripId = this._view.tripId;
    if (!this._trip(tripId)) {
      this._setView({ name: "trips" });
      return;
    }
    this._footer.innerHTML = "";
    const receipts = this._data.receipts.filter((r) => r.trip_id === tripId).sort((a, b) => b.scanned_at - a.scanned_at);
    let html = this._status ? `<div class="hint status">${esc(this._status)}</div>` : "";
    if (!receipts.length) html += `<div class="empty">No receipts for this trip yet.<br>Tap the camera to add photos.</div>`;
    html += receipts
      .map(
        (r) => `
        <div class="rcard" data-id="${esc(r.id)}">
          <div class="section rhead">
            <span>SCANNED ${esc(dateText(r.scanned_at).toUpperCase())}</span>
            <button class="icon light" data-del="${esc(r.id)}" title="Delete receipt">${icon("delete")}</button>
          </div>
          <img class="rimg" data-img="${esc(r.id)}" alt="Receipt">
        </div>`
      )
      .join("");
    this._body.innerHTML = html;
    this._body.querySelectorAll("img.rimg").forEach((img) => {
      img.addEventListener("error", () => img.replaceWith(Object.assign(document.createElement("div"), {
        className: "empty", textContent: "Image no longer available",
      })));
      this._imageUrl(img.dataset.img).then((url) => (img.src = url)).catch(() => img.dispatchEvent(new Event("error")));
    });
    this._body.querySelectorAll(".rcard").forEach((card) =>
      card.addEventListener("click", (e) => {
        const del = e.target.closest("[data-del]");
        if (del) this._ws("receipt/delete", { receipt_id: del.dataset.del });
        else this._openViewer(card.dataset.id);
      })
    );
  }

  // ── Receipt viewer: zoomable image, and its text with lines mapped to trip items ──

  _openViewer(receiptId) {
    this._viewer = { receiptId, showText: false, mapped: {} };
    this._panelEl.innerHTML = `
      <div class="ed-top">
        <button id="vBack" class="icon" title="Back">${icon("arrow-left")}</button>
        <div class="title">Receipt</div>
        <button id="vToggle" class="primary">TEXT</button>
      </div>
      <div id="vImageWrap" class="zoom">
        <img id="vImg" draggable="false" alt="Receipt">
        <div id="vImgMsg" class="empty hidden">Image no longer available</div>
      </div>
      <div id="vText" class="ed-body hidden">
        <div class="hint">Tap a line with a price to choose its trip item</div>
        <button id="vFill" class="outline">Fill prices automatically</button>
        <div id="vStatus" class="empty hidden"></div>
        <div id="vLines"></div>
      </div>`;
    this._panelEl.classList.remove("hidden");
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("vBack").addEventListener("click", () => this._closePanel());
    $("vToggle").addEventListener("click", () => this._toggleViewerText());
    $("vFill").addEventListener("click", () => this._fillPrices());
    const img = $("vImg");
    img.addEventListener("error", () => {
      img.classList.add("hidden");
      $("vImgMsg").classList.remove("hidden");
    });
    this._imageUrl(receiptId).then((url) => (img.src = url)).catch(() => img.dispatchEvent(new Event("error")));
    this._wireZoom($("vImageWrap"), img);
  }

  _closePanel() {
    if (this._newTrip) this._newTrip.photos.forEach((p) => URL.revokeObjectURL(p.url));
    this._viewer = null;
    this._newTrip = null;
    this._panelEl.classList.add("hidden");
    this._panelEl.innerHTML = "";
  }

  _toggleViewerText() {
    const v = this._viewer;
    v.showText = !v.showText;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("vToggle").textContent = v.showText ? "IMAGE" : "TEXT";
    $("vImageWrap").classList.toggle("hidden", v.showText);
    $("vText").classList.toggle("hidden", !v.showText);
    if (v.showText) this._ensureReceiptText();
  }

  /** Shows the receipt's text, reading it from the image first if it hasn't been read yet. */
  async _ensureReceiptText() {
    const v = this._viewer;
    const receipt = this._data.receipts.find((r) => r.id === v.receiptId);
    if (!receipt) return;
    if (receipt.text.trim()) {
      this._renderViewerLines();
      return;
    }
    if (v.reading) return;
    v.reading = true;
    const status = this.shadowRoot.getElementById("vStatus");
    status.textContent = "Reading text…";
    status.classList.remove("hidden");
    try {
      const blob = await (await fetch(await this._imageUrl(receipt.id))).blob();
      const text = await readReceiptText(blob);
      if (!text.trim()) throw new Error("No text could be read from this image.");
      await this._ws("receipt/set_text", { receipt_id: receipt.id, text });
      status.classList.add("hidden");
    } catch (err) {
      status.textContent = err.message || String(err);
    } finally {
      v.reading = false;
    }
  }

  _refreshViewer() {
    const v = this._viewer;
    if (!v) return;
    if (!this._data.receipts.some((r) => r.id === v.receiptId)) {
      this._closePanel();
      return;
    }
    if (v.showText) this._renderViewerLines();
  }

  _viewerLines() {
    const receipt = this._data.receipts.find((r) => r.id === this._viewer.receiptId);
    return (receipt?.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  }

  _renderViewerLines() {
    const v = this._viewer;
    const lines = this._viewerLines();
    const box = this.shadowRoot.getElementById("vLines");
    if (!box) return;
    box.innerHTML = lines
      .map((line, i) => {
        const { price } = parseReceiptLine(line);
        return `
          <div class="lrow${price != null ? " tap" : ""}" data-i="${i}">
            <div class="lline"><span class="ltext">${esc(line)}</span>${price != null ? `<span class="lprice">${esc(money(price))}</span>` : ""}</div>
            ${v.mapped[i] ? `<div class="lmapped">→ ${esc(v.mapped[i])}</div>` : ""}
          </div>`;
      })
      .join("");
    box.querySelectorAll(".lrow.tap").forEach((row) =>
      row.addEventListener("click", () => this._mapLine(Number(row.dataset.i)))
    );
  }

  /** Puts a line's amount on a trip item the user picks: the line is the item's total, unit price = total ÷ quantity. */
  async _mapLine(index) {
    const v = this._viewer;
    const line = this._viewerLines()[index];
    const { price } = parseReceiptLine(line);
    const receipt = this._data.receipts.find((r) => r.id === v.receiptId);
    if (price == null || !receipt) return;
    const records = this._leaves(this._data.records.filter((r) => r.trip_id === receipt.trip_id));
    if (!records.length) {
      await this._dialog({ title: "No items yet", message: "Add items to this trip first.", cancel: null });
      return;
    }
    const choice = await this._dialog({
      title: `${money(price)} → which item?`,
      choices: records.map((r) => [r.id, r.total != null ? `${r.name} (${money(r.total)})` : r.name]),
    });
    const record = choice && this._record(choice);
    if (!record) return;
    const saved = await this._ws("record/save", this._pricedParams(record, price));
    if (saved) {
      v.mapped[index] = record.name;
      this._renderViewerLines();
    }
  }

  _pricedParams(record, lineTotal) {
    const params = {
      trip_id: record.trip_id,
      record_id: record.id,
      name: record.name,
      quantity: record.quantity,
      unit_price: record.quantity > 0 ? lineTotal / record.quantity : lineTotal,
    };
    if (record.parent_id) params.parent_id = record.parent_id;
    return params;
  }

  /** Matches priced lines to unpriced items whose name words all appear on the line (or the other way round). */
  async _fillPrices() {
    const v = this._viewer;
    const receipt = this._data.receipts.find((r) => r.id === v.receiptId);
    if (!receipt) return;
    if (!receipt.text.trim()) {
      await this._dialog({ title: "No text yet", message: "Wait for the receipt text to be read.", cancel: null });
      return;
    }
    const pool = this._leaves(this._data.records.filter((r) => r.trip_id === receipt.trip_id)).filter(
      (r) => r.unit_price == null && !r.total_override
    );
    let filled = 0;
    const lines = this._viewerLines();
    for (const [i, line] of lines.entries()) {
      const { price } = parseReceiptLine(line);
      if (price == null || !looksLikeItemLine(line)) continue;
      const lw = words(line);
      const match = pool.find((r) => {
        const iw = words(r.name);
        return iw.size > 0 && (containsAll(lw, iw) || containsAll(iw, lw));
      });
      if (!match) continue;
      if (await this._ws("record/save", this._pricedParams(match, price))) {
        pool.splice(pool.indexOf(match), 1);
        v.mapped[i] = match.name;
        filled++;
      }
    }
    this._renderViewerLines();
    await this._dialog({
      title: `Filled ${filled} price${filled === 1 ? "" : "s"}`,
      message: filled ? "" : "No unpriced items matched the receipt lines. Tap a line to choose its item.",
      cancel: null,
    });
  }

  /** Pinch to zoom, drag to pan when zoomed, double-tap to zoom in 3× or back to fit. */
  _wireZoom(container, img) {
    let s = 1, x = 0, y = 0;
    const pts = new Map();
    let startDist = 0, startScale = 1, lastTap = 0, moved = false;
    const clamp = () => {
      s = Math.min(8, Math.max(1, s));
      const mx = (container.clientWidth * (s - 1)) / 2;
      const my = (container.clientHeight * (s - 1)) / 2;
      x = Math.min(mx, Math.max(-mx, x));
      y = Math.min(my, Math.max(-my, y));
    };
    const apply = () => {
      clamp();
      img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    };
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    container.addEventListener("pointerdown", (e) => {
      container.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pts.size === 2) {
        startDist = dist();
        startScale = s;
      }
    });
    container.addEventListener("pointermove", (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 2) moved = true;
      pts.set(e.pointerId, cur);
      if (pts.size === 2 && startDist > 0) {
        s = (startScale * dist()) / startDist;
        apply();
      } else if (pts.size === 1 && s > 1) {
        x += cur.x - prev.x;
        y += cur.y - prev.y;
        apply();
      }
    });
    const up = (e) => {
      const wasSingle = pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) startDist = 0;
      if (!wasSingle || moved) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        if (s > 1.05) {
          s = 1;
          x = 0;
          y = 0;
        } else {
          // Zoom in around the tapped point
          const rect = container.getBoundingClientRect();
          const cx = e.clientX - rect.left - rect.width / 2;
          const cy = e.clientY - rect.top - rect.height / 2;
          s = 3;
          x = -cx * (s - 1);
          y = -cy * (s - 1);
        }
        apply();
        lastTap = 0;
      } else lastTap = now;
    };
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", (e) => pts.delete(e.pointerId));
  }

  // ── New trip from receipt photos ────────────────────────────────────────

  _openNewTrip() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    this._newTrip = { photos: [], lines: [], reading: 0 };
    this._panelEl.innerHTML = `
      <div class="ed-top">
        <button id="ntBack" class="icon" title="Back without creating">${icon("arrow-left")}</button>
        <div class="title">New Trip from Receipt</div>
        <button id="ntCreate" class="primary">Create</button>
      </div>
      <div class="ed-body">
        <input id="ntStore" class="big" placeholder="Store (optional)" autocomplete="off">
        <div class="ed-row"><label>Date<input id="ntDate" type="date" value="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}"></label></div>
        <button id="ntAdd" class="outline">${icon("camera")} ADD RECEIPT PHOTOS</button>
        <div id="ntThumbs" class="thumbs"></div>
        <div class="section">ITEMS (TICK THE ONES TO INCLUDE)</div>
        <div id="ntStatus" class="hint"></div>
        <div id="ntLines"></div>
      </div>`;
    this._panelEl.classList.remove("hidden");
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("ntBack").addEventListener("click", () => this._closePanel());
    $("ntAdd").addEventListener("click", () => this._pickPhotos((files) => this._addNewTripPhotos(files)));
    $("ntCreate").addEventListener("click", () => this._createTripFromReceipt());
    this._renderNewTrip();
  }

  _renderNewTrip() {
    const nt = this._newTrip;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!nt || !$("ntThumbs")) return;
    $("ntThumbs").innerHTML = nt.photos
      .map((p, i) => `<img class="thumb" src="${esc(p.url)}" data-i="${i}" alt="Receipt photo (tap to remove)">`)
      .join("");
    $("ntThumbs").querySelectorAll(".thumb").forEach((t) => t.addEventListener("click", () => this._removeNewTripPhoto(Number(t.dataset.i))));
    $("ntStatus").textContent = nt.reading
      ? "Reading text…"
      : !nt.photos.length
      ? "Add one or more photos of the receipt"
      : !nt.lines.length
      ? "No items detected"
      : "Tap a line to tick or untick it";
    $("ntLines").innerHTML = nt.lines
      .map(
        (l, i) => `
        <div class="nrow${l.include ? " on" : ""}" data-i="${i}">
          <span class="tick">${l.include ? icon("checkbox-marked") : icon("checkbox-blank-outline")}</span>
          <span class="ltext">${esc(l.name)}</span>
          ${l.price != null ? `<span class="lprice">${esc(money(l.price))}</span>` : ""}
        </div>`
      )
      .join("");
    $("ntLines").querySelectorAll(".nrow").forEach((row) =>
      row.addEventListener("click", () => {
        const line = nt.lines[Number(row.dataset.i)];
        line.include = !line.include;
        this._renderNewTrip();
      })
    );
  }

  /** Adds photos and reads each one; lines with a price that look like items are ticked. */
  async _addNewTripPhotos(files) {
    const nt = this._newTrip;
    for (const file of files) {
      const blob = await shrinkImage(file);
      const photo = { blob, url: URL.createObjectURL(blob), text: null };
      nt.photos.push(photo);
      nt.reading++;
      this._renderNewTrip();
      try {
        photo.text = await readReceiptText(blob);
      } catch (err) {
        photo.text = "";
        await this._dialog({ title: "Couldn't read the receipt", message: err.message || String(err), cancel: null });
      }
      nt.reading--;
      if (this._newTrip !== nt || !nt.photos.includes(photo)) return;
      for (const raw of photo.text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const { name, price } = parseReceiptLine(line);
        if (name) nt.lines.push({ photo, name, price, include: price != null && looksLikeItemLine(line) });
      }
      this._renderNewTrip();
    }
  }

  async _removeNewTripPhoto(index) {
    const nt = this._newTrip;
    const photo = nt.photos[index];
    const ok = await this._dialog({ title: "Remove this photo?", message: "Its detected items are removed too.", ok: "Remove" });
    if (!ok || this._newTrip !== nt) return;
    nt.photos.splice(nt.photos.indexOf(photo), 1);
    nt.lines = nt.lines.filter((l) => l.photo !== photo);
    URL.revokeObjectURL(photo.url);
    this._renderNewTrip();
  }

  async _createTripFromReceipt() {
    const nt = this._newTrip;
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!nt.photos.length) {
      await this._dialog({ title: "Add a receipt photo first", cancel: null });
      return;
    }
    if (nt.reading) {
      await this._dialog({ title: "Still reading the receipt…", cancel: null });
      return;
    }
    const when = new Date();
    const [y, m, d] = ($("ntDate").value || "").split("-").map(Number);
    if (y && m && d) when.setFullYear(y, m - 1, d);
    const trip = await this._ws("trip/create", {
      store: $("ntStore").value.trim(),
      finished_at: when.getTime(),
      list_id: this._listId,
      items: nt.lines.filter((l) => l.include).map((l) => (l.price != null ? { name: l.name, price: l.price } : { name: l.name })),
    });
    if (!trip) return;
    $("ntCreate").disabled = true;
    $("ntStatus").textContent = "Saving receipt photos…";
    for (const photo of nt.photos) {
      try {
        await this._uploadReceipt(trip.id, photo.blob, photo.text || "");
      } catch (err) {
        await this._dialog({ title: "A receipt photo couldn't be saved", message: err.message, cancel: null });
      }
    }
    this._closePanel();
    this._setView({ name: "trip", id: trip.id });
  }

  // ── Full-screen item editor ─────────────────────────────────────────────

  _openEditor(state) {
    this._editors.push({ ...state, override: false });
    this._showEditor();
  }

  _closeEditor() {
    this._editors.pop();
    if (this._editors.length) this._showEditor();
    else {
      this._editorEl.classList.add("hidden");
      this._editorEl.innerHTML = "";
    }
  }

  /** Builds the editor for the top of the stack, filled from saved data. */
  _showEditor() {
    const ed = this._editors[this._editors.length - 1];
    const r = ed.recordId ? this._record(ed.recordId) : null;
    ed.override = !!r?.total_override;
    const isSub = !!ed.parentId;
    const title = `${r ? "Edit" : "New"} ${isSub ? "Sub-item" : "Item"}`;
    const names = [...new Set(this._data.items.map((i) => i.name))].sort((a, b) => a.localeCompare(b));

    this._editorEl.innerHTML = `
      <div class="ed-top">
        <button id="edBack" class="icon" title="Back without saving">${icon("arrow-left")}</button>
        <div class="title">${esc(title)}</div>
        ${r ? `<button id="edDelete" class="icon" title="Delete">${icon("delete")}</button>` : ""}
        <button id="edSave" class="primary">Save</button>
      </div>
      <div class="ed-body">
        <input id="edName" class="big" list="edNames" placeholder="Item name (type or pick)" value="${esc(r?.name ?? "")}" autocomplete="off">
        <datalist id="edNames">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        <div class="ed-row">
          <label>Qty<input id="edQty" inputmode="decimal" value="${esc(r ? qtyText(r.quantity) : "1")}"></label>
          <label id="edUnitWrap">Unit price<input id="edUnit" inputmode="decimal" value="${r?.unit_price != null ? r.unit_price.toFixed(2) : ""}"></label>
        </div>
        <div id="edSubTotal" class="ed-total hidden"></div>
        <button id="edTotal" class="ed-total tappable" title="Tap to type a total"></button>
        <input id="edTotalInput" class="ed-total-input hidden" inputmode="decimal" placeholder="Total"
          value="${r?.total_override && r.total != null ? r.total.toFixed(2) : ""}">
        <div id="edLastPaid" class="muted"></div>
        <textarea id="edNotes" class="notes" placeholder="Note" rows="2">${esc(r?.notes ?? "")}</textarea>
        ${
          isSub
            ? ""
            : `<div class="section">SUB-ITEMS</div>
               <div id="edSubs"></div>
               <button id="edAddSub" class="outline">+ ADD SUB-ITEM</button>`
        }
      </div>`;
    this._editorEl.classList.remove("hidden");

    const $ = (id) => this.shadowRoot.getElementById(id);
    $("edBack").addEventListener("click", () => this._closeEditor());
    $("edSave").addEventListener("click", async () => {
      if (await this._saveEditor()) this._closeEditor();
    });
    if (r) $("edDelete").addEventListener("click", async () => {
      if ((await this._ws("record/delete", { record_id: r.id })) !== undefined) this._closeEditor();
    });
    $("edName").addEventListener("input", () => this._updateLastPaid());
    $("edQty").addEventListener("input", () => this._updateTotals());
    $("edUnit").addEventListener("input", () => this._updateTotals());
    $("edTotal").addEventListener("click", () => {
      // Tapping the calculated total turns it into a box for typing your own
      ed.override = true;
      const calc = this._calcTotal();
      $("edTotalInput").value = calc != null ? calc.toFixed(2) : "";
      this._updateTotals();
      $("edTotalInput").focus();
    });
    if (!isSub) {
      $("edAddSub").addEventListener("click", async () => {
        const saved = await this._saveEditor();
        if (saved) this._openEditor({ tripId: ed.tripId, recordId: null, parentId: saved.id });
      });
    }
    this._refreshEditor();
    this._updateLastPaid();
    if (!r) setTimeout(() => $("edName").focus(), 50);
  }

  _calcTotal() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const unit = parseNum($("edUnit").value);
    const qty = parseNum($("edQty").value) || 1;
    return unit != null ? unit * qty : null;
  }

  _children(recordId) {
    return recordId ? this._data.records.filter((r) => r.parent_id === recordId) : [];
  }

  /** Updates the parts of the editor that depend on saved data (sub-items) without touching typed values. */
  _refreshEditor() {
    const ed = this._editors[this._editors.length - 1];
    if (!ed) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const subs = $("edSubs");
    if (subs) {
      const kids = this._children(ed.recordId);
      subs.innerHTML = kids.length
        ? kids.map((k) => this._recordRowHtml(k)).join("")
        : `<div class="muted pad">No sub-items. Add one to split this item, e.g. red, green and yellow capsicum.</div>`;
      subs.querySelectorAll(".trow").forEach((el) =>
        el.addEventListener("click", () =>
          this._openEditor({ tripId: ed.tripId, recordId: el.dataset.id, parentId: ed.recordId })
        )
      );
    }
    this._updateTotals();
  }

  _updateTotals() {
    const ed = this._editors[this._editors.length - 1];
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!ed || !$("edTotal")) return;
    const kids = this._children(ed.recordId);
    const hasKids = kids.length > 0;
    // An item split into sub-items is priced by its sub-items
    $("edUnitWrap").classList.toggle("hidden", hasKids);
    const priced = kids.filter((k) => k.total != null);
    $("edSubTotal").textContent = `Total from sub-items: ${priced.length ? money(priced.reduce((s, k) => s + k.total, 0)) : "—"}`;
    $("edSubTotal").classList.toggle("hidden", !hasKids);
    const calc = this._calcTotal();
    $("edTotal").textContent = `Total: ${calc != null ? money(calc) : "—"}`;
    $("edTotal").classList.toggle("hidden", hasKids || ed.override);
    $("edTotalInput").classList.toggle("hidden", hasKids || !ed.override);
  }

  /** "Last paid $x each at Store on date", from the newest other trip item with the same name. */
  _updateLastPaid() {
    const ed = this._editors[this._editors.length - 1];
    const $ = (id) => this.shadowRoot.getElementById(id);
    const name = $("edName").value.trim().toLowerCase();
    let best = null;
    if (name) {
      for (const r of this._data.records) {
        if (r.id === ed.recordId || r.unit_price == null || r.name.toLowerCase() !== name) continue;
        const trip = this._trip(r.trip_id);
        if (trip && (!best || trip.finished_at > best.trip.finished_at)) best = { r, trip };
      }
    }
    $("edLastPaid").textContent = best
      ? `Last paid ${money(best.r.unit_price)} each${best.trip.store ? ` at ${best.trip.store}` : ""} on ${shortDate(best.trip.finished_at)}`
      : "";
  }

  /** Saves the editor; returns the saved record, or null when the name is missing or saving failed. */
  async _saveEditor() {
    const ed = this._editors[this._editors.length - 1];
    const $ = (id) => this.shadowRoot.getElementById(id);
    const name = $("edName").value.trim();
    if (!name) {
      $("edName").focus();
      $("edName").placeholder = "Enter a name first";
      return null;
    }
    const hasKids = this._children(ed.recordId).length > 0;
    const existing = ed.recordId ? this._record(ed.recordId) : null;
    const params = {
      trip_id: ed.tripId,
      name,
      quantity: parseNum($("edQty").value) || 1,
      unit_price: hasKids ? existing?.unit_price ?? null : parseNum($("edUnit").value),
      notes: $("edNotes").value.trim(),
    };
    // A typed-in total wins over the calculated one; clearing the box goes back to calculating
    const typed = ed.override && !hasKids ? parseNum($("edTotalInput").value) : null;
    if (typed != null) params.total = typed;
    if (ed.recordId) params.record_id = ed.recordId;
    if (ed.parentId) params.parent_id = ed.parentId;
    const saved = await this._ws("record/save", params);
    if (!saved) return null;
    ed.recordId = saved.id;
    return saved;
  }

  // ── Dialog ──────────────────────────────────────────────────────────────

  /**
   * A small modal inside the card. Resolves to: the typed text (input), the chosen key (choices),
   * true (ok) — or null when cancelled. With optional, an empty input is accepted.
   */
  _dialog({ title, message, input, inputType = "text", value = "", optional = false, choices, rows, ok = "OK", cancel = "Cancel" }) {
    const overlay = this.shadowRoot.getElementById("dialog");
    return new Promise((resolve) => {
      overlay.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dtitle">${esc(title)}</div>
          ${message ? `<div class="dmsg">${esc(message)}</div>` : ""}
          ${input ? `<input class="dinput" type="${esc(inputType)}" placeholder="${esc(input)}" value="${esc(value)}" enterkeyhint="done">` : ""}
          ${choices ? choices.map(([k, label]) => `<button class="choice" data-k="${esc(k)}">${esc(label)}</button>`).join("") : ""}
          ${
            rows
              ? `<div class="drows">${
                  rows.length
                    ? rows.map(([left, right]) => `<div class="drow"><span>${esc(left)}</span><span class="dval">${esc(right)}</span></div>`).join("")
                    : `<div class="dmsg">No purchases yet</div>`
                }</div>`
              : ""
          }
          <div class="dbuttons">
            ${cancel ? `<button class="link" data-act="cancel">${esc(cancel)}</button>` : ""}
            ${choices ? "" : `<button class="primary" data-act="ok">${esc(ok)}</button>`}
          </div>
        </div>`;
      overlay.classList.remove("hidden");
      const field = overlay.querySelector(".dinput");
      const close = (result) => {
        overlay.classList.add("hidden");
        overlay.innerHTML = "";
        resolve(result);
      };
      const submit = () => {
        if (field) {
          const text = field.value.trim();
          if (text || optional) close(text);
        } else close(true);
      };
      overlay.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.dataset.k) close(b.dataset.k);
          else if (b.dataset.act === "ok") submit();
          else close(null);
        })
      );
      overlay.addEventListener("click", (e) => e.target === overlay && close(null), { once: true });
      if (field) {
        field.addEventListener("keydown", (e) => e.key === "Enter" && submit());
        setTimeout(() => field.focus(), 50);
      }
    });
  }
}

const STYLES = `
  :host { display: block; --mdc-icon-size: 22px; }
  ha-card { overflow: hidden; }
  .hidden { display: none !important; }
  .header { display: flex; align-items: center; gap: 4px; padding: 10px 8px 4px 12px; }
  .header select {
    flex: 1; min-width: 0; font-size: 18px; font-weight: 500; padding: 6px 4px; border: none; border-radius: 6px;
    background: transparent; color: var(--primary-text-color);
  }
  .header select option { color: #000; }
  .title { flex: 1; min-width: 0; font-size: 18px; font-weight: 500; color: var(--primary-text-color); }
  .title .sub, .sub { font-size: 13px; font-weight: normal; color: var(--secondary-text-color); }
  button { font: inherit; cursor: pointer; }
  .icon {
    background: none; border: none; color: var(--primary-text-color); padding: 6px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .add { display: flex; gap: 8px; padding: 4px 16px 12px; }
  .add input, .dinput, .ed-body input {
    flex: 1; min-width: 0; font-size: 16px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent);
    color: var(--primary-text-color); box-sizing: border-box;
  }
  .add button, .primary {
    border: none; border-radius: 8px; padding: 10px 16px; background: ${GREEN}; color: #fff; font-weight: 600;
  }
  .empty { text-align: center; padding: 32px 16px; color: var(--secondary-text-color); }
  .hint { text-align: center; padding: 10px; font-size: 12px; color: var(--secondary-text-color); }
  .section {
    background: ${GREEN}; color: #fff; font-size: 13px; font-weight: bold; letter-spacing: .05em;
    padding: 9px 16px;
  }
  .link {
    display: block; width: 100%; text-align: left; background: none; border: none;
    color: var(--secondary-text-color); padding: 14px 20px; font-size: 15px;
  }
  .finish {
    display: flex; align-items: center; justify-content: center; gap: 8px; width: calc(100% - 32px); margin: 12px 16px 16px;
    border: none; border-radius: 24px; padding: 12px 20px; background: ${GREEN}; color: #fff; font-weight: 600; font-size: 16px;
  }
  .row-wrap { position: relative; overflow: hidden; border-bottom: 1px solid var(--divider-color); }
  .swipe-bg {
    position: absolute; inset: 0; display: flex; align-items: center; padding: 0 24px; visibility: hidden;
    color: #fff; font-weight: bold; font-size: 16px;
  }
  .row {
    position: relative; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 10px 16px 10px 20px;
    background: var(--card-background-color, var(--ha-card-background, #fff)); touch-action: pan-y;
    user-select: none; -webkit-user-select: none; cursor: pointer; box-sizing: border-box;
  }
  .text { flex: 1; min-width: 0; }
  .name { font-size: 17px; color: var(--primary-text-color); overflow-wrap: anywhere; }
  .name.strong { font-size: 16px; font-weight: 600; }
  .qty { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
  .price { font-size: 14px; color: var(--primary-text-color); white-space: nowrap; }
  .row.crossed .name { text-decoration: line-through; }
  .row.crossed .name, .row.crossed .qty, .row.crossed .price { opacity: .45; }
  .trip {
    display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--divider-color);
    cursor: pointer;
  }
  .total { font-size: 15px; font-weight: bold; color: ${GREEN}; white-space: nowrap; }
  .trow {
    display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 10px 16px 10px 20px; box-sizing: border-box;
    border-bottom: 1px solid var(--divider-color); cursor: pointer;
  }
  .trow.child { padding-left: 44px; }
  .trow.child .tname { font-size: 15px; }
  .tname { flex: 1; min-width: 0; font-size: 17px; color: var(--primary-text-color); overflow-wrap: anywhere; }
  .tqty { font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
  .tprice { min-width: 72px; text-align: right; font-size: 15px; font-weight: bold; color: ${GREEN}; white-space: nowrap; }
  .tprice.hintc { color: var(--secondary-text-color); font-weight: normal; }
  .fullscreen {
    position: fixed; inset: 0; z-index: 9; display: flex; flex-direction: column;
    background: var(--primary-background-color, var(--card-background-color, #fff)); color: var(--primary-text-color);
  }
  .ed-top {
    display: flex; align-items: center; gap: 6px; padding: 8px 12px; min-height: 56px; box-sizing: border-box;
    background: var(--app-header-background-color, var(--card-background-color)); color: var(--app-header-text-color, var(--primary-text-color));
    border-bottom: 1px solid var(--divider-color);
  }
  .ed-top .icon, .ed-top .title { color: inherit; }
  .ed-body { flex: 1; overflow-y: auto; padding: 16px 0 32px; }
  .ed-body > input.big { display: block; width: calc(100% - 32px); margin: 0 16px 12px; font-size: 20px; }
  .ed-row { display: flex; gap: 12px; padding: 0 16px 12px; }
  .ed-row label { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--secondary-text-color); }
  .ed-total {
    display: block; width: calc(100% - 32px); margin: 0 16px 8px; text-align: left; font-size: 16px; font-weight: bold;
    color: ${GREEN}; background: none; border: none; padding: 6px 0;
  }
  .ed-total.tappable { text-decoration: underline dotted; }
  .ed-body input.ed-total-input { display: block; width: calc(100% - 32px); margin: 0 16px 8px; font-weight: bold; color: ${GREEN}; }
  .muted { color: var(--secondary-text-color); font-size: 14px; padding: 0 16px 16px; }
  .muted.pad { padding: 16px; }
  .outline {
    display: block; width: calc(100% - 32px); margin: 16px; padding: 10px; border-radius: 8px; background: none;
    border: 1px solid var(--divider-color); color: var(--primary-text-color); font-weight: 600;
  }
  .overlay {
    position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.5);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .overlay.hidden { display: none; }
  .dialog {
    width: 100%; max-width: 360px; border-radius: 12px; padding: 20px;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .dtitle { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
  .dmsg { color: var(--secondary-text-color); margin-bottom: 12px; }
  .dinput { width: 100%; margin-bottom: 12px; }
  .choice {
    display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--divider-color);
    color: var(--primary-text-color); padding: 14px 4px; font-size: 16px;
  }
  .dbuttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .hrow { display: flex; justify-content: space-between; gap: 16px; padding: 9px 16px 9px 20px; }
  .hrow.line { min-height: 52px; box-sizing: border-box; align-items: center; border-bottom: 1px solid var(--divider-color); font-size: 16px; color: var(--primary-text-color); }
  .hprice { font-weight: bold; color: ${GREEN}; white-space: nowrap; }
  .hnone { color: var(--secondary-text-color); }
  .ed-body.flush { padding-top: 0; }
  .drows { max-height: 60vh; overflow-y: auto; margin-bottom: 8px; }
  .drow { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--divider-color); font-size: 15px; }
  .dval { font-weight: bold; color: ${GREEN}; white-space: nowrap; }
  .dbuttons .link { width: auto; padding: 10px 12px; }
  .status { color: ${GREEN}; font-weight: 600; }
  .receipt-mark { color: ${GREEN}; display: inline-flex; }
  .icon.light { color: #fff; padding: 2px; }
  .rcard { border-bottom: 1px solid var(--divider-color); cursor: pointer; }
  .rhead { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 4px 16px; }
  .rimg { display: block; width: 100%; height: auto; }
  .zoom {
    flex: 1; position: relative; overflow: hidden; background: #000; touch-action: none;
    display: flex; align-items: center; justify-content: center;
  }
  .zoom img { width: 100%; height: 100%; object-fit: contain; transform-origin: center center; user-select: none; -webkit-user-drag: none; }
  .zoom .empty { color: #ccc; }
  .lrow { padding: 10px 16px; border-bottom: 1px solid var(--divider-color); }
  .lrow.tap { cursor: pointer; }
  .lline { display: flex; gap: 12px; align-items: baseline; }
  .ltext { flex: 1; min-width: 0; font-family: monospace; font-size: 14px; color: var(--primary-text-color); overflow-wrap: anywhere; }
  .lprice { font-weight: bold; color: ${GREEN}; white-space: nowrap; }
  .lmapped { margin-top: 4px; font-size: 13px; color: ${GREEN}; }
  .outline { display: flex; align-items: center; justify-content: center; gap: 8px; }
  .thumbs { display: flex; gap: 8px; overflow-x: auto; padding: 0 16px 12px; }
  .thumb { width: 96px; height: 128px; object-fit: cover; border-radius: 6px; flex: none; cursor: pointer; background: var(--secondary-background-color); }
  .nrow { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--divider-color); cursor: pointer; }
  .nrow .tick { color: var(--secondary-text-color); display: inline-flex; }
  .nrow.on .tick { color: ${GREEN}; }
  .nrow:not(.on) .ltext, .nrow:not(.on) .lprice { opacity: .5; }
  .row { padding-right: 4px; }
  .info {
    flex: none; align-self: stretch; display: inline-flex; align-items: center; justify-content: center; width: 48px;
    margin: -10px 0; background: none; border: none; border-left: 1px solid var(--divider-color);
    color: var(--secondary-text-color);
  }
  .row.crossed .info { opacity: .45; }
  .qtyrow { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; }
  .qtyrow .outline { width: auto; flex: 1; margin: 0; }
  .qtyrow .outline:disabled { opacity: .4; }
  .qtyval { flex: 1; text-align: center; font-size: 15px; color: var(--primary-text-color); }
  .fav { color: var(--secondary-text-color); --mdc-icon-size: 28px; }
  .fav.on { color: #FFC107; }
  .field {
    display: block; width: calc(100% - 32px); margin: 0 16px 8px; padding: 15px; border: none; border-radius: 8px;
    background: var(--secondary-background-color, rgba(127,127,127,.15)); color: var(--primary-text-color);
    font-size: 14px; font-weight: bold; text-align: center; box-sizing: border-box;
  }
  .field.static { cursor: default; }
  .barrow { display: flex; gap: 8px; padding: 0 16px 8px; }
  .barrow input { flex: 1; }
  .barrow .outline { width: auto; margin: 0; padding: 10px 14px; }
  .photorow { display: flex; gap: 8px; padding: 0 16px; }
  .photorow .outline { flex: 1; width: auto; margin: 12px 0; }
  .itemphoto { display: block; width: calc(100% - 32px); max-height: 60vh; object-fit: contain; margin: 4px 16px; border-radius: 8px; }
  .srow {
    display: flex; justify-content: space-between; gap: 12px; padding: 16px 20px; font-size: 16px;
    border-bottom: 1px solid var(--divider-color); color: var(--primary-text-color);
  }
  .sval { color: var(--secondary-text-color); }
  .sval.small { font-size: 13px; }
  .tapr { width: 100%; background: none; border: none; border-bottom: 1px solid var(--divider-color); text-align: left; align-items: center; }
  .tapr:disabled { opacity: .5; }
  .warn { padding: 14px 20px; color: var(--error-color, #db4437); font-size: 14px; }
  .notes {
    display: block; width: calc(100% - 32px); margin: 8px 16px; padding: 12px; box-sizing: border-box; font: inherit;
    font-size: 16px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color, transparent); color: var(--primary-text-color); resize: vertical;
  }
`;

if (!customElements.get("shopping-trips-card")) {
  customElements.define("shopping-trips-card", ShoppingTripsCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "shopping-trips-card",
    name: "Shopping Trips",
    description: "Shopping lists with swipe to cross off, trips, prices and receipts.",
  });
  console.info(`%c SHOPPING-TRIPS-CARD %c ${CARD_VERSION} `, "background:#4CAF50;color:#fff", "");
}
