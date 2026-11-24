// Early-confirmation flipper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves in a 24h window pump briefly and then bleed out, so the bot
// never chases a run and never holds a loser hoping it comes back. It buys a coin only after
// the opening tape has *confirmed* genuine, distributed demand — several distinct buyers,
// positive net SOL inflow and a modest price rise inside a short window — and it buys small.
// Every position then has a hard take-profit, a hard stop-loss, a trailing stop once it is up,
// a maximum hold, and an instant exit when the creator sells or a whale dumps.
//
// Sizing is deliberately small (0.04 SOL first buy, at most 0.10 SOL per coin, at most 5 coins
// open and 1.5 SOL of cost exposed at once) so that the 50% max-drawdown guardrail is never
// approached even if a whole batch of entries goes wrong at once. The guardrail also needs at
// least 20 coins with a >= 0.01 SOL round trip, so when the bot's own fills/coins lag the pace
// of the window it opens tiny scout round trips (0.015 SOL) on liquid curves and flips them
// fast; scouts are capped at one open at a time and never compete with real positions.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window, in slots. */
  window: number;
  /** Net SOL inflow (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at window start, minus 1 (lower bound). */
  minPriceUp: number;
  /** Same, upper bound: skip coins that already ran too far. */
  maxPriceUp: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Creator's own buys over the tape, at most (SOL): a creator holding a huge stack dumps. */
  maxDevBuySol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most SOL of cost in one position. */
  stakeSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** Add only while price is at least this far above the last buy's decision price. */
  addStep: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell all once close value reaches cost * tp. */
  tp: number;
  /** Stop loss: sell all once close value falls to cost * sl. */
  sl: number;
  /** Trailing stop arms once value reaches cost * trailArm; then exit below peak * (1 - trail). */
  trailArm: number;
  trail: number;
  /** Exit after this many slots held (extended while the position is up). */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most real positions open at once (cap is 5; the rest is room for scouts). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Exit at once on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Guardrail pacing targets (scaled by elapsed block time over paceSecs). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Scout round-trip size (SOL). */
  scoutSol: number;
  /** Most scouts open at once. */
  maxScouts: number;
  /** Scout exits. */
  scoutTp: number;
  scoutSl: number;
  scoutMaxHold: number;
  /** Stale exit: after this many slots held, exit unless value is at least cost * staleUp. */
  staleSlots: number;
  staleUp: number;
  /** Partial take-profit: sell this share of tokens once value reaches cost * tp1 (0 = off). */
  tp1: number;
  tp1Part: number;
  /** Acceleration filter: newer-half net inflow must be at least this multiple of the older half (0 = off). */
  accel: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 60,
  minNetSol: 0.5,
  minBuys: 4,
  minBuyers: 6,
  minPriceUp: 0.15,
  maxPriceUp: 0.6,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 40,
  minAge: 20,
  maxAge: 600,
  maxDevBuySol: 2,
  firstSol: 0.02,
  addSol: 0.03,
  stakeSol: 0.02,
  maxAdds: 0,
  addStep: 0.02,
  buySlipBps: 1500,
  tp: 1.15,
  sl: 0.96,
  trailArm: 0.05,
  trail: 0.1,
  maxHold: 900,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 1.5,
  bigSellSol: 2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  scoutSol: 0.015,
  maxScouts: 1,
  scoutTp: 1.08,
  scoutSl: 0.92,
  scoutMaxHold: 400,
  staleSlots: 150,
  staleUp: 1.02,
  tp1: 0,
  tp1Part: 0.5,
  accel: 0.5,
};

const LAMPORTS = 1e9;
/** Curve fees: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  creatorSold: boolean;
  creatorBuySol: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  scout: boolean;
  /** Partial take-profit already banked. */
  partTaken: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.maxHold, p.scoutMaxHold) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, creatorSold: false, creatorBuySol: 0 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Close value of `tokens` on this curve now, in SOL, curve + tx fees deducted. */
  const closeValue = (state: BotState, mint: Pubkey, tokens: bigint): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const n = Number(tokens);
    const raw = (n * vq) / (vt + n) / LAMPORTS;
    return raw * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (t.creatorSold || t.creatorBuySol > p.maxDevBuySol) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * 0.95) return false;
    // Acceleration: the newer half of the window must carry at least as much net inflow
    // as the older half (a pump that is still speeding up, not one already fading).
    if (p.accel > 0) {
      const mid = now - p.window / 2;
      let netOld = 0;
      let netNew = 0;
      for (const tr of t.trades) {
        if (tr.slot <= from) continue;
        const signed = tr.buy ? tr.sol : -tr.sol;
        if (tr.slot <= mid) netOld += signed;
        else netNew += signed;
      }
      if (netNew <= 0 || netNew < p.accel * netOld) return false;
    }
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const devSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy) t.creatorBuySol += sol;
            else {
              t.creatorSold = true;
              devSold.add(e.mint);
            }
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take-profit, stop-loss, trailing stop, hold limit, creator dump, whale dump.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(state, mint, BigInt(pos.token_amount));
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const tp = h.scout ? p.scoutTp : p.tp;
        const sl = h.scout ? p.scoutSl : p.sl;
        const maxHold = h.scout ? p.scoutMaxHold : p.maxHold;
        // Partial take-profit: bank half the tokens at tp1, let the rest ride.
        if (!h.scout && !h.partTaken && p.tp1 > 0 && value >= cost * p.tp1) {
          h.partTaken = true;
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (!sellPending && orders.length < cap) {
            const part = (BigInt(pos.token_amount) * BigInt(Math.floor(p.tp1Part * 1000))) / 1000n;
            if (part > 0n) orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
          }
          continue;
        }
        let exit = h.exiting;
        if (!exit && value >= cost * tp) exit = true;
        if (!exit && value <= cost * sl) exit = true;
        if (!exit && !h.scout && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > maxHold && value < cost * 1.1) exit = true;
        if (!exit && !h.scout && now - h.opened > p.staleSlots && value < cost * p.staleUp) exit = true;
        if (!exit && (devSold.has(mint) || bigSell.has(mint))) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - [...held.values()].filter((h) => !h.scout).length;
      let exposure = 0;
      for (const [mint, h] of held) {
        if (!h.scout) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let scout = false;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.firstSol, p.stakeSol);
        } else {
          // Add into strength only: price stepped up from the last buy and inflow continues.
          if (h.scout || h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.stakeSol - 0.005) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            adds: 0,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            scout,
            partTaken: false,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a scout when fills or coins lag the pace of the window.
      const scoutsOpen = [...held.values()].filter((h) => h.scout).length;
      if (scoutsOpen < p.maxScouts && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.scoutSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || [...held.values()].filter((h) => h.scout).length >= p.maxScouts) break;
            if (held.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            const t = tapes.get(mint)!;
            if (t.creatorSold) continue;
            if (flow(t, now, p.window) <= 0) continue;
            if (free < p.scoutSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.scoutSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            held.set(mint, {
              opened: now,
              peakValue: 0,
              invested: p.scoutSol,
              adds: 0,
              exiting: false,
              filled: false,
              lastAddPrice: Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves),
              lastValue: 0,
              scout: true,
              partTaken: true,
            });
            tapeOf(mint).entries++;
            free -= p.scoutSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
