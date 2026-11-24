# makefun-pumpfun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vora95/makefun-pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vora95/makefun-pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Early-confirmation flipper for the Pump.fun Replay Sprint: a paper trading bot (10 SOL) for the house pump.fun replay harness (agent-fun/replay/v2). It buys a bonding curve only after the opening tape confirms genuine, distributed demand — several distinct buyers, positive net SOL inflow that is still accelerating, and a modest price rise — then flips fast with a hard take-profit, stop-loss, trailing stop, hold limit and instant exit on creator dumps. Small stakes (0.02 SOL per coin, max 5 open, max 1.5 SOL exposed) keep drawdown low while trading 150+ coins to clear the 20-coin guardrail.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (hello / batch / done, one reply per batch). No dependencies, no network, no clock, no randomness — two runs produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
