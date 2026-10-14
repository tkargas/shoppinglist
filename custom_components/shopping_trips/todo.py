"""Each shopping list as an HA to-do list, for HA's to-do screen, the Companion apps, voice and automations."""

from __future__ import annotations

from typing import Any

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, STATE_BOUGHT, STATE_PENDING
from .store import NotFound, ShoppingStore


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    store: ShoppingStore = hass.data[DOMAIN]
    entities: dict[str, ShoppingListTodo] = {}

    @callback
    def sync_lists() -> None:
        """Adds an entity for each new list and removes those whose list was deleted."""
        current = {lst["id"] for lst in store.lists}
        new = [ShoppingListTodo(store, list_id) for list_id in current if list_id not in entities]
        for entity in new:
            entities[entity.list_id] = entity
        if new:
            async_add_entities(new)
        registry = er.async_get(hass)
        for list_id in [lid for lid in entities if lid not in current]:
            entity = entities.pop(list_id)
            if entity.entity_id and registry.async_get(entity.entity_id):
                registry.async_remove(entity.entity_id)

    sync_lists()
    entry.async_on_unload(store.async_add_listener(sync_lists))


class ShoppingListTodo(TodoListEntity):
    """A shopping list. Items on the list are 'needs action'; crossed-off items (bought or not) are 'completed'."""

    _attr_should_poll = False
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
    )

    def __init__(self, store: ShoppingStore, list_id: str) -> None:
        self._store = store
        self.list_id = list_id
        self._attr_unique_id = f"{DOMAIN}_{list_id}"
        self._attr_name = store.get_list(list_id)["name"]

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._store.async_add_listener(self._handle_change))

    @callback
    def _handle_change(self) -> None:
        try:
            self._attr_name = self._store.get_list(self.list_id)["name"]
        except NotFound:
            return  # being removed
        self.async_write_ha_state()

    @property
    def todo_items(self) -> list[TodoItem]:
        try:
            items = self._store.items_for(self.list_id)
        except NotFound:
            return []
        pending = sorted((i for i in items if not i["is_purchased"]), key=lambda i: i["name"].lower())
        crossed = sorted((i for i in items if i["is_purchased"]), key=lambda i: i["purchased_at"] or 0, reverse=True)
        return [self._to_todo(i) for i in pending + crossed]

    @staticmethod
    def _to_todo(item: dict[str, Any]) -> TodoItem:
        quantity = item.get("quantity", 1)
        details = [f"Qty: {quantity}"] if quantity > 1 else []
        if item.get("notes"):
            details.append(item["notes"])
        return TodoItem(
            uid=item["id"],
            summary=item["name"],
            status=TodoItemStatus.COMPLETED if item["is_purchased"] else TodoItemStatus.NEEDS_ACTION,
            description="\n".join(details) or None,
        )

    async def async_create_todo_item(self, item: TodoItem) -> None:
        added = self._store.add_item(self.list_id, item.summary or "")
        if item.status == TodoItemStatus.COMPLETED:
            self._store.set_state(added["id"], STATE_BOUGHT)

    async def async_update_todo_item(self, item: TodoItem) -> None:
        current = self._store.get_item(item.uid or "")
        if item.summary and item.summary.strip() != current["name"]:
            self._store.update_item(current["id"], {"name": item.summary})
        # Ticking in HA counts as bought; unticking puts it back on the list
        if item.status == TodoItemStatus.COMPLETED and not current["is_purchased"]:
            self._store.set_state(current["id"], STATE_BOUGHT)
        elif item.status == TodoItemStatus.NEEDS_ACTION and current["is_purchased"]:
            self._store.set_state(current["id"], STATE_PENDING)

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        for uid in uids:
            self._store.delete_item(uid)
