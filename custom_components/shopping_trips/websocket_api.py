"""Websocket commands used by the dashboard card."""

from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, STATE_BOUGHT, STATE_PENDING, STATE_SKIPPED
from .store import NotFound, ShoppingStore


def _store(hass: HomeAssistant) -> ShoppingStore:
    return hass.data[DOMAIN]


def _handles_errors(func: Callable[..., None]) -> Callable[..., None]:
    """Turns store errors into websocket errors instead of unhandled exceptions."""

    @wraps(func)
    def wrapper(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        try:
            func(hass, connection, msg)
        except NotFound as err:
            connection.send_error(msg["id"], "not_found", f"Not found: {err}")
        except ValueError as err:
            connection.send_error(msg["id"], "invalid", str(err))

    return wrapper


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for command in (
        ws_subscribe,
        ws_list_create,
        ws_list_rename,
        ws_list_delete,
        ws_item_add,
        ws_item_update,
        ws_item_set_state,
        ws_item_delete,
        ws_items_delete_crossed,
    ):
        websocket_api.async_register_command(hass, command)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Sends the full data now and again after every change."""
    store = _store(hass)

    @callback
    def forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], store.snapshot()))

    connection.subscriptions[msg["id"]] = store.async_add_listener(forward)
    connection.send_result(msg["id"])
    forward()


# ── Lists ──────────────────────────────────────────────────────────────────


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/list/create", vol.Required("name"): vol.All(str, vol.Length(min=1))}
)
@callback
@_handles_errors
def ws_list_create(hass, connection, msg) -> None:
    connection.send_result(msg["id"], _store(hass).create_list(msg["name"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/list/rename",
        vol.Required("list_id"): str,
        vol.Required("name"): vol.All(str, vol.Length(min=1)),
    }
)
@callback
@_handles_errors
def ws_list_rename(hass, connection, msg) -> None:
    _store(hass).rename_list(msg["list_id"], msg["name"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list/delete", vol.Required("list_id"): str})
@callback
@_handles_errors
def ws_list_delete(hass, connection, msg) -> None:
    _store(hass).delete_list(msg["list_id"])
    connection.send_result(msg["id"])


# ── Items ──────────────────────────────────────────────────────────────────


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/item/add",
        vol.Required("list_id"): str,
        vol.Required("name"): vol.All(str, vol.Length(min=1)),
    }
)
@callback
@_handles_errors
def ws_item_add(hass, connection, msg) -> None:
    connection.send_result(msg["id"], _store(hass).add_item(msg["list_id"], msg["name"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/item/update",
        vol.Required("item_id"): str,
        vol.Optional("name"): vol.All(str, vol.Length(min=1)),
        vol.Optional("quantity"): vol.All(int, vol.Range(min=1)),
        vol.Optional("unit"): str,
        vol.Optional("category"): str,
        vol.Optional("notes"): str,
        vol.Optional("is_favourite"): bool,
        vol.Optional("list_id"): str,
    }
)
@callback
@_handles_errors
def ws_item_update(hass, connection, msg) -> None:
    changes = {k: v for k, v in msg.items() if k not in ("id", "type", "item_id")}
    _store(hass).update_item(msg["item_id"], changes)
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/item/set_state",
        vol.Required("item_id"): str,
        vol.Required("state"): vol.In([STATE_PENDING, STATE_BOUGHT, STATE_SKIPPED]),
    }
)
@callback
@_handles_errors
def ws_item_set_state(hass, connection, msg) -> None:
    _store(hass).set_state(msg["item_id"], msg["state"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/item/delete", vol.Required("item_id"): str})
@callback
@_handles_errors
def ws_item_delete(hass, connection, msg) -> None:
    _store(hass).delete_item(msg["item_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/items/delete_crossed", vol.Required("list_id"): str}
)
@callback
@_handles_errors
def ws_items_delete_crossed(hass, connection, msg) -> None:
    _store(hass).delete_crossed(msg["list_id"])
    connection.send_result(msg["id"])
