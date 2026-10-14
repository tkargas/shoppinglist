# Shopping Trips for Home Assistant

Shopping lists for Home Assistant, ported from the Shopping List Android app. Each list is also an HA
**to-do list**, so it works in HA's To-do screen, the iPhone/Android Companion apps, voice assistants and
automations. The **Shopping Trips card** gives the full app experience on a dashboard.

## Status

| Phase | Features | State |
|---|---|---|
| 1 | Lists, items, swipe to cross off (bought / not bought), to-do entities, dashboard card | ✅ Done |
| 2 | Finish Shopping, trips, trip items and sub-items, unit price × quantity, total override, last price | ✅ Done |
| 3 | Receipts: camera, several photos, full-screen zoom, text reading, mapping lines to items, new trip from receipt | Planned |
| 4 | Item details (category, favourite, photo, barcode), CSV import/export, settings | Planned |

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
- Add items by typing, or pick an existing item from the suggestions.
- ⋮ next to the list name: new, rename or delete lists.
- **Finish Shopping** saves the bought items as a trip; they stay crossed off on the list.
- The history button opens **Shopping Trips**: search by item or store, tap a trip to see its items.
- In a trip, tap an item to edit it full screen: quantity (decimals allowed), unit price, total
  (calculated, or tap it to type your own), sub-items, and the last price paid. ⋮ has Unpriced first,
  Edit date, Edit store and Delete trip.

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
