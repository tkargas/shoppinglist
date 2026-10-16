"""Constants for Shopping Trips."""

DOMAIN = "shopping_trips"

# Keep in step with manifest.json "version"; also cache-busts the card URL.
VERSION = "0.6.1"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

CARD_URL = f"/{DOMAIN}/shopping-trips-card.js"

DEFAULT_LIST_NAME = "Shopping List"

# Item states used by the card and services
STATE_PENDING = "pending"
STATE_BOUGHT = "bought"
STATE_SKIPPED = "skipped"
