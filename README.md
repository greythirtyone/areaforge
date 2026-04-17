# AreaForge

Electron app that accepts an address (city + state), prioritizes Washington/Oregon results, pulls public datasets, auto-fills an Area Study template, and exports PDF/Markdown.

## Features
- Address input and radius search
- Extensible focus-region config (`src/focus-regions.json`) for preferred states/counties
- Automated data pulls from:
  - Nominatim geocoder
  - US Census geographies + ACS snapshot
  - FEMA flood zone lookup
  - OpenStreetMap Overpass POIs
- Template auto-fill with answers where data is available
- Export completed report to `.md` and `.pdf`

## Run locally
```bash
cd areaforge
npm install
npm start
```

## Notes
- Some template fields intentionally remain placeholders where no reliable public API source is integrated yet.
- PDF export captures the renderer contents as displayed in the app.

### Configure preferred states/counties
Edit `src/focus-regions.json`:

```json
{
  "states": [
    { "name": "Washington", "abbreviations": ["WA"], "counties": ["King", "Pierce"] },
    { "name": "Oregon", "abbreviations": ["OR"], "counties": [] }
  ]
}
```

- If `counties` is empty for a state, any county in that state is allowed.
- If `counties` has values, those county names are preferred for that state.

