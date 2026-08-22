# Vellar Playground

A playground web app for external developers to visually try out the [Vellar x402 payment
facilitator](https://github.com/Vellar-Wallet/vellar-facilitator) on Stellar testnet — pay a real
invoice, watch a 402 turn into a 200, no wallet setup required.

This is an early scaffold. The guided demo flow, `/status`, `/catalog`, and `/console` pages are
built out in later work; right now this repo just has the app shell and design system wired up.

## Running locally

```bash
pnpm install
cp .env.example .env.local
# edit .env.local and set SESSION_SECRET (see the comment in .env.example
# for how to generate one)
pnpm dev
```

Then open http://localhost:3000.

By default the app talks to the hosted testnet facilitator and seller demo (see
`FACILITATOR_URL` / `SELLER_URL` in `.env.example`) — no local facilitator needed to try it out.

## Stack

- Next.js (App Router) + TypeScript + React 19
- pnpm
- Hand-written CSS design system (`app/design/`) — no Tailwind, no component library
- `iron-session` for the server-side session cookie (`lib/session.ts`)
