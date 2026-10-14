"""HTTP endpoints for receipt and item photos: upload from the card, and serve them back (HA login required)."""

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


def photos_dir(hass: HomeAssistant) -> Path:
    return Path(hass.config.path(DOMAIN, "photos"))


def remove_files(hass: HomeAssistant, names: list[str], folder: Path | None = None) -> None:
    """Deletes image files (run in the executor); receipts by default."""
    folder = folder or receipts_dir(hass)
    for name in names:
        if name:
            (folder / Path(name).name).unlink(missing_ok=True)


def remove_photos(hass: HomeAssistant, names: list[str]) -> None:
    remove_files(hass, names, photos_dir(hass))


async def _save_upload(hass: HomeAssistant, folder: Path, image: web.FileField) -> str | None:
    """Writes an uploaded image under a new random name; None if it's too large."""
    name = f"{uuid.uuid4().hex}.jpg"

    def save() -> bool:
        folder.mkdir(parents=True, exist_ok=True)
        data = image.file.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            return False
        (folder / name).write_bytes(data)
        return True

    return name if await hass.async_add_executor_job(save) else None


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

        name = await _save_upload(hass, receipts_dir(hass), image)
        if name is None:
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


class ItemPhotoUploadView(HomeAssistantView):
    """POST /api/shopping_trips/item_photo: multipart form with item_id and image; replaces any earlier photo."""

    url = f"/api/{DOMAIN}/item_photo"
    name = f"api:{DOMAIN}:item_photo_upload"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        store: ShoppingStore | None = hass.data.get(DOMAIN)
        if store is None:
            return self.json_message("Shopping Trips isn't set up", HTTPStatus.SERVICE_UNAVAILABLE)
        form = await request.post()
        item_id = form.get("item_id")
        image = form.get("image")
        if not isinstance(item_id, str) or not isinstance(image, web.FileField):
            return self.json_message("item_id and image are required", HTTPStatus.BAD_REQUEST)
        try:
            store.get_item(item_id)
        except NotFound:
            return self.json_message("Item not found", HTTPStatus.NOT_FOUND)
        name = await _save_upload(hass, photos_dir(hass), image)
        if name is None:
            return self.json_message("Image too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        old = store.set_item_photo(item_id, name)
        if old:
            await hass.async_add_executor_job(remove_photos, hass, [old])
        return self.json({"photo": name})


class ItemPhotoView(HomeAssistantView):
    """GET /api/shopping_trips/item_photo/{photo}: each upload gets a new name, so URLs never go stale."""

    url = f"/api/{DOMAIN}/item_photo/{{photo}}"
    name = f"api:{DOMAIN}:item_photo"
    requires_auth = True

    async def get(self, request: web.Request, photo: str) -> web.StreamResponse:
        hass: HomeAssistant = request.app[KEY_HASS]
        store: ShoppingStore | None = hass.data.get(DOMAIN)
        if store is None or store.item_with_photo(photo) is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        path = photos_dir(hass) / Path(photo).name
        if not await hass.async_add_executor_job(path.is_file):
            return web.Response(status=HTTPStatus.NOT_FOUND)
        return web.FileResponse(path, headers={"Cache-Control": "private, max-age=604800"})
