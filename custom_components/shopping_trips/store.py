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
        self._store.async_delay_save(lambda: self.data, 1)
        for listener in list(self._listeners):
            listener()

    def snapshot(self) -> dict[str, Any]:
        """Everything the card needs to draw itself."""
        return {"lists": self.data["lists"], "items": self.data["items"]}

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
