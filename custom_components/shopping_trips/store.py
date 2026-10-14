"""Data store for Shopping Trips: lists and items, saved in HA's .storage folder."""

from __future__ import annotations

from collections.abc import Callable
import time
from typing import Any
import uuid

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import (
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


class ShoppingStore:
    """Holds all data in memory, saves it with a short delay and notifies listeners on every change."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._listeners: list[Callable[[], None]] = []
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
        }

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
    def delete_list(self, list_id: str) -> None:
        """Deletes a list and its items. The last remaining list can't be deleted."""
        self.get_list(list_id)
        if len(self.lists) <= 1:
            raise ValueError("Can't delete the only list")
        self.data["lists"] = [lst for lst in self.lists if lst["id"] != list_id]
        self.data["items"] = [i for i in self.data["items"] if i["list_id"] != list_id]
        self._changed()

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
        """Updates editable fields (name, quantity, unit, category, notes, favourite, list)."""
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
    def delete_item(self, item_id: str) -> None:
        self.get_item(item_id)
        self.data["items"] = [i for i in self.data["items"] if i["id"] != item_id]
        self._changed()

    @callback
    def delete_crossed(self, list_id: str) -> None:
        """Deletes every crossed-off item in a list."""
        self.data["items"] = [
            i for i in self.data["items"] if not (i["list_id"] == list_id and i["is_purchased"])
        ]
        self._changed()

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
    def delete_trip(self, trip_id: str) -> None:
        self.get_trip(trip_id)
        self.data["trips"] = [t for t in self.data["trips"] if t["id"] != trip_id]
        self.data["records"] = [r for r in self.data["records"] if r["trip_id"] != trip_id]
        self._changed()

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
