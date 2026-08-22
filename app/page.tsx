import { Eyebrow, LpButton } from "./design/ui";

export default function Home() {
  return (
    <main className="lp-wrap lp-hero">
      <Eyebrow>Vellar Playground</Eyebrow>
      <h1>Try the facilitator, live.</h1>
      <p className="lp-lead">
        A playground for external developers to visually try out the Vellar x402 payment
        facilitator on Stellar testnet — pay a real invoice, watch the 402 turn into a 200, no
        setup required.
      </p>
      <div className="lp-cta-row">
        <LpButton href="/status">See facilitator status</LpButton>
      </div>
    </main>
  );
}
