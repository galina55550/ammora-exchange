import { useEffect, useState } from "react";
import {
  createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData,
  erc20Abi, formatEther, formatUnits, http, parseUnits, zeroAddress,
} from "viem";
import {
  AmmoraV4LaunchCurveClient, ammoraLaunchFactoryV4Abi, ammoraLaunchPoolV4Abi,
  buildCreateAmmoraV4Launch, classifyAmmoraV4ExactInputFill, getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId, giwaSepoliaAutoRoute, giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4LaunchCreatedReceipt, resolveAmmoraFinalizedHead, verifyAmmoraV4CoreAtBlock,
} from "@ammora-protocol/sdk";

const deployment = giwaSepoliaAutoRouteDeployment;
const contracts = deployment.contracts.launch;
const rpcUrl = deployment.chain.rpcUrls[0];
const EXPLORER = "https://sepolia-explorer.giwa.io";
const core = {
  configRegistry: contracts.configRegistry, launchFactory: contracts.factory,
  graduationAdapter: contracts.graduationAdapter, feePolicy: contracts.feePolicy,
};
const chain = defineChain({
  id: deployment.chain.id, name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency, rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
const wethAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const fmtErr = (e: any) => e?.shortMessage ?? e?.message ?? String(e);
const fmtUnits = (v: bigint, d: number) =>
  Number(formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const STATUS: Record<number, string> = { 1: "Live", 2: "Ready to graduate", 3: "Graduated" };

type Row = { curve: `0x${string}`; token: `0x${string}`; name: string; symbol: string; status: number; block: bigint; tx: string };

async function connectWallet(): Promise<`0x${string}`> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("Wallet not found. Install MetaMask.");
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  const [addr] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); }
  catch { await wallet.addChain({ chain }); await wallet.switchChain({ id: chain.id }); }
  return addr;
}
const walletFor = (account: `0x${string}`) =>
  createWalletClient({ account, chain, transport: custom((window as any).ethereum) });

/* ───────────── Trade modal ───────────── */
function TradePanel({ row, account, onConnect, onClose }: any) {
  const [info, setInfo] = useState<any>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [bal, setBal] = useState<{ q: bigint; b: bigint }>({ q: 0n, b: 0n });
  const [wrapAmt, setWrapAmt] = useState("0.001");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const rd = (token: any, fn: string, args: any[] = []) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: fn, args } as any) as Promise<any>;

  useEffect(() => {
    (async () => {
      try {
        const head = await client.getBlockNumber();
        const st: any = await new AmmoraV4LaunchCurveClient(client, row.curve, core).getStateAtBlock(head);
        const [qSym, qDec, bDec] = await Promise.all([rd(st.quoteToken, "symbol"), rd(st.quoteToken, "decimals"), rd(st.baseToken, "decimals")]);
        setInfo({ quoteToken: st.quoteToken, baseToken: st.baseToken, qSym, qDec: Number(qDec), bDec: Number(bDec), status: st.status });
      } catch (e) { setErr(fmtErr(e)); }
    })();
  }, [row.curve]);

  useEffect(() => {
    if (!info || !account) return;
    (async () => {
      try {
        const [q, b] = await Promise.all([rd(info.quoteToken, "balanceOf", [account]), rd(info.baseToken, "balanceOf", [account])]);
        setBal({ q, b });
      } catch { /* ignore */ }
    })();
  }, [info, account, done]);

  useEffect(() => {
    setQuote(null); setQuoteErr(null);
    if (!info || info.status !== 1 || !amount || Number(amount) <= 0) return;
    const t = setTimeout(async () => {
      try {
        const baseForQuote = side === "sell";
        const amountIn = parseUnits(amount, baseForQuote ? info.bDec : info.qDec);
        const head = await client.getBlockNumber();
        const q: any = await new AmmoraV4LaunchCurveClient(client, row.curve, core).quoteExactInputAtBlock(amountIn, baseForQuote, head);
        const fill: any = classifyAmmoraV4ExactInputFill(q, baseForQuote);
        setQuote({ out: q.amountOut, kind: fill.kind });
      } catch (e) { setQuoteErr(fmtErr(e)); }
    }, 500);
    return () => clearTimeout(t);
  }, [amount, side, info]);

  async function wrap() {
    setErr(null); setDone(null);
    try {
      if (!account) throw new Error("Connect your wallet first.");
      setBusy(true); setMsg("Confirm wrapping in your wallet…");
      const hash = await walletFor(account).sendTransaction({
        account, chain, to: info.quoteToken, value: parseUnits(wrapAmt, 18),
        data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
      });
      await client.waitForTransactionReceipt({ hash, retryCount: 0, pollingInterval: 3000, timeout: 120_000 });
      setDone("Wrapped " + wrapAmt + " ETH into " + info.qSym);
    } catch (e) { setErr(fmtErr(e)); } finally { setBusy(false); setMsg(null); }
  }

  async function trade() {
    setErr(null); setDone(null);
    try {
      if (!account) throw new Error("Connect your wallet first.");
      if (!quote || quote.kind !== "full") throw new Error("This amount can't be filled in full right now. Try a smaller amount.");
      setBusy(true);
      const baseForQuote = side === "sell";
      const tokenIn = baseForQuote ? info.baseToken : info.quoteToken;
      const amountIn = parseUnits(amount, baseForQuote ? info.bDec : info.qDec);
      const head = await client.getBlockNumber();
      const sdk = new AmmoraV4LaunchCurveClient(client, row.curve, core);
      const bound = await client.readContract({ address: contracts.factory, abi: ammoraLaunchFactoryV4Abi, functionName: "tokenForCurve", args: [row.curve] } as any);
      if (bound === zeroAddress || String(bound).toLowerCase() !== info.baseToken.toLowerCase()) throw new Error("Curve is not bound to the reviewed factory.");
      const q: any = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, head);
      const fill: any = classifyAmmoraV4ExactInputFill(q, baseForQuote);
      if (fill.kind !== "full") throw new Error("Order no longer fills in full.");
      const minOut = (q.amountOut * 9900n) / 10000n; // 1% slippage
      if (minOut === 0n) throw new Error("Minimum output rounds to zero; use a larger amount.");
      const block = await client.getBlock();
      const data = encodeFunctionData({
        abi: ammoraLaunchPoolV4Abi, functionName: "swapExactInput",
        args: [amountIn, minOut, baseForQuote, false, account, block.timestamp + 1200n],
      } as any);

      const allowance = await rd(tokenIn, "allowance", [account, row.curve]);
      const wallet = walletFor(account);
      if (allowance < amountIn) {
        setMsg("Approve the exact amount in your wallet…");
        const ah = await wallet.writeContract({ account, chain, address: tokenIn, abi: erc20Abi, functionName: "approve", args: [row.curve, amountIn] } as any);
        await client.waitForTransactionReceipt({ hash: ah, retryCount: 0, pollingInterval: 3000, timeout: 120_000 });
      }
      setMsg("Simulating…");
      await client.call({ account, to: row.curve, data });
      setMsg("Confirm the trade in your wallet…");
      const hash = await wallet.sendTransaction({ account, chain, to: row.curve, data });
      setMsg("Waiting for confirmation…");
      const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 0, pollingInterval: 3000, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("Transaction reverted: " + hash);
      setDone(hash); setAmount("");
    } catch (e) { setErr(fmtErr(e)); } finally { setBusy(false); setMsg(null); }
  }

  const isWeth = info && /weth/i.test(info.qSym);
  const inSym = info ? (side === "buy" ? info.qSym : row.symbol) : "";
  const outSym = info ? (side === "buy" ? row.symbol : info.qSym) : "";
  const outDec = info ? (side === "buy" ? info.bDec : info.qDec) : 18;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginTop: 0 }}>
          <div className="token" style={{ margin: 0 }}>
            <div className="avatar">{(row.symbol || "?").slice(0, 2)}</div>
            <div><h3>{row.name}</h3><span>{row.symbol} · {STATUS[row.status] ?? "Unknown"}</span></div>
          </div>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <p className="mono">Curve: {row.curve}</p>

        {!info && !err && <p className="state">Loading curve…</p>}
        {info && info.status !== 1 && <p className="state">Trading on the curve is available only while the launch is live.</p>}
        {info && info.status === 1 && (
          <>
            <div className="seg">
              <button className={side === "buy" ? "on" : ""} onClick={() => setSide("buy")}>Buy</button>
              <button className={side === "sell" ? "on" : ""} onClick={() => setSide("sell")}>Sell</button>
            </div>
            <label className="field">Amount in ({inSym})
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
            </label>
            {account && <p className="mono">Balance: {fmtUnits(bal.q, info.qDec)} {info.qSym} · {fmtUnits(bal.b, info.bDec)} {row.symbol}</p>}
            {quote && <div className="quote">You receive ≈ <b>{fmtUnits(quote.out, outDec)} {outSym}</b><br /><span className="mono">Slippage 1% · {quote.kind === "full" ? "fills in full" : "partial/boundary, not supported here"}</span></div>}
            {quoteErr && <p className="state err">{quoteErr}</p>}
            {!account
              ? <button className="btn primary" style={{ marginTop: 14 }} onClick={onConnect}>Connect wallet</button>
              : <button className="btn primary" style={{ marginTop: 14 }} disabled={busy || !quote} onClick={trade}>{busy ? "Working…" : side === "buy" ? "Buy " + row.symbol : "Sell " + row.symbol}</button>}
            {isWeth && side === "buy" && account && (
              <div className="quote">
                Buying uses {info.qSym}. Need some? Wrap test ETH:
                <div className="row">
                  <input className="input" style={{ marginTop: 0 }} value={wrapAmt} onChange={(e) => setWrapAmt(e.target.value)} />
                  <button className="btn ghost" disabled={busy} onClick={wrap}>Wrap</button>
                </div>
              </div>
            )}
          </>
        )}
        {msg && <p className="state">{msg}</p>}
        {err && <p className="state err">{err}</p>}
        {done && <p className="state good">{done.startsWith("0x") ? <>Done! <a href={`${EXPLORER}/tx/${done}`} target="_blank" rel="noreferrer">View transaction</a></> : done}</p>}
      </div>
    </div>
  );
}

/* ───────────── App ───────────── */
export default function App() {
  const [tab, setTab] = useState<"explore" | "create">("explore");
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balance, setBalance] = useState("");
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [listBusy, setListBusy] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);

  const [configs, setConfigs] = useState<any[]>([]);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [configId, setConfigId] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("ipfs://example/metadata.json");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ token: string; curve: string; hash: string } | null>(null);

  async function connect() {
    setWalletErr(null);
    try {
      const addr = await connectWallet();
      setAccount(addr);
      setBalance(Number(formatEther(await client.getBalance({ address: addr }))).toFixed(4));
    } catch (e) { setWalletErr(fmtErr(e)); }
  }

  async function loadLaunches() {
    setListBusy(true); setListErr(null); setRows([]);
    try {
      const head = await client.getBlockNumber();
      const ev: any = (ammoraLaunchFactoryV4Abi as any[]).find((x) => x.type === "event" && /launch/i.test(x.name) && /creat/i.test(x.name));
      if (!ev) throw new Error("Launch event not found in the SDK ABI.");
      const getChunk = (from: bigint, to: bigint) =>
        client.getLogs({ address: contracts.factory, event: ev, fromBlock: from < 0n ? 0n : from, toBlock: to } as any);

      let size = 5000n;
      let first: any[] | null = null;
      for (const s of [5000n, 1000n, 500n]) {
        try { first = await getChunk(head - s + 1n, head); size = s; break; } catch { /* smaller */ }
      }
      if (!first) throw new Error("The RPC refused to return logs. Try again later.");
      const logs: any[] = [...first].reverse();
      for (let i = 1n; i < 12n && logs.length < 12; i++) {
        const to = head - i * size;
        if (to <= 0n) break;
        try { logs.push(...[...(await getChunk(to - size + 1n, to))].reverse()); } catch { break; }
        await sleep(250);
      }

      for (const l of logs.slice(0, 12)) {
        const cands = Object.values(l.args ?? {}).filter((v: any) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) as `0x${string}`[];
        let curve: `0x${string}` | null = null; let token: `0x${string}` | null = null;
        for (const c of cands) {
          const t: any = await client.readContract({ address: contracts.factory, abi: ammoraLaunchFactoryV4Abi, functionName: "tokenForCurve", args: [c] } as any).catch(() => zeroAddress);
          if (t !== zeroAddress) { curve = c; token = t; break; }
        }
        if (!curve || !token) continue;
        const rdT = (fn: string) => client.readContract({ address: token!, abi: erc20Abi, functionName: fn } as any).catch(() => "?") as Promise<any>;
        const [nm, sy] = await Promise.all([rdT("name"), rdT("symbol")]);
        let st = 0;
        try { st = Number(((await new AmmoraV4LaunchCurveClient(client, curve, core).getStateAtBlock(head)) as any).status); } catch { /* unknown */ }
        setRows((prev) => [...prev, { curve, token, name: String(nm), symbol: String(sy), status: st, block: l.blockNumber, tx: l.transactionHash }]);
        await sleep(150);
      }
    } catch (e) { setListErr(fmtErr(e)); } finally { setListBusy(false); }
  }

  useEffect(() => {
    (async () => {
      try {
        const block = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
        await verifyAmmoraV4CoreAtBlock(client, core, block);
        setVerified(true);
      } catch (e) { setVerifyErr(fmtErr(e)); }
      loadLaunches();
    })();
  }, []);

  useEffect(() => {
    if (tab !== "create" || cfgLoaded || !verified) return;
    setCfgLoaded(true);
    (async () => {
      try {
        const block = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
        const next = await getAmmoraV4NextConfigId(client, contracts.configRegistry, block);
        const last = next > 1n ? next - 1n : 0n;
        const stop = last > 5n ? last - 4n : 1n;
        for (let id = last; id >= stop && id >= 1n; id -= 1n) {
          const c: any = await getAmmoraV4ConfigAtBlock(client, contracts.configRegistry, id, block);
          const row = { id, enabled: c.enabled, decimals: c.config.tokenDecimals, fee: c.config.poolCreationFee };
          setConfigs((p) => [...p, row]);
          setConfigId((cur) => (cur === "" && row.enabled ? id.toString() : cur));
          await sleep(1000);
        }
      } catch (e) { setError(fmtErr(e)); }
    })();
  }, [tab, verified]);

  async function launch() {
    setError(null); setResult(null);
    const sel = configs.find((c) => c.id.toString() === configId);
    if (!account) return setError("Connect your wallet first.");
    if (!verified) return setError("Deployment check failed; launching is disabled.");
    if (!sel || !sel.enabled) return setError("Choose an enabled config.");
    if (!name.trim() || !symbol.trim() || !uri.trim()) return setError("Fill in name, symbol and metadata URI.");
    setBusy(true);
    try {
      const tx = buildCreateAmmoraV4Launch(
        { name: name.trim(), symbol: symbol.trim(), metadataURI: uri.trim(), creatorMetadataURI: uri.trim(), tokenDecimals: sel.decimals },
        sel.id, sel.fee);
      setStatus("Checking balance and simulating…");
      if ((await client.getBalance({ address: account })) < tx.value) throw new Error("Not enough test ETH for the creation fee.");
      await client.call({ account, to: contracts.factory, data: tx.data, value: tx.value });
      setStatus("Confirm the transaction in your wallet…");
      const hash = await walletFor(account).sendTransaction({ account, chain, to: contracts.factory, data: tx.data, value: tx.value });
      setStatus("Waiting for confirmation…");
      const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 0, timeout: 120_000, pollingInterval: 3000 });
      if (receipt.status !== "success") throw new Error("Transaction reverted: " + hash);
      const created: any = parseAmmoraV4LaunchCreatedReceipt(receipt, contracts.factory);
      setResult({ token: created.token, curve: created.curve, hash });
      setStatus(null); setName(""); setSymbol("");
      loadLaunches();
    } catch (e) { setError(fmtErr(e)); setStatus(null); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="hero">
        <div className="wrap">
          <div className="top">
            <span className="brand">Ammora Launchpad</span>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="pill">GIWA Sepolia · testnet</span>
              {verified && <span className="pill ok">✓ Deployment verified</span>}
              {account && <span className="pill soft">{balance} ETH</span>}
              <button className="btn" onClick={connect}>{account ? short(account) : "Connect wallet"}</button>
            </div>
          </div>
          <h1>Launch, discover and trade tokens on Ammora curves</h1>
          <p className="sub">Create a token in one transaction, browse the latest launches and trade directly on the bonding curve. Built with the Ammora SDK.</p>
          {walletErr && <p className="err">{walletErr}</p>}
          {verifyErr && <p className="err">Deployment check failed: {verifyErr}</p>}
        </div>
      </div>

      <div className="main wrap">
        <div className="tabs">
          <button className={"tab " + (tab === "explore" ? "on" : "")} onClick={() => setTab("explore")}>Explore launches</button>
          <button className={"tab " + (tab === "create" ? "on" : "")} onClick={() => setTab("create")}>Create token</button>
        </div>

        {tab === "explore" && (
          <>
            <div className="row" style={{ marginTop: 0, marginBottom: 14 }}>
              <span className="sub" style={{ margin: 0 }}>Latest launches (recent blocks)</span>
              <button className="btn ghost" onClick={loadLaunches} disabled={listBusy}>Refresh</button>
            </div>
            {listBusy && <p className="state">Loading launches…</p>}
            {listErr && <p className="state err">{listErr}</p>}
            {!listBusy && !listErr && rows.length === 0 && <p className="state">No recent launches found. Create the first one!</p>}
            <div className="grid">
              {rows.map((r) => (
                <div className="card" key={r.curve}>
                  <div className="token">
                    <div className="avatar">{r.symbol.slice(0, 2).toUpperCase()}</div>
                    <div><h3>{r.name}</h3><span>{r.symbol}</span></div>
                  </div>
                  <span className={"pill " + (r.status === 1 ? "ok" : r.status === 3 ? "" : "warn")}>{STATUS[r.status] ?? "Unknown"}</span>
                  <p className="mono">Token: <a href={`${EXPLORER}/address/${r.token}`} target="_blank" rel="noreferrer">{short(r.token)}</a> · Curve: <a href={`${EXPLORER}/address/${r.curve}`} target="_blank" rel="noreferrer">{short(r.curve)}</a></p>
                  <div className="row">
                    <a className="mono" href={`${EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">Block {r.block.toString()}</a>
                    <button className="btn primary" onClick={() => setSelected(r)}>Trade</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "create" && (
          <div className="card" style={{ maxWidth: 520 }}>
            <h3 style={{ marginTop: 0 }}>Create token</h3>
            {!cfgLoaded || configs.length === 0 ? <p className="state">Loading launch configs…</p> : null}
            <label className="field">Launch config
              <select className="input" value={configId} onChange={(e) => setConfigId(e.target.value)}>
                <option value="">Select…</option>
                {configs.map((c) => (
                  <option key={c.id.toString()} value={c.id.toString()} disabled={!c.enabled}>Config #{c.id.toString()} {c.enabled ? "" : "(disabled)"}</option>
                ))}
              </select>
            </label>
            <label className="field">Token name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Token" /></label>
            <label className="field">Symbol<input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MTK" /></label>
            <label className="field">Metadata URI<input className="input" value={uri} onChange={(e) => setUri(e.target.value)} /></label>
            <button className="btn primary" style={{ marginTop: 16 }} onClick={launch} disabled={busy}>{busy ? "Working…" : "Launch token"}</button>
            {status && <p className="state">{status}</p>}
            {error && <p className="state err">{error}</p>}
            {result && (
              <div className="quote">
                <b>Token launched 🎉</b>
                <p className="mono">Token: <a href={`${EXPLORER}/address/${result.token}`} target="_blank" rel="noreferrer">{result.token}</a></p>
                <p className="mono">Curve: <a href={`${EXPLORER}/address/${result.curve}`} target="_blank" rel="noreferrer">{result.curve}</a></p>
                <p className="mono">Tx: <a href={`${EXPLORER}/tx/${result.hash}`} target="_blank" rel="noreferrer">{short(result.hash)}</a></p>
              </div>
            )}
          </div>
        )}
      </div>

      {selected && <TradePanel row={selected} account={account} onConnect={connect} onClose={() => setSelected(null)} />}
    </>
  );
}
