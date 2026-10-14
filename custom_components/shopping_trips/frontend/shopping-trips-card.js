/*
 * Shopping Trips card for Home Assistant.
 * Plain web component (no build step). Talks to the shopping_trips integration over the websocket API.
 *
 * Views: the shopping list, trip history, and one trip. Trip items open in a full-screen editor.
 */
const CARD_VERSION = "0.2.0";

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
      <div id="dialog" class="overlay hidden"></div>`;
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
        </div>
        <div class="add"><input id="search" placeholder="Search item or store" value="${esc(this._search)}" enterkeyhint="search"></div>`;
      $("back").addEventListener("click", () => this._setView({ name: "list" }));
      $("search").addEventListener("input", (e) => {
        this._search = e.target.value;
        this._render();
      });
    } else if (view.name === "trip") {
      this._top.innerHTML = `
        <div class="header">
          <button id="back" class="icon" title="Back">${icon("arrow-left")}</button>
          <div class="title"><div id="tripTitle"></div><div id="tripSub" class="sub"></div></div>
          <button id="addRecord" class="icon" title="Add item">${icon("plus")}</button>
          <button id="tripMenu" class="icon" title="More">${icon("dots-vertical")}</button>
        </div>`;
      $("back").addEventListener("click", () => this._setView({ name: "trips" }));
      $("addRecord").addEventListener("click", () => this._openEditor({ tripId: view.id, recordId: null, parentId: null }));
      $("tripMenu").addEventListener("click", () => this._tripMenu(view.id));
    }
    this._render();
  }

  _render() {
    if (!this._data) return;
    if (this._view.name === "list") this._renderList();
    else if (this._view.name === "trips") this._renderTrips();
    else if (this._view.name === "trip") this._renderTrip();
    if (this._editors.length) this._refreshEditor();
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
        return `
          <div class="trip" data-id="${esc(t.id)}">
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
    const choice = await this._dialog({
      title: "Trip",
      choices: [
        ["unpriced", `${this._unpricedFirst ? "✓ " : ""}Unpriced first`],
        ["date", "Edit date"],
        ["store", "Edit store"],
        ["delete", "Delete trip"],
      ],
    });
    if (choice === "unpriced") {
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
  _dialog({ title, message, input, inputType = "text", value = "", optional = false, choices, ok = "OK", cancel = "Cancel" }) {
    const overlay = this.shadowRoot.getElementById("dialog");
    return new Promise((resolve) => {
      overlay.innerHTML = `
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dtitle">${esc(title)}</div>
          ${message ? `<div class="dmsg">${esc(message)}</div>` : ""}
          ${input ? `<input class="dinput" type="${esc(inputType)}" placeholder="${esc(input)}" value="${esc(value)}" enterkeyhint="done">` : ""}
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
