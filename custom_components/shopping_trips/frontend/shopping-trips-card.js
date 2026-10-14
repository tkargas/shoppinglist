/*
 * Shopping Trips card for Home Assistant.
 * Plain web component (no build step). Talks to the shopping_trips integration over the websocket API.
 */
const CARD_VERSION = "0.1.1";

const GREEN = "#4CAF50";
const ORANGE = "#E08A3C";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => "$" + Number(n).toFixed(2);

class ShoppingTripsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._listId = null;
    this._unsub = null;
    this._subscribing = false;
    this._built = false;
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
      return null;
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

  // ── Layout ──────────────────────────────────────────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="header">
          <select id="list" aria-label="List"></select>
          <button id="menu" class="icon" title="Manage lists">⋮</button>
        </div>
        <form id="addForm" class="add">
          <input id="addInput" list="names" placeholder="Add item (type or pick)" autocomplete="off" enterkeyhint="done">
          <datalist id="names"></datalist>
          <button type="submit">Add</button>
        </form>
        <div id="body"><div class="empty">Loading…</div></div>
      </ha-card>
      <div id="dialog" class="overlay hidden"></div>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    this._body = $("body");
    this._listSelect = $("list");
    this._names = $("names");
    this._addInput = $("addInput");
    this._listSelect.addEventListener("change", () => {
      this._listId = this._listSelect.value;
      this._render();
    });
    $("menu").addEventListener("click", () => this._listMenu());
    $("addForm").addEventListener("submit", (e) => {
      e.preventDefault();
      this._addItem();
    });
  }

  _render() {
    if (!this._data) return;
    const list = this._currentList();
    if (!list) return;

    this._listSelect.innerHTML = this._data.lists
      .map((l) => `<option value="${esc(l.id)}"${l.id === list.id ? " selected" : ""}>${esc(l.name)}</option>`)
      .join("");

    const items = this._data.items.filter((i) => i.list_id === list.id);
    this._names.innerHTML = [...new Set(items.map((i) => i.name))]
      .sort((a, b) => a.localeCompare(b))
      .map((n) => `<option value="${esc(n)}"></option>`)
      .join("");

    const pending = items.filter((i) => !i.is_purchased).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const crossed = items.filter((i) => i.is_purchased).sort((a, b) => (b.purchased_at || 0) - (a.purchased_at || 0));

    let html = "";
    if (pending.length === 0) html += `<div class="empty">Your list is empty<br>Add items above</div>`;
    html += pending.map((i) => this._rowHtml(i)).join("");
    if (pending.length) html += `<div class="hint">Swipe right ✓ bought · Swipe left ✗ not bought</div>`;
    if (crossed.length) {
      html += `<div class="section">CROSSED OFF</div>`;
      html += `<button class="link" id="deleteCrossed">Delete all crossed-off items</button>`;
      html += crossed.map((i) => this._rowHtml(i)).join("");
    }
    this._body.innerHTML = html;

    this._body.querySelectorAll(".row-wrap").forEach((wrap) => {
      const item = items.find((i) => i.id === wrap.dataset.id);
      if (item) this._wireRow(wrap, item);
    });
    const del = this.shadowRoot.getElementById("deleteCrossed");
    if (del) del.addEventListener("click", () => this._deleteCrossed(list));
  }

  _rowHtml(item) {
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
        </div>
      </div>`;
  }

  // ── Row gestures ────────────────────────────────────────────────────────

  /** Tap: pending → bought, crossed → back on the list. Swipe (pending only): right bought, left not bought. */
  _wireRow(wrap, item) {
    const row = wrap.querySelector(".row");
    const bg = wrap.querySelector(".swipe-bg");
    const lbl = wrap.querySelector(".lbl");
    const canSwipe = !item.is_purchased;
    let startX = 0, startY = 0, dx = 0, tracking = false, swiping = false, suppressClick = false;

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

  // ── Actions ─────────────────────────────────────────────────────────────

  async _addItem() {
    const name = this._addInput.value.trim();
    if (!name || !this._listId) return;
    this._addInput.value = "";
    await this._ws("item/add", { list_id: this._listId, name });
  }

  async _deleteCrossed(list) {
    const ok = await this._dialog({ title: "Delete all crossed-off items?", ok: "Delete" });
    if (ok) await this._ws("items/delete_crossed", { list_id: list.id });
  }

  async _listMenu() {
    const list = this._currentList();
    const choice = await this._dialog({
      title: "Lists",
      choices: [
        ["new", "New list"],
        ["rename", `Rename “${list?.name ?? ""}”`],
        ["delete", `Delete “${list?.name ?? ""}”`],
      ],
    });
    if (choice === "new") {
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

  // ── Dialog ──────────────────────────────────────────────────────────────

  /**
   * A small modal inside the card. Resolves to: the typed text (input), the chosen key (choices),
   * true (ok) — or null when cancelled.
   */
  _dialog({ title, message, input, value = "", choices, ok = "OK", cancel = "Cancel" }) {
    const overlay = this.shadowRoot.getElementById("dialog");
    return new Promise((resolve) => {
      overlay.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dtitle">${esc(title)}</div>
          ${message ? `<div class="dmsg">${esc(message)}</div>` : ""}
          ${input ? `<input class="dinput" placeholder="${esc(input)}" value="${esc(value)}" enterkeyhint="done">` : ""}
          ${choices ? choices.map(([k, label]) => `<button class="choice" data-k="${esc(k)}">${esc(label)}</button>`).join("") : ""}
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
          if (text) close(text);
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
  :host { display: block; }
  ha-card { overflow: hidden; }
  .header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 4px 16px; }
  .header select {
    flex: 1; font-size: 18px; font-weight: 500; padding: 6px 4px; border: none; border-radius: 6px;
    background: transparent; color: var(--primary-text-color);
  }
  .header select option { color: #000; }
  button { font: inherit; cursor: pointer; }
  .icon { background: none; border: none; color: var(--primary-text-color); font-size: 22px; padding: 4px 10px; }
  .add { display: flex; gap: 8px; padding: 4px 16px 12px; }
  .add input {
    flex: 1; min-width: 0; font-size: 16px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent);
    color: var(--primary-text-color);
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
  .qty { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
  .price { font-size: 14px; color: var(--primary-text-color); white-space: nowrap; }
  .row.crossed .name { text-decoration: line-through; }
  .row.crossed .name, .row.crossed .qty, .row.crossed .price { opacity: .45; }
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
  .dinput {
    width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px 12px; margin-bottom: 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent);
    color: var(--primary-text-color);
  }
  .choice {
    display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--divider-color);
    color: var(--primary-text-color); padding: 14px 4px; font-size: 16px;
  }
  .dbuttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .dbuttons .link { width: auto; padding: 10px 12px; }
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
