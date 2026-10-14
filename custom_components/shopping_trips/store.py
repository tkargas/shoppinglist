"""Data store for Shopping Trips: lists and items, saved in HA's .storage folder."""

from __future__ import annotations

from collections.abc import Callable
import json
import time
from typing import Any
import uuid

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import (
    VERSION,
    DEFAULT_LIST_NAME,
    STATE_BOUGHT,
    STATE_PENDING,
    STATE_SKIPPED,
    STORAGE_KEY,
    STORAGE_VERSION,
)


def _now() -> int:
    """Milliseconds since the epoch, matching the Android app."""
    return int(time.time() * 1000)


def _new_id() -> str:
    return uuid.uuid4().hex


class NotFound(Exception):
    """Raised when a list or item id doesn't exist."""


# What the Android app syncs. Every change to one of these gets the next "rev" number; deletions leave a
# tombstone in data["deleted"]. last_unit_price is worked out on each side, so it isn't tracked.
SYNC_KINDS = ("lists", "items", "trips", "records", "receipts")
_UNTRACKED = {"rev", "last_unit_price"}


def _fingerprint(entity: dict[str, Any]) -> str:
    return json.dumps({k: v for k, v in entity.items() if k not in _UNTRACKED}, sort_keys=True, default=str)


class ShoppingStore:
    """Holds all data in memory, saves it with a short delay and notifies listeners on every change."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._listeners: list[Callable[[], None]] = []
        self._prints: dict[tuple[str, str], str] = {}
        self.data: dict[str, Any] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load()
        if not data:
            data = {
                "lists": [{"id": _new_id(), "name": DEFAULT_LIST_NAME, "created_at": _now()}],
                "items": [],
                "trips": [],
                "records": [],
                "receipts": [],
            }
        # Data saved by older versions may lack newer sections
        for key in ("items", "trips", "records", "receipts", "deleted"):
            data.setdefault(key, [])
        data.setdefault("rev", 0)
        # Records saved before sync existed count as changed once, so a first sync sends them
        for kind in SYNC_KINDS:
            for entity in data[kind]:
                if "rev" not in entity:
                    entity["rev"] = 1
                    data["rev"] = max(data["rev"], 1)
                self._prints[(kind, entity["id"])] = _fingerprint(entity)
        self.data = data

    # ── Change notification ────────────────────────────────────────────────

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Calls [listener] after every change; returns a function that removes it."""
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    @callback
    def _changed(self) -> None:
        self._refresh_last_prices()
        self._track_changes()
        self._store.async_delay_save(lambda: self.data, 1)
        for listener in list(self._listeners):
            listener()

    def snapshot(self) -> dict[str, Any]:
        """Everything the card needs to draw itself."""
        return {
            "lists": self.data["lists"],
            "items": self.data["items"],
            "trips": self.data["trips"],
            "records": self.data["records"],
            "receipts": self.data["receipts"],
            "version": VERSION,
        }

    def _track_changes(self) -> None:
        """Gives everything added or changed since the last check the next rev number, and records deletions."""
        rev = self.data["rev"]
        seen: set[tuple[str, str]] = set()
        for kind in SYNC_KINDS:
            for entity in self.data[kind]:
                key = (kind, entity["id"])
                seen.add(key)
                fingerprint = _fingerprint(entity)
                if self._prints.get(key) != fingerprint:
                    rev += 1
                    entity["rev"] = rev
                    self._prints[key] = fingerprint
        for key in [k for k in self._prints if k not in seen]:
            rev += 1
            self.data["deleted"].append({"kind": key[0], "id": key[1], "rev": rev})
            del self._prints[key]
        self.data["rev"] = rev

    def _refresh_last_prices(self) -> None:
        """Each item's last unit price: newest trip first, falling back to earlier trips (names match case-insensitively)."""
        trip_dates = {t["id"]: t["finished_at"] for t in self.data["trips"]}
        latest: dict[str, tuple[int, float]] = {}
        for r in self.data["records"]:
            if r.get("unit_price") is None or r["trip_id"] not in trip_dates:
                continue
            key = r["name"].lower()
            when = trip_dates[r["trip_id"]]
            if key not in latest or when > latest[key][0]:
                latest[key] = (when, r["unit_price"])
        for item in self.data["items"]:
            found = latest.get(item["name"].lower())
            item["last_unit_price"] = found[1] if found else None

    # ── Lists ──────────────────────────────────────────────────────────────

    @property
    def lists(self) -> list[dict[str, Any]]:
        return self.data["lists"]

    def get_list(self, list_id: str) -> dict[str, Any]:
        for lst in self.lists:
            if lst["id"] == list_id:
                return lst
        raise NotFound(list_id)

    @callback
    def create_list(self, name: str) -> dict[str, Any]:
        lst = {"id": _new_id(), "name": name.strip(), "created_at": _now()}
        self.lists.append(lst)
        self._changed()
        return lst

    @callback
    def rename_list(self, list_id: str, name: str) -> None:
        self.get_list(list_id)["name"] = name.strip()
        self._changed()

    @callback
    def delete_list(self, list_id: str) -> list[str]:
        """Deletes a list and its items (the last list can't be deleted); returns item photo files to remove."""
        self.get_list(list_id)
        if len(self.lists) <= 1:
            raise ValueError("Can't delete the only list")
        photos = [i["photo"] for i in self.items_for(list_id) if i.get("photo")]
        self.data["lists"] = [lst for lst in self.lists if lst["id"] != list_id]
        self.data["items"] = [i for i in self.data["items"] if i["list_id"] != list_id]
        self._changed()
        return photos

    # ── Items ──────────────────────────────────────────────────────────────

    def items_for(self, list_id: str) -> list[dict[str, Any]]:
        return [i for i in self.data["items"] if i["list_id"] == list_id]

    def get_item(self, item_id: str) -> dict[str, Any]:
        for item in self.data["items"]:
            if item["id"] == item_id:
                return item
        raise NotFound(item_id)

    def find_by_name(self, list_id: str, name: str) -> dict[str, Any] | None:
        key = name.strip().lower()
        for item in self.items_for(list_id):
            if item["name"].lower() == key:
                return item
        return None

    @callback
    def add_item(self, list_id: str, name: str) -> dict[str, Any]:
        """Adds an item, or reuses one of the same name like the Android app:
        a crossed-off item goes back on the list, one already on the list gets +1 quantity."""
        self.get_list(list_id)
        name = name.strip()
        existing = self.find_by_name(list_id, name)
        if existing is not None:
            if existing["is_purchased"]:
                existing.update(
                    is_purchased=False, is_skipped=False, in_trip=True, purchased_at=None, quantity=1
                )
            else:
                existing["quantity"] = existing.get("quantity", 1) + 1
            self._changed()
            return existing
        item = {
            "id": _new_id(),
            "list_id": list_id,
            "name": name,
            "quantity": 1,
            "unit": "",
            "category": "",
            "notes": "",
            "is_purchased": False,
            "is_skipped": False,
            "in_trip": True,
            "is_favourite": False,
            "photo": None,
            "barcode": None,
            "last_unit_price": None,
            "added_at": _now(),
            "purchased_at": None,
        }
        self.data["items"].append(item)
        self._changed()
        return item

    @callback
    def update_item(self, item_id: str, changes: dict[str, Any]) -> None:
        """Updates editable fields (name, quantity, unit, category, notes, favourite, barcode, list)."""
        item = self.get_item(item_id)
        if "list_id" in changes:
            self.get_list(changes["list_id"])
        if "name" in changes:
            changes["name"] = changes["name"].strip()
        item.update(changes)
        self._changed()

    @callback
    def set_state(self, item_id: str, state: str) -> None:
        """Bought = crossed off and in the trip; skipped = crossed off, not bought; pending = back on the list."""
        item = self.get_item(item_id)
        if state == STATE_BOUGHT:
            item.update(is_purchased=True, is_skipped=False, purchased_at=_now())
        elif state == STATE_SKIPPED:
            item.update(is_purchased=True, is_skipped=True, purchased_at=_now())
        elif state == STATE_PENDING:
            item.update(is_purchased=False, is_skipped=False, in_trip=True, purchased_at=None)
        else:
            raise ValueError(state)
        self._changed()

    @callback
    def delete_item(self, item_id: str) -> list[str]:
        """Deletes an item; returns its photo file to remove, if any."""
        item = self.get_item(item_id)
        self.data["items"] = [i for i in self.data["items"] if i["id"] != item_id]
        self._changed()
        return [item["photo"]] if item.get("photo") else []

    @callback
    def delete_crossed(self, list_id: str) -> list[str]:
        """Deletes every crossed-off item in a list; returns their photo files to remove."""
        gone = [i for i in self.items_for(list_id) if i["is_purchased"]]
        self.data["items"] = [
            i for i in self.data["items"] if not (i["list_id"] == list_id and i["is_purchased"])
        ]
        self._changed()
        return [i["photo"] for i in gone if i.get("photo")]

    @callback
    def set_item_photo(self, item_id: str, photo: str | None) -> str | None:
        """Sets (or clears) an item's photo file; returns the replaced file to remove."""
        item = self.get_item(item_id)
        old = item.get("photo")
        item["photo"] = photo
        self._changed()
        return old if old != photo else None

    def item_with_photo(self, photo: str) -> dict[str, Any] | None:
        return next((i for i in self.data["items"] if i.get("photo") == photo), None)

    @callback
    def import_items(self, list_id: str, rows: list[dict[str, Any]]) -> int:
        """Adds imported CSV rows to a list (an item already on the list is reused, like typing it in),
        then applies the row's quantity, unit and note. Returns how many rows were imported."""
        count = 0
        for row in rows:
            name = str(row.get("name", "")).strip()
            if not name:
                continue
            item = self.add_item(list_id, name)
            item["quantity"] = max(1, int(row.get("quantity") or 1))
            if row.get("unit"):
                item["unit"] = str(row["unit"]).strip()
            if row.get("notes"):
                item["notes"] = str(row["notes"]).strip()
            count += 1
        self._changed()
        return count

    # ── Trips ──────────────────────────────────────────────────────────────

    def get_trip(self, trip_id: str) -> dict[str, Any]:
        for trip in self.data["trips"]:
            if trip["id"] == trip_id:
                return trip
        raise NotFound(trip_id)

    def get_record(self, record_id: str) -> dict[str, Any]:
        for record in self.data["records"]:
            if record["id"] == record_id:
                return record
        raise NotFound(record_id)

    @callback
    def finish_shopping(self, list_id: str, store: str) -> dict[str, Any] | None:
        """Saves the bought items still linked to the current trip as a new trip, then clears their link.
        They stay crossed off on the list. Returns the trip, or None if nothing was bought."""
        lst = self.get_list(list_id)
        bought = sorted(
            (
                i
                for i in self.items_for(list_id)
                if i["is_purchased"] and not i["is_skipped"] and i.get("in_trip", True)
            ),
            key=lambda i: i["purchased_at"] or 0,
        )
        if not bought:
            return None
        now = _now()
        trip = {"id": _new_id(), "list_id": list_id, "list_name": lst["name"], "store": store.strip(), "finished_at": now}
        self.data["trips"].append(trip)
        for item in bought:
            self.data["records"].append(
                self._new_record(trip["id"], None, item["id"], item["name"], float(item.get("quantity", 1)), None, None)
            )
            item["in_trip"] = False
        self._changed()
        return trip

    @callback
    def update_trip(self, trip_id: str, store: str | None = None, finished_at: int | None = None) -> None:
        """Changes a trip's store or date; its items follow a new date."""
        trip = self.get_trip(trip_id)
        if store is not None:
            trip["store"] = store.strip()
        if finished_at is not None:
            trip["finished_at"] = finished_at
            for r in self.data["records"]:
                if r["trip_id"] == trip_id:
                    r["purchased_at"] = finished_at
        self._changed()

    @callback
    def delete_trip(self, trip_id: str) -> list[str]:
        """Deletes a trip with its items and receipts; returns the receipt image files to remove."""
        self.get_trip(trip_id)
        files = [r["file"] for r in self.data["receipts"] if r["trip_id"] == trip_id]
        self.data["trips"] = [t for t in self.data["trips"] if t["id"] != trip_id]
        self.data["records"] = [r for r in self.data["records"] if r["trip_id"] != trip_id]
        self.data["receipts"] = [r for r in self.data["receipts"] if r["trip_id"] != trip_id]
        self._changed()
        return files

    @callback
    def create_trip(self, store: str, finished_at: int, items: list[dict[str, Any]], list_id: str | None = None) -> dict[str, Any]:
        """Creates a trip directly (e.g. from receipt photos). Each item is a {name, price} line bought once;
        items are linked to the main list by name, and added there crossed off when missing."""
        lst = next((l for l in self.lists if l["id"] == list_id), None) or self.lists[0]
        trip = {"id": _new_id(), "list_id": lst["id"], "list_name": lst["name"], "store": store.strip(), "finished_at": finished_at}
        self.data["trips"].append(trip)
        for line in items:
            record = self._new_record(trip["id"], None, None, line["name"], 1.0, line.get("price"), None)
            record["item_id"] = self._link_item(trip, record["name"], create=True)
            self.data["records"].append(record)
        self._changed()
        return trip

    # ── Receipts ───────────────────────────────────────────────────────────

    def get_receipt(self, receipt_id: str) -> dict[str, Any]:
        for receipt in self.data["receipts"]:
            if receipt["id"] == receipt_id:
                return receipt
        raise NotFound(receipt_id)

    @callback
    def add_receipt(self, trip_id: str, file: str, text: str = "", scanned_at: int | None = None) -> dict[str, Any]:
        """Links an already-saved image file to a trip."""
        self.get_trip(trip_id)
        receipt = {"id": _new_id(), "trip_id": trip_id, "file": file, "text": text, "scanned_at": scanned_at or _now()}
        self.data["receipts"].append(receipt)
        self._changed()
        return receipt

    @callback
    def attach_receipt_file(self, receipt_id: str, file: str) -> str | None:
        """Sets the image of an existing receipt; returns the replaced file to remove."""
        receipt = self.get_receipt(receipt_id)
        old = receipt.get("file") or None
        receipt["file"] = file
        self._changed()
        return old if old != file else None

    @callback
    def set_receipt_text(self, receipt_id: str, text: str) -> None:
        self.get_receipt(receipt_id)["text"] = text
        self._changed()

    @callback
    def delete_receipt(self, receipt_id: str) -> str:
        """Removes a receipt; returns its image file to delete."""
        receipt = self.get_receipt(receipt_id)
        self.data["receipts"] = [r for r in self.data["receipts"] if r["id"] != receipt_id]
        self._changed()
        return receipt["file"]

    # ── Trip items (records) ───────────────────────────────────────────────

    def _new_record(
        self,
        trip_id: str,
        parent_id: str | None,
        item_id: str | None,
        name: str,
        quantity: float,
        unit_price: float | None,
        total: float | None,
    ) -> dict[str, Any]:
        trip = self.get_trip(trip_id)
        record = {
            "id": _new_id(),
            "trip_id": trip_id,
            "parent_id": parent_id,
            "item_id": item_id,
            "name": name.strip(),
            "quantity": quantity,
            "unit_price": None,
            "total": None,
            "total_override": False,
            "purchased_at": trip["finished_at"],
        }
        self._price(record, quantity, unit_price, total)
        return record

    @staticmethod
    def _price(record: dict[str, Any], quantity: float, unit_price: float | None, total: float | None) -> None:
        """Total is quantity × unit price, unless a total was typed in (an override)."""
        record["quantity"] = quantity
        record["unit_price"] = unit_price
        if total is not None:
            record["total"] = total
            record["total_override"] = True
        else:
            record["total"] = unit_price * quantity if unit_price is not None else None
            record["total_override"] = False

    def _link_item(self, trip: dict[str, Any], name: str, create: bool) -> str | None:
        """Links a trip item to the main list by name. Missing items are added (crossed off, already saved)
        when [create] is set; sub-items only link to an item that already exists."""
        list_id = trip["list_id"] if any(l["id"] == trip["list_id"] for l in self.lists) else self.lists[0]["id"]
        existing = self.find_by_name(list_id, name)
        if existing is not None:
            return existing["id"]
        if not create:
            return None
        item = self.add_item(list_id, name)  # notifies; harmless as _changed runs again below
        item.update(is_purchased=True, is_skipped=False, in_trip=False, purchased_at=trip["finished_at"])
        return item["id"]

    @callback
    def save_record(
        self,
        trip_id: str,
        name: str,
        quantity: float,
        unit_price: float | None,
        total: float | None,
        record_id: str | None = None,
        parent_id: str | None = None,
    ) -> dict[str, Any]:
        """Adds or edits a trip item or sub-item. [total] is only given when typed in by hand."""
        trip = self.get_trip(trip_id)
        name = name.strip()
        if record_id:
            record = self.get_record(record_id)
            record["name"] = name
            self._price(record, quantity, unit_price, total)
        else:
            if parent_id:
                self.get_record(parent_id)
            record = self._new_record(trip_id, parent_id, None, name, quantity, unit_price, total)
            self.data["records"].append(record)
        record["item_id"] = self._link_item(trip, name, create=record["parent_id"] is None)
        self._changed()
        return record

    @callback
    def delete_record(self, record_id: str) -> None:
        """Deletes a trip item and its sub-items."""
        self.get_record(record_id)
        self.data["records"] = [
            r for r in self.data["records"] if r["id"] != record_id and r.get("parent_id") != record_id
        ]
        self._changed()

    # ── Migration from the Android app ─────────────────────────────────────

    @callback
    def import_android(self, backup: dict[str, Any]) -> dict[str, Any]:
        """Adds an Android app backup (backup.json from "Export everything") to the existing data.

        Lists and items are matched by name, so nothing is duplicated; trips, their items and sub-items are added
        as they were. Receipts without an image are added here with their text; receipts with an image are added
        when the card uploads each image. Returns id maps for those uploads, and counts.
        """
        if backup.get("format") != "shoppinglist-android-backup":
            raise ValueError("That file isn't a Shopping List backup from the Android app")
        stamp = backup.get("exported_at")
        imported = self.data.setdefault("imports", [])
        if stamp in imported:
            raise ValueError("This backup has already been imported")

        def as_float(v: Any) -> float | None:
            return float(v) if v is not None else None

        list_map: dict[str, str] = {}
        for lst in backup.get("lists", []):
            name = str(lst.get("name") or "").strip() or "Shopping List"
            existing = next((l for l in self.lists if l["name"].lower() == name.lower()), None)
            if existing is None:
                existing = {"id": _new_id(), "name": name, "created_at": lst.get("created_at") or _now()}
                self.lists.append(existing)
            list_map[str(lst["id"])] = existing["id"]
        first_list = self.lists[0]["id"]

        new_items: dict[str, str] = {}
        for i in backup.get("items", []):
            name = str(i.get("name") or "").strip()
            if not name:
                continue
            list_id = list_map.get(str(i.get("list_id")), first_list)
            if self.find_by_name(list_id, name) is not None:
                continue  # already in Home Assistant: keep that one
            item = {
                "id": _new_id(),
                "list_id": list_id,
                "name": name,
                "quantity": max(1, int(i.get("quantity") or 1)),
                "unit": i.get("unit") or "",
                "category": i.get("category") or "",
                "notes": i.get("notes") or "",
                "is_purchased": bool(i.get("is_purchased")),
                "is_skipped": bool(i.get("is_skipped")),
                "in_trip": bool(i.get("in_trip", True)),
                "is_favourite": bool(i.get("is_favourite")),
                "photo": None,
                "barcode": i.get("barcode") or None,
                "last_unit_price": None,
                "added_at": i.get("added_at") or _now(),
                "purchased_at": i.get("purchased_at"),
            }
            self.data["items"].append(item)
            new_items[str(i["id"])] = item["id"]

        trip_map: dict[str, str] = {}
        for t in backup.get("trips", []):
            list_id = list_map.get(str(t.get("list_id")), first_list)
            trip = {
                "id": _new_id(),
                "list_id": list_id,
                "list_name": next(l["name"] for l in self.lists if l["id"] == list_id),
                "store": t.get("store") or "",
                "finished_at": t.get("finished_at") or _now(),
            }
            self.data["trips"].append(trip)
            trip_map[str(t["id"])] = trip["id"]

        # Items before their sub-items, so parents are known
        records = sorted(backup.get("records", []), key=lambda r: r.get("parent_id") is not None)
        record_map: dict[str, str] = {}
        for r in records:
            trip_id = trip_map.get(str(r.get("trip_id")))
            name = str(r.get("name") or "").strip()
            if trip_id is None or not name:
                continue
            parent_id = record_map.get(str(r["parent_id"])) if r.get("parent_id") is not None else None
            trip = self.get_trip(trip_id)
            linked = self.find_by_name(trip["list_id"], name)
            record = {
                "id": _new_id(),
                "trip_id": trip_id,
                "parent_id": parent_id,
                "item_id": linked["id"] if linked else None,
                "name": name,
                "quantity": as_float(r.get("quantity")) or 1.0,
                "unit_price": as_float(r.get("unit_price")),
                "total": as_float(r.get("total")),
                "total_override": bool(r.get("total_override")),
                "purchased_at": r.get("purchased_at") or trip["finished_at"],
            }
            self.data["records"].append(record)
            record_map[str(r["id"])] = record["id"]

        text_only = 0
        for rc in backup.get("receipts", []):
            trip_id = trip_map.get(str(rc.get("trip_id")))
            if trip_id and not rc.get("file") and (rc.get("text") or "").strip():
                self.data["receipts"].append({
                    "id": _new_id(), "trip_id": trip_id, "file": "", "text": rc["text"],
                    "scanned_at": rc.get("scanned_at") or _now(),
                })
                text_only += 1

        imported.append(stamp)
        self._changed()
        return {
            "trips": trip_map,
            "items": new_items,
            "counts": {
                "lists": len(set(list_map.values())),
                "items": len(new_items),
                "trips": len(trip_map),
                "trip_items": len(record_map),
                "text_only_receipts": text_only,
            },
        }

    # ── Two-way sync with the Android app ──────────────────────────────────

    @callback
    def sync(self, since: int, changes: dict[str, list[dict[str, Any]]], deletes: list[dict[str, Any]]) -> dict[str, Any]:
        """Applies the app's changes (the app's version wins), then returns everything changed after [since].

        Images aren't part of this: they're uploaded and downloaded separately. Returns the new rev, the changed
        records, tombstones, and image files that deletions made unused (key "files": receipts, "photos": items).
        """
        lists_by = {l["id"]: l for l in self.lists}
        for e in changes.get("lists", []):
            lst = lists_by.get(e["id"])
            if lst is None:
                lst = {"id": e["id"], "created_at": e.get("created_at") or _now()}
                self.lists.append(lst)
                lists_by[lst["id"]] = lst
            lst["name"] = str(e.get("name") or "").strip() or lst.get("name") or "Shopping List"

        items_by = {i["id"]: i for i in self.data["items"]}
        for e in changes.get("items", []):
            if e.get("list_id") not in lists_by:
                continue
            item = items_by.get(e["id"])
            if item is None:
                item = {"id": e["id"], "photo": None, "last_unit_price": None}
                self.data["items"].append(item)
                items_by[item["id"]] = item
            item.update(
                list_id=e["list_id"],
                name=str(e.get("name") or "").strip() or item.get("name") or "?",
                quantity=max(1, int(e.get("quantity") or 1)),
                unit=e.get("unit") or "",
                category=e.get("category") or "",
                notes=e.get("notes") or "",
                is_purchased=bool(e.get("is_purchased")),
                is_skipped=bool(e.get("is_skipped")),
                in_trip=bool(e.get("in_trip", True)),
                is_favourite=bool(e.get("is_favourite")),
                barcode=e.get("barcode") or None,
                added_at=e.get("added_at") or _now(),
                purchased_at=e.get("purchased_at"),
            )

        trips_by = {t["id"]: t for t in self.data["trips"]}
        first_list = self.lists[0]["id"]
        for e in changes.get("trips", []):
            list_id = e.get("list_id") if e.get("list_id") in lists_by else first_list
            trip = trips_by.get(e["id"])
            if trip is None:
                trip = {"id": e["id"]}
                self.data["trips"].append(trip)
                trips_by[trip["id"]] = trip
            trip.update(
                list_id=list_id,
                list_name=e.get("list_name") or lists_by[list_id]["name"],
                store=e.get("store") or "",
                finished_at=e.get("finished_at") or _now(),
            )

        records_by = {r["id"]: r for r in self.data["records"]}
        for e in sorted(changes.get("records", []), key=lambda r: r.get("parent_id") is not None):
            if e.get("trip_id") not in trips_by:
                continue
            record = records_by.get(e["id"])
            if record is None:
                record = {"id": e["id"]}
                self.data["records"].append(record)
                records_by[record["id"]] = record
            record.update(
                trip_id=e["trip_id"],
                parent_id=e.get("parent_id") if e.get("parent_id") in records_by else None,
                item_id=e.get("item_id") if e.get("item_id") in items_by else None,
                name=str(e.get("name") or "").strip() or record.get("name") or "?",
                quantity=float(e.get("quantity") or 1),
                unit_price=float(e["unit_price"]) if e.get("unit_price") is not None else None,
                total=float(e["total"]) if e.get("total") is not None else None,
                total_override=bool(e.get("total_override")),
                purchased_at=e.get("purchased_at") or trips_by[e["trip_id"]]["finished_at"],
            )

        receipts_by = {r["id"]: r for r in self.data["receipts"]}
        for e in changes.get("receipts", []):
            if e.get("trip_id") not in trips_by:
                continue
            receipt = receipts_by.get(e["id"])
            if receipt is None:
                receipt = {"id": e["id"], "file": ""}
                self.data["receipts"].append(receipt)
                receipts_by[receipt["id"]] = receipt
            receipt.update(trip_id=e["trip_id"], text=e.get("text") or "", scanned_at=e.get("scanned_at") or _now())

        files: list[str] = []
        photos: list[str] = []
        for d in deletes:
            kind, gone = d.get("kind"), d.get("id")
            if kind == "lists" and gone in lists_by and len(self.lists) > 1:
                photos += [i["photo"] for i in self.data["items"] if i["list_id"] == gone and i.get("photo")]
                self.data["lists"] = [l for l in self.lists if l["id"] != gone]
                self.data["items"] = [i for i in self.data["items"] if i["list_id"] != gone]
            elif kind == "items":
                photos += [i["photo"] for i in self.data["items"] if i["id"] == gone and i.get("photo")]
                self.data["items"] = [i for i in self.data["items"] if i["id"] != gone]
            elif kind == "trips":
                files += [r["file"] for r in self.data["receipts"] if r["trip_id"] == gone and r.get("file")]
                self.data["trips"] = [t for t in self.data["trips"] if t["id"] != gone]
                self.data["records"] = [r for r in self.data["records"] if r["trip_id"] != gone]
                self.data["receipts"] = [r for r in self.data["receipts"] if r["trip_id"] != gone]
            elif kind == "records":
                self.data["records"] = [
                    r for r in self.data["records"] if r["id"] != gone and r.get("parent_id") != gone
                ]
            elif kind == "receipts":
                files += [r["file"] for r in self.data["receipts"] if r["id"] == gone and r.get("file")]
                self.data["receipts"] = [r for r in self.data["receipts"] if r["id"] != gone]

        self._changed()
        return {
            "rev": self.data["rev"],
            "changes": {kind: [e for e in self.data[kind] if e.get("rev", 0) > since] for kind in SYNC_KINDS},
            "deletes": [d for d in self.data["deleted"] if d["rev"] > since],
            "files": files,
            "photos": photos,
        }
