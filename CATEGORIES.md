# Turnkey quotation builder — category reference

The quotation builders filter the Products / Hardwares / Labour databases by the
`category` value. Enter these exact categories when adding data so items show up
in the right builder.

**Matching is case-insensitive and trims spaces** (`Plywood` = `plywood`), but
pick one consistent spelling.

## Products database (`category`)

| Category to enter | Where it's used |
| --- | --- |
| **Plywood** | Box & Shutters (plywood brand/type) · Wall Panels (Base & Framed plywood) |
| **Laminate** | Box & Shutters (outer/inner laminate) · Wall Panels (laminate/panel) |
| **Panel** | Wall Panels only (shows in the laminate/panel dropdown alongside Laminate) |
| **Paint** | Paint work |
| **Civil** | Civil Work → Material |
| **Electrical** | Electrical Work → Material |

Notes:

- A **Laminate** product appears in *both* Box & Shutters and Wall Panels; a
  **Panel** product appears in Wall Panels only.
- Within a category, **brand** and **plywood type** (sub-category) are free text —
  they drive the brand/type dropdowns.
- **Thickness matters:** Box & Shutters matches the thickness from your cutlist;
  Wall Panels needs an **8 mm** board for *Base* and a **16 mm** board for
  *Framed* under the chosen brand/type.

## Hardwares database (`category`) — Box & Shutters only

| Category to enter | Where it's used |
| --- | --- |
| **Edge hinges** | Edge hinge dropdown |
| **Inner hinges** | Inner hinge dropdown |
| **Handle** | Handles (chosen per part-category) |
| **Channel** | Drawer channels (auto-picked by panel size) |

## Labour database (`Labour category`)

**Not builder-specific** — every builder's Labour section (Box & Shutters, Wall
Panels, Civil, Electrical) shows **all** labour categories you define, then
cascades **category → name → task**.

Seeded defaults (rename/extend freely): **Carpenter, Painter, Plumber,
Electrician, Civil**.

## Bonus — Box & Shutters cutlist designations

Not a category filter, but the cutlist CSV **Designation** prefix must match a
row in the part-logic table (Database → Box logic). Seeded values:

`Carcass outer`, `Back ply`, `Skirting`, `Partition`, `Shelf`, `Drawer side`,
`Drawer outer`, `Drawer Shutter`, `Edge Shutter`, `Inner Shutter`,
`Special shutter`.
