"""HTTP endpoints for receipt images: upload from the card, and serve them back (HA login required for both)."""

from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
import uuid

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import KEY_HASS

from .const import DOMAIN
from .store import NotFound, ShoppingStore

# Images are resized in the browser before upload; this is a safety limit
MAX_IMAGE_BYTES = 15 * 1024 * 1024


def receipts_dir(hass: HomeAssistant) -> Path:
    return Path(hass.config.path(DOMAIN, "receipts"))


def remove_files(hass: HomeAssistant, names: list[str]) -> None:
    """Deletes receipt image files (run in the executor)."""
    folder = receipts_dir(hass)
    for name in names:
        (folder / Path(name).name).unlink(missing_ok=True)


class ReceiptUploadView(HomeAssistantView):
    """POST /api/shopping_trips/receipt — multipart form with trip_id, image and optional text."""

    url = f"/api/{DOMAIN}/receipt"
    name = f"api:{DOMAIN}:receipt_upload"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        store: ShoppingStore | None = hass.data.get(DOMAIN)
        if store is None:
            return self.json_message("Shopping Trips isn't set up", HTTPStatus.SERVICE_UNAVAILABLE)
        form = await request.post()
        trip_id = form.get("trip_id")
        image = form.get("image")
        text = form.get("text") or ""
        if not isinstance(trip_id, str) or not isinstance(image, web.FileField):
            return self.json_message("trip_id and image are required", HTTPStatus.BAD_REQUEST)
        try:
            store.get_trip(trip_id)
        except NotFound:
            return self.json_message("Trip not found", HTTPStatus.NOT_FOUND)

        name = f"{uuid.uuid4().hex}.jpg"

        def save() -> int:
            folder = receipts_dir(hass)
            folder.mkdir(parents=True, exist_ok=True)
            data = image.file.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                return -1
            (folder / name).write_bytes(data)
            return len(data)

        size = await hass.async_add_executor_job(save)
        if size < 0:
            return self.json_message("Image too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        receipt = store.add_receipt(trip_id, name, str(text))
        return self.json(receipt)


class ReceiptImageView(HomeAssistantView):
    """GET /api/shopping_trips/receipt/{receipt_id} — the card loads these through signed URLs."""

    url = f"/api/{DOMAIN}/receipt/{{receipt_id}}"
    name = f"api:{DOMAIN}:receipt_image"
    requires_auth = True

    async def get(self, request: web.Request, receipt_id: str) -> web.StreamResponse:
        hass: HomeAssistant = request.app[KEY_HASS]
        store: ShoppingStore | None = hass.data.get(DOMAIN)
        try:
            receipt = store.get_receipt(receipt_id) if store else None
        except NotFound:
            receipt = None
        if receipt is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        path = receipts_dir(hass) / Path(receipt["file"]).name
        if not await hass.async_add_executor_job(path.is_file):
            return web.Response(status=HTTPStatus.NOT_FOUND)
        return web.FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})
