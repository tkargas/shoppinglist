"""Shopping Trips: shopping lists with trips, prices and receipts, as HA to-do lists plus a dashboard card."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CARD_URL, DOMAIN, VERSION
from .receipt_views import ReceiptImageView, ReceiptUploadView
from .store import ShoppingStore
from .websocket_api import async_register_commands

PLATFORMS = [Platform.TODO]

_FRONTEND_REGISTERED = f"{DOMAIN}_frontend_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = ShoppingStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    # Websocket commands and the card file only need registering once per HA run
    if not hass.data.get(_FRONTEND_REGISTERED):
        async_register_commands(hass)
        hass.http.register_view(ReceiptUploadView())
        hass.http.register_view(ReceiptImageView())
        card = Path(__file__).parent / "frontend" / "shopping-trips-card.js"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(card), cache_headers=False)]
        )
        # Loads the card on every dashboard, so no manual resource setup is needed
        add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")
        hass.data[_FRONTEND_REGISTERED] = True

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.pop(DOMAIN, None)
    return unloaded
