# Shopping Trips for Home Assistant

Shopping lists for Home Assistant, ported from the Shopping List Android app. Each list is also an HA
**to-do list**, so it works in HA's To-do screen, the iPhone/Android Companion apps, voice assistants and
automations. The **Shopping Trips card** gives the full app experience on a dashboard.

## Status

| Phase | Features | State |
|---|---|---|
| 1 | Lists, items, swipe to cross off (bought / not bought), to-do entities, dashboard card | ✅ Done |
| 2 | Finish Shopping, trips, trip items and sub-items, unit price × quantity, total override, last price | ✅ Done |
| 3 | Receipts: camera, several photos, full-screen zoom, text reading, mapping lines to items, new trip from receipt | ✅ Done |
| 4 | Item details (category, favourite, photo, barcode), CSV import/export, settings | ✅ Done |

## Install

### HACS (custom repository)
1. HACS → ⋮ → **Custom repositories** → add this repository's URL, category **Integration**.
2. Install **Shopping Trips**, then restart Home Assistant.
3. **Settings → Devices & services → Add integration → Shopping Trips**.

### Manual
1. Copy `custom_components/shopping_trips` into your HA `config/custom_components/` folder
   (e.g. with the Samba or File editor add-on).
2. Restart Home Assistant, then add the integration as above.

Requires Home Assistant 2024.7 or newer.

## The dashboard card

The card is installed with the integration; no extra resource setup is needed. Add it to a dashboard:

```yaml
type: custom:shopping-trips-card
list: Shopping List   # optional: which list to open first
```

- **Swipe right** (or tap): crossed off as **bought** — it goes into the current trip.
- **Swipe left**: crossed off as **not bought** — left out of the trip.
- Tap a crossed-off item to put it back on the list.
- ⓘ on a row opens the item: name, quantity (− FEWER / + MORE), favourite, category, list, last purchased date, barcode (type it or
  SCAN a photo of it), note, photo (take or choose), last unit price, delete.
- ⋮ next to the list name also has **Export list (CSV)**, **Import list (CSV)** (same format as the Android
  app) and **Settings**, which shows the card and integration versions.
- Add items by typing, or pick an existing item from the suggestions.
- ⋮ next to the list name: new, rename or delete lists.
- **Finish Shopping** saves the bought items as a trip; they stay crossed off on the list.
- The history button opens **Shopping Trips**: search by item or store, tap a trip to see its items.
- In a trip, tap an item to edit it full screen: quantity (decimals allowed), unit price, total
  (calculated, or tap it to type your own), a note, sub-items, and the last price paid. ⋮ has Unpriced first,
  Edit date, Edit store and Delete trip.
- **Receipts:** the camera button on a trip adds receipt photos (take new ones or pick several from the
  gallery); their text is read automatically. Trip ⋮ → **Receipts** lists them. Tap one to view it full
  screen (pinch to zoom, drag, double-tap), and **TEXT** to see its lines: tap a priced line to choose the
  trip item it belongs to, or **Fill prices automatically**.
- **New trip from receipt:** the camera button on Shopping Trips builds a trip from receipt photos — tick
  the detected items, set the store and date, and Create.

Receipt text is read in the browser with [Tesseract.js](https://tesseract.projectnaptha.com/), which is
downloaded from the internet the first time it's used. Barcodes are read with the
browser's own detector where available, otherwise [html5-qrcode](https://github.com/mebjas/html5-qrcode),
also downloaded on first use. Receipt and item photos are stored in `config/shopping_trips/receipts/` and
`config/shopping_trips/photos/`, and are only served to logged-in users.

After updating the integration, refresh the browser (or the Companion app) so the new card version loads.

## To-do entities

Each list appears as `todo.<list name>`. Items on the list are *needs action*; crossed-off items are
*completed*. Ticking an item in HA counts as **bought**. Use HA's standard actions, for example:

```yaml
action: todo.add_item
target:
  entity_id: todo.shopping_list
data:
  item: Milk
```

## Data

Everything is stored in HA's `.storage/shopping_trips` file and is included in HA backups.

## Moving from the Android app

1. In the Android app (version 29 or later): **Settings → Export everything**, and save the `.zip`
   somewhere you can reach from your phone or computer (Downloads, Google Drive, …).
2. In the card: ⋮ → **Settings → Import from Android backup**, and pick that `.zip`.

Lists and items are matched by name, so nothing already in Home Assistant is duplicated or changed. Trips
keep their dates, stores, prices, sub-items and total overrides; receipts keep their text and scan dates.
Photos are resized and uploaded one by one. The same backup can only be imported once.

## Keeping the Android app in sync

The Android app (version 30 or later) syncs both ways with this integration and keeps working on its own
when Home Assistant can't be reached.

1. In Home Assistant, open your profile → **Security** → **Long-lived access tokens** → **Create token**.
2. In the app: **Settings → Home Assistant sync**, enter your Home Assistant address (one that works away
   from home too, e.g. your Nabu Casa URL) and the token, then **Save & sync**.

The app syncs when it opens, every 20 seconds while it's in use, and when you leave it; **Sync now** forces a
sync. Lists, items, trips, trip items and receipts sync, and receipt and item photos are uploaded and
downloaded in the background. If the same thing was changed in both places while they were apart, the phone's
change wins. On the first sync, anything already brought across with the one-off migration is matched up
rather than duplicated.
