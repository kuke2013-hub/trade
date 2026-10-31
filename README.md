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
- Initially scans a diversified candidate sample by trading volume, positive 24-hour movers and large absolute moves. Additional pair charts are loaded on scroll. Not every displayed pair is always analysed; the UI distinguishes **unscanned** from **analysed**.
- Displays 1-hour candles with a previous-high resistance guide and ranks candidates on a **heuristic 0–100 setup score**. This score is emphatically **not a calibrated probability** of a 2% price rise.
- Runs four independent rules on **completed** hourly candles: resistance breakout, volume-confirmed breakout, volatility-compression breakout, and relative-strength breakout versus BTC.
- Provides four separate simulated spot portfolios with $10,000 initial cash, $200 virtual position sizes, three simultaneous positions per strategy, +2% gross execution-price target, −1.5% gross execution-price stop, 24-hour holding timeout, 0.1% simulated fee per side and 0.05% simulated slippage per side.
- Records virtual entries, exits, fees and realised P&L in browser `localStorage`; downloadable CSV provides an audit trail of closed trades.
- Only opens a paper position after an observed signal on a recently closed candle and a **fresh public best-ask quote**. Paper exits are checked against retrieved **completed 1-minute candles**. If stop and target both appear within a candle, stop is assumed to execute first. This conservative ambiguity rule reduces one source of optimistic bias.
- Missing real market data never triggers a synthetic or estimated trade. Positions with large data gaps are visibly flagged instead of quietly credited with profit.

## Crucial limitations

**The paper engine runs only while the web page is open and sufficiently active.** GitHub Pages is static hosting. Closing or background-suspending the browser interrupts scans and position monitoring. There is no unattended 24/7 paper bot or server database in this prototype. For that, use a scheduled worker/service with persistent storage and a verified market-data capture and fill simulator.

The website is **not a continuous tick-level feed**. It polls public REST endpoints about every five minutes, with closer checks for open positions. Signals can be missed and delayed. Candles do not provide a true historical bid/ask order-book replay, so simulated fills, slippage and costs are approximations. Gap handling makes no assertion about what happened between available observations. Local trades are not synced between browsers/devices and can disappear if browser storage is deleted.

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

The ranking score adds weighted breakout, trend, relative-strength, volume and compression attributes. It is purely a screening convenience, not a probability or empirical estimate of return.

## Safety

This application has **no Binance trading permissions, private-account access or order submission code**. There is no API-key collection and no hidden demo-data mode. Do not treat rankings as investment advice.

Data sources: [Binance market-data-only API](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [Binance candlestick reference](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md).