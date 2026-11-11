# FLIGHT COMMAND — AI Air-Combat Command Game

The product is the AI air-combat command game. The WTACRP replay viewer is kept as code reference only, outside the current product direction.

- **AI air-combat command game** (`/game/`): a local Node.js service plus browser client. The player issues text or voice orders; a cloud commander model interprets them, program pilots plan routes, and the same flight-physics kernel validates and executes the plan. Includes a three-level tutorial, airport operations, radar, missiles, RWR and autosave.
- **WTACRP replay viewer (code reference only)** (`/` and `/web/`): Turn a War Thunder `.wrpl` replay into a minimal Ace Combat-style 3D scene: 3D tracks, kill markers, ground units, terrain contours and land/water masks, switchable cameras and playback controls. The server page parses the replay entirely in the browser and makes no network requests. Kept for replay parsing and rendering reference; not part of the product direction.

[中文](README.md) · [Roadmap and team ownership](docs/ROADMAP.md)

## Quick start

- **Game**: Node.js 22.12+, no npm dependencies. Copy `.env.example` to `.env`, set `DASHSCOPE_API_KEY` (commander/ASR) and optionally `INWORLD_API_KEY` (TTS), then run `node server/game-server.mjs` or `start_game.cmd`. Open `http://127.0.0.1:8000/game/`.
- **Tutorial**: `http://127.0.0.1:8000/game/training.html`.
- **Flight data**: `http://127.0.0.1:8000/game/flight-data.html`.
- **Replay (code reference only)**: `python -m http.server 8000` (use `8080` if the game service already occupies 8000), then open `http://localhost:8000/` or `/web/`. The reference tool page can still be deployed to GitHub Pages.
  - `index.html` — demo with one pre-generated match; `web/index.html` — drop in any `.wrpl`.
  - Rendering: three.js r186; parsing: `web/wrpl-parse.js` plus fzstd.
  - Terrain comes from the [WT-MAP-ANALYZE](https://github.com/ShioUmiusi/WT-MAP-ANALYZE) dataset (`data-2026.10` tag) and is packed at build time by `tools/pack_terrain.py`; a sample map is included for local use.
  - Python tools decode the replay container, tracks, kill events and ECS data into `mission-data.js`; see `docs/` for the format and the exact commands.
- **Tests**: `node --test tests/*.test.mjs` — 461 tests across 58 files.

## Design invariant

Models propose, programs decide. Model output must match a strict JSON Schema and pass field-level validation; candidate routes are flown through the same physics kernel before being committed atomically. Continuous control never calls the model per frame. Unimplemented capabilities are reported as unavailable rather than simulated.

## Current gaps

- CI checks syntax and demo data but does not run the 461-test suite, and it uses Node 20 while the project requires 22.12+.
- There is no `package.json`; startup and tests call `node` directly.
- The product is cloud-only; the local 2B pilot model is disabled and no longer supported.
- In the WTACRP reference implementation, ground-unit sides come from the replay's ECS `team` component; units without it stay `unknown` and are not guessed from position. The older position-based inference has been replaced.
- In the WTACRP reference implementation, air-unit side direction remains a pure replay inference; external capture colors confirm self-consistency but do not provide absolute truth.

## Licensing risk

The root `LICENSE` is MIT, but the replay decoder references/ports AGPL-3.0 projects, and `terrain/airfields.json` is itself marked AGPL-3.0. The repository is therefore mixed-license until this is resolved. Read [docs/LICENSE-RISKS.md](docs/LICENSE-RISKS.md) before public release or commercial use.

## Data and licensing

Replay positions and events come from the `.wrpl` itself: `ptype=2` FlightModel tracks, `ptype=4` kill packets and ground sync, `ptype=6` ECS ground/airfield markers with `team`, and the embedded result block's player table. Fields that cannot be decoded are left empty, never invented.

The bundled demo data is anonymized (player names, account ids and clan tags are synthetic). No original game assets are redistributed; War Thunder is property of Gaijin Entertainment and this project is not affiliated with Gaijin.

The root `LICENSE` is MIT, but the replay decoder's derivation status is unresolved and the airfield catalogue is AGPL-3.0; do not treat the whole repository as MIT. Third-party notices are in `THIRD-PARTY-NOTICES.md`, and the risk register is [docs/LICENSE-RISKS.md](docs/LICENSE-RISKS.md).
