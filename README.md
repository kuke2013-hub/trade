# Breakout Lab

An experimental **Binance USDT spot market** breakout screener and browser-based **paper trading** website. No exchange account, API key, real order, leverage, futures position, or paid data subscription is used.

**Project status:** functional research prototype, **not** a statistically validated profitable strategy.

## Live deployment

This is a static web application. To publish from the `main` branch:

1. In this repository visit **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/(root)**, then **Save**.
3. Wait for the GitHub Pages build to complete and open `https://kuke2013-hub.github.io/trade/`.

The GitHub Actions **CI** workflow tests the core algorithms on each push; Pages deployment is separate from CI and requires the repository Pages setting above.

## What it does

- Fetches live public `/api/v3/exchangeInfo`, `/api/v3/ticker/24hr` and 1-hour `/api/v3/klines` data from `https://data-api.binance.vision` without keys.
- Lists up to 360 liquid, currently tradable **spot USDT** pairs after basic liquidity and leveraged-token exclusions.
- Scans all currently eligible displayed pairs, not just the top gainers. Price snapshots and the approaching-resistance ranking refresh approximately every **60 seconds** while the page is active. Binance metadata is cached for one hour and completed 1h candle histories are refreshed only when a new hourly candle should have closed.
- Displays selectable **1-month (`1M`), 1-week (`1w`), 1-day (`1d`), 1-hour (`1h`), 5-minute (`5m`), 3-minute (`3m`) and 1-minute (`1m`)** candles in the pair explorer and the enlarged chart. Charts lazily retrieve real Binance candles (including the currently forming candle); requests are cached by symbol and interval. The **model always uses only completed hourly candles**, regardless of chart selection. The hourly chart has a previous-high resistance guide. The explorer ranks **approaching resistance first**, confirmed breakouts next, then lower-quality and unscanned coins. An independent **0–100 readiness score** combines distance to the preceding 24-hour high (the latest candle is excluded), EMA trend, volume, relative strength, RSI, MACD and compression. The existing confirmed-breakout score remains separate. The cards include compact proximity, RSI(14), and volume/20h average bars; expanded charts overlay EMA(9) and EMA(21) and calculate EMA(50), MACD(12,26,9), Bollinger(20,2), ATR(14), and RSI(14) for the selected candle interval. This score is emphatically **not a calibrated probability** of a 2% price rise.
- Runs four independent rules on **completed** hourly candles: resistance breakout, volume-confirmed breakout, volatility-compression breakout, and relative-strength breakout versus BTC.
- Provides four separate simulated spot portfolios with $10,000 initial cash, $200 virtual position sizes, three simultaneous positions per strategy, +2% gross execution-price target, −1.5% gross execution-price stop, 24-hour holding timeout, 0.1% simulated fee per side and 0.05% simulated slippage per side.
- Records virtual entries, exits, fees and realised P&L in browser `localStorage`; downloadable CSV provides an audit trail of closed trades.
- Only opens a paper position after an observed signal on a recently closed candle and a **fresh public best-ask quote**. Paper exits are checked against retrieved **completed 1-minute candles**. If stop and target both appear within a candle, stop is assumed to execute first. This conservative ambiguity rule reduces one source of optimistic bias.
- Missing real market data never triggers a synthetic or estimated trade. Positions with large data gaps are visibly flagged instead of quietly credited with profit.

## Crucial limitations

**The paper engine runs only while the web page is open and sufficiently active.** GitHub Pages is static hosting. Closing or background-suspending the browser interrupts scans and position monitoring. There is no unattended 24/7 paper bot or server database in this prototype. For that, use a scheduled worker/service with persistent storage and a verified market-data capture and fill simulator.

The website is **not a continuous tick-level feed**. The research engine attempts a fresh full-universe **price/ranking scan every 60 seconds**, while computing trading signals only from completed **hourly** candles; the **visible** 1m/3m/5m charts and any open short-interval detail chart are refreshed approximately every 60 seconds while the page is active. Only the first 24 visible charts are refreshed per cycle to control request volume; the manual Refresh visible charts button can update the current timeframe. Those graphical updates use current/forming candles; pre-breakout proximity ranking uses newly retrieved live ticker prices and the last completed hourly indicators; actual paper entries and breakout triggers still use closed hourly candles. The approximately 60-second scan is best-effort, skips overlapping runs, and the real refresh cadence depends on tab visibility, network latency, Binance rate limits and browser scheduling. Open paper positions are checked more frequently. Signals can be missed and delayed. Candles do not provide a true historical bid/ask order-book replay, so simulated fills, slippage and costs are approximations. Gap handling makes no assertion about what happened between available observations. Local trades are not synced between browsers/devices and can disappear if browser storage is deleted.

There is no evidence yet that the four strategies earn positive returns. Unit tests demonstrate mathematical and signal-rule behaviour; they **do not** establish predictive power or trading profitability. Independent multi-year walk-forward backtesting, spread-aware execution simulation and forward monitoring are the next research stages.

## Local development

Requires Node 20+ for tests and any static HTTP server for the site.

```bash
node --test tests/*.test.mjs
python3 -m http.server 8000
```

Open `http://localhost:8000/`. If Binance is blocked in your location, the site reports an error rather than filling charts with fabricated values.

## Models

Each model requires the most recent completed 1-hour candle to close at least 0.1% above the highest high of the 24 preceding completed hourly candles and finish in the upper 40% of its range:

- `breakout`: breakout confirmation alone.
- `volume`: breakout and volume ≥1.5× the mean volume of 20 previous completed candles.
- `compression`: breakout and pre-breakout 8-bar average range less than 80% of the preceding 24-bar average range; volume ≥1.2× its 20-bar mean.
- `strength`: breakout plus relative 24-hour performance versus BTC ≥3 percentage points and a bullish EMA(9) > EMA(21) > EMA(50) order.

Pre-breakout classification uses the refreshed last-traded price below but within 3% of resistance calculated from completed hourly candles, with either a bullish EMA trend or confirmatory RSI/MACD/volume behaviour. Confirmed signals are displayed separately. Readiness weights proximity to resistance, technical momentum, relative strength, compression and volume. **Neither score has been calibrated against out-of-sample outcomes, and approaching resistance does not open a paper trade.**

## Safety

This application has **no Binance trading permissions, private-account access or order submission code**. There is no API-key collection and no hidden demo-data mode. Do not treat rankings as investment advice.

Data sources: [Binance market-data-only API](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [Binance candlestick reference](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md).

## Automated validation

The GitHub Actions pipeline runs **21 deterministic unit tests** for candle filtering, all four signal models, fees, stop/target ambiguity, time-based exits, data-gap rejection and duplicate orders. It also runs a Chromium/Playwright **UI integration smoke test** against explicitly synthetic exchange-shaped fixtures (no synthetic data is shipped in the production application). The browser test checks large-universe rendering, approaching-resistance priority, a confirmed breakout, a simulated order, detailed technical indicators, seven chart intervals, manual refreshed-bar requests and symbol filtering. These confirm software behaviour, **not** profitability or real-world exchange availability.

## Chart timeframes

Use the **CANDLE INTERVAL** buttons above the pair cards to change all small charts. Open a pair to select a different interval in its detailed chart independently. `1M` means a monthly candle; `1m` means a one-minute candle. The most recent candle in the chart can still be forming, while trading signals always use **completed hourly candles**. The eligible-market ticker feed and resistance-proximity ranking are refreshed every ~60 seconds while the tab is active. Visible 1m, 3m and 5m charts are also re-requested every ~60 seconds; other chart intervals can be refreshed manually. Closed hourly signals are unchanged until the next hourly close. This is **polling, not an uninterrupted streaming feed**, and Binance may rate limit or delay requests.

## Breakout radar interface

The top **Potential and confirmed breakouts** section now combines two distinct classifications: up to eight **confirmed hourly breakouts** appear first in red-bordered cards with a gentle pulsing glow; up to eight **approaching-resistance** candidates appear immediately afterward in standard teal styling. The animation respects reduced-motion accessibility preferences. Each card retains its existing detailed analysis on click. There is no longer a second visible confirmed-breakout section. This is a UI/ranking presentation change only: the four trading algorithms, hourly entry requirements, fee assumptions, and paper-trading logic are unchanged. A red card is a rule trigger, not proof of future price gains.

## Confirmed-breakout highlights and paper-trade chart markers

- The first radar includes **confirmed hourly breakouts first**, each with a **double red outline and subtly pulsing glow**. Approaching-resistance candidates follow with a **single red border**. The same treatment is applied to eligible cards in the larger pair explorer. This is visual prioritisation, **not a claim of future profit**.
- Clicking a pair with a **recorded local paper position** automatically opens its **1-minute** detailed chart. A trade selector can choose among paper positions belonging to different models and older closed trades for that pair. Clicking a trade in the ledger opens exactly that trade.
- The 1-minute chart overlays the **actual recorded simulated entry timestamp and fill**, the simulator's **stop-loss trigger quote**, its **+2% take-profit/sell trigger**, and—for closed trades—the **recorded simulated sell timestamp and execution price**. Stop and target trigger quotes reflect the configured simulated exit slippage.
- **Entry window** loads historical minute candles around the entry; **Sell window** jumps to the exit (only available for closed trades); **Latest** shows the current minute candles. This avoids pretending that an old trade occurred on the latest candle. Markers are plotted only when Binance 1-minute candles actually cover the stored event timestamp. If historical candles are unavailable, the chart reports the failure rather than manufacturing a marker.
- Signal-only pairs have no trade markers. These are **browser-local hypothetical fills**, not orders placed at Binance. Minute OHLC charts establish only minute-level context; they cannot prove actual tick-by-tick fills or accurate bid/ask replay.