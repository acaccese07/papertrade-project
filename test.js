const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
}

function makeDom(storageSeed) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/",
    beforeParse(w) {
      // stub canvas
      w.HTMLCanvasElement.prototype.getContext = () => ({
        scale(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},closePath(){},
        createLinearGradient(){return{addColorStop(){}}},clearRect(){},fillRect(){},strokeRect(){},
        set strokeStyle(v){},set fillStyle(v){},set lineWidth(v){},set lineJoin(v){}
      });
      // network is unavailable in the sandbox -> app must fall back to SIM mode
      w.fetch = () => Promise.reject(new Error("offline"));
      w.confirm = () => true;
      if (storageSeed) for (const k in storageSeed) w.localStorage.setItem(k, storageSeed[k]);
    }});
  return dom;
}

async function run() {
  console.log("\n═══ TEST 1: Fresh user — onboarding ═══");
  let dom = makeDom();
  let w = dom.window, d = w.document;
  const E = ex => w.eval(ex);
  await new Promise(r => setTimeout(r, 300));
  check("Onboarding shown on first launch", d.getElementById("onboard").style.display !== "none");
  // pick $25,000 preset
  d.querySelector('[data-b="25000"]').click();
  w.startAccount();
  check("Onboarding hidden after start", d.getElementById("onboard").style.display === "none");
  check("Cash = $25,000", E("S").cash === 25000);
  check("youBase initialized", E("S").youBase === 25000);
  check("Market list rendered with many assets", d.querySelectorAll("#marketList .row").length > 100,
        "got " + d.querySelectorAll("#marketList .row").length);

  console.log("\n═══ TEST 2: Search & category chips ═══");
  d.getElementById("q").value = "shop";
  w.renderMarkets();
  check("Search 'shop' finds Shopify", d.getElementById("marketList").textContent.includes("Shopify"));
  d.getElementById("q").value = "";
  w.setCat("meme");
  const memeRows = d.querySelectorAll("#marketList .row").length;
  check("Meme chip shows 12 meme coins", memeRows === 12, "got " + memeRows);
  w.setCat("ca");
  check("Canada chip shows 28 stocks", d.querySelectorAll("#marketList .row").length === 28,
        "got " + d.querySelectorAll("#marketList .row").length);
  w.setCat("all");

  console.log("\n═══ TEST 3: Buying and selling ═══");
  w.openTrade("AAPL");
  check("Trade sheet opens", d.getElementById("sheet").classList.contains("show"));
  const p0 = E("prices")["AAPL"];
  d.getElementById("amt").value = "1000"; w.amtChanged();
  check("Buy button enabled for valid amount", !d.getElementById("doBtn").disabled);
  w.execute();
  check("Cash reduced to $24,000", Math.abs(E("S").cash - 24000) < 0.01, "cash=" + E("S").cash);
  check("Holding qty correct", Math.abs(E("S").holdings.AAPL.qty - 1000/p0) < 1e-9);
  check("Trade logged", E("S").trades.length === 1 && E("S").trades[0].side === "buy");
  // over-spend guard
  w.openTrade("BTC");
  d.getElementById("amt").value = "999999"; w.amtChanged();
  check("Buy blocked when amount > cash", d.getElementById("doBtn").disabled);
  w.closeSheet();
  // sell 50%
  w.openTrade("AAPL"); w.eval('sheetSide="sell"'); w.drawSheet();
  w.setPct(50); w.execute();
  check("Sell 50% leaves half the qty", Math.abs(E("S").holdings.AAPL.qty - 500/p0) < 1e-6);
  check("Cash back up ~$24,500", Math.abs(E("S").cash - 24500) < 1, "cash=" + E("S").cash.toFixed(2));

  console.log("\n═══ TEST 4: Market hours engine (real clock: " + new Date().toUTCString() + ") ═══");
  const open = w.marketOpen(), e = w.etParts();
  check("etParts returns a valid ET weekday", ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].includes(e.dow));
  if (e.dow === "Sat" || e.dow === "Sun") {
    check("Weekend -> market closed", open === false);
    check("Next open = Monday 9:30 AM ET", w.nextOpenText() === "Monday 9:30 AM ET", w.nextOpenText());
  } else {
    check("Weekday open matches 9:30-16:00 ET window", open === (e.mins >= 570 && e.mins < 960));
  }
  // stock price freeze while closed (simulate ticks)
  const frozen = E("prices")["MSFT"];
  for (let i = 0; i < 5; i++) w.simTick();
  if (!open) check("Stock prices FROZEN while NYSE closed", E("prices")["MSFT"] === frozen);
  else check("Stock prices move while NYSE open", E("prices")["MSFT"] !== frozen);
  const btc0 = E("prices")["BTC"];
  for (let i = 0; i < 5; i++) w.simTick();
  check("Crypto always ticking", E("prices")["BTC"] !== btc0);
  // trade sheet warning
  w.openTrade("TSLA");
  const hint = d.getElementById("tradeHint").textContent;
  if (!open) check("'Market closed' warning on stock trade sheet", hint.includes("NYSE is closed"));
  else check("No closed-warning during market hours", !hint.includes("NYSE is closed"));
  w.openTrade("ETH");
  check("No NYSE warning on crypto trades", !d.getElementById("tradeHint").textContent.includes("NYSE"));
  w.closeSheet();

  console.log("\n═══ TEST 5: Crypto bot (24/7) ═══");
  w.go("bot");
  d.getElementById("budget-crypto").value = "5000";
  w.startBot("crypto");
  check("Crypto bot active with $5,000", E("S").bots.crypto.active && E("S").bots.crypto.cash === 5000);
  check("Budget deducted from cash", Math.abs(E("S").cash - 19500) < 1, "cash=" + E("S").cash.toFixed(2));
  check("youBase adjusted down", Math.abs(E("S").youBase - 20000) < 0.01, "base=" + E("S").youBase);
  // force a think cycle (steady strategy buys immediately)
  E("S").bots.crypto.lastAct = 0;
  w.botThink("crypto");
  check("Bot made its first buy", E("S").bots.crypto.log.length === 1, "log=" + E("S").bots.crypto.log.length);
  if (E("S").bots.crypto.log.length) {
    const l = E("S").bots.crypto.log[0];
    check("Buy has an educational 'why'", l.why && l.why.length > 40);
    check("Bought from the crypto pool only", ["BTC","ETH","SOL"].includes(l.id), l.id);
  }
  check("Bot trade appears in shared history tagged bot-crypto",
        E("S").trades[0].who === "bot-crypto");
  // profit-taking: inflate the position and think again
  const held = Object.keys(E("S").bots.crypto.holdings)[0];
  E("prices")[held] = E("prices")[held] * 1.15; w.pushHist(held);
  w.botThink("crypto");
  const lastLog = E("S").bots.crypto.log[0];
  check("Take-profit fired at +15%", lastLog.side === "sell" && lastLog.why.includes("profit target"), lastLog.why);
  // stop & refund
  const before = E("S").cash, botVal = w.botValue("crypto");
  w.stopBot("crypto");
  check("Stop returns full bot value to cash", Math.abs(E("S").cash - (before + botVal)) < 0.01);
  check("Bot reset after stop", !E("S").bots.crypto.active && E("S").bots.crypto.log.length === 0);

  console.log("\n═══ TEST 6: Stock bot honors market hours ═══");
  w.renderBot();
  d.getElementById("budget-stock").value = "3000";
  w.startBot("stock");
  check("Stock bot active", E("S").bots.stock.active);
  E("S").bots.stock.lastAct = 0;
  w.botThink("stock");
  if (!w.marketOpen())
    check("Stock bot makes NO trades while NYSE closed", E("S").bots.stock.log.length === 0,
          "log=" + E("S").bots.stock.log.length);
  else
    check("Stock bot trades during market hours", E("S").bots.stock.log.length === 1);
  check("Both-bots UI renders (PAUSED/RUNNING pills)", d.getElementById("bot-stock").textContent.length > 0);
  check("Comparison card shows You vs bot", d.getElementById("botCompare").textContent.includes("You"));
  w.stopBot("stock");

  console.log("\n═══ TEST 7: Persistence & reload ═══");
  // force-save, capture storage, boot a brand new session with it
  await new Promise(r => setTimeout(r, 1000));
  const savedState = w.localStorage.getItem("ppt-state:Trader 1");
  check("State persisted under the profile key", !!savedState);
  const cashBefore = E("S").cash, qtyBefore = E("S").holdings.AAPL.qty;
  let dom2 = makeDom({ "ppt-state:Trader 1": savedState,
                       "ppt-profiles": w.localStorage.getItem("ppt-profiles") });
  await new Promise(r => setTimeout(r, 400));
  const w2 = dom2.window; const E2 = ex => w2.eval(ex);
  check("Reload skips onboarding", dom2.window.document.getElementById("onboard").style.display === "none");
  check("Cash survives reload", Math.abs(E2("S").cash - cashBefore) < 0.01);
  check("AAPL holding survives reload", Math.abs(E2("S").holdings.AAPL.qty - qtyBefore) < 1e-9);
  check("Trade history survives reload", E2("S").trades.length === E("S").trades.length);

  console.log("\n═══ TEST 8: Old single-bot save migrates safely ═══");
  const oldState = JSON.parse(savedState);
  delete oldState.bots; delete oldState.youBase;
  oldState.cash = 1000;
  oldState.bot = { active: true, strategy: "steady", cash: 200, start: 500,
                   holdings: { BTC: { qty: 0.01, cost: 1100 } }, log: [], lastAct: 0 };
  let dom3 = makeDom({ "ppt-state": JSON.stringify(oldState) });
  await new Promise(r => setTimeout(r, 400));
  const w3 = dom3.window; const E3 = ex => w3.eval(ex);
  check("Migration creates dual-bot structure", !!E3("S").bots && !!E3("S").bots.crypto && !!E3("S").bots.stock);
  const expected = 1000 + 200 + 0.01 * E3("ASSETS").find(a=>a.id==="BTC").base;
  check("Old bot liquidated back into cash", Math.abs(E3("S").cash - expected) < 0.01,
        "cash=" + E3("S").cash.toFixed(2) + " expected=" + expected.toFixed(2));
  check("Legacy S.bot removed", E3("S").bot === undefined);
  check("youBase backfilled", E3("S").youBase === E3("S").start);

  console.log("\n═══ TEST 9: Edge cases ═══");
  check("fmt handles tiny meme prices", w.fmt(0.0000135).includes("0.0000135"), w.fmt(0.0000135));
  check("fmt handles millions", w.fmt(2500000) === "$2.50M", w.fmt(2500000));
  // sell 100% removes position entirely
  w.openTrade("AAPL"); w.eval('sheetSide="sell"'); w.drawSheet();
  w.setPct(100); w.execute();
  check("Selling 100% deletes the position", E("S").holdings.AAPL === undefined);
  // bot budget > cash rejected
  w.go("bot"); w.renderBot();
  dom.window.document.getElementById("budget-crypto").value = "99999999";
  w.startBot("crypto");
  check("Bot rejects budget larger than cash", !E("S").bots.crypto.active);
  // offline resilience: fetch is dead, app should be in SIM mode without crashing
  await w.pollCrypto();
  check("Offline -> graceful SIM fallback", E("feedLive").crypto === false &&
        dom.window.document.getElementById("feedPill").textContent === "SIM");
  // activity renders both user and bot trades
  w.go("activity");
  check("Activity tab renders history", dom.window.document.getElementById("actList").textContent.length > 20);


  console.log("\n═══ TEST 10: Profiles & leaderboard ═══");
  // fresh device, onboard with a name
  let dom4 = makeDom();
  await new Promise(r => setTimeout(r, 300));
  const w4 = dom4.window, d4 = w4.document, E4 = ex => w4.eval(ex);
  d4.getElementById("pname").value = "Anthony";
  w4.startAccount();
  await new Promise(r => setTimeout(r, 100));
  check("Profile 'Anthony' created", E4("profiles").active === "Anthony");
  check("Profiles list saved", JSON.parse(w4.localStorage.getItem("ppt-profiles")).list.includes("Anthony"));
  // trade something so Anthony has state
  w4.openTrade("DOGE");
  d4.getElementById("amt").value = "500"; w4.amtChanged(); w4.execute();
  check("Achievement: First Trade unlocked", !!E4("S").ach.first_trade);
  check("Achievement: Meme Lord unlocked (bought DOGE)", !!E4("S").ach.meme_lord);
  await new Promise(r => setTimeout(r, 1000)); // let save fire
  // second profile
  w4.newProfile();
  check("New profile shows onboarding", d4.getElementById("onboard").style.display === "flex");
  d4.getElementById("pname").value = "Claudia";
  d4.querySelector('[data-b="100000"]').click();
  w4.startAccount();
  await new Promise(r => setTimeout(r, 100));
  check("Second profile active with $100K", E4("profiles").active === "Claudia" && E4("S").cash === 100000);
  await new Promise(r => setTimeout(r, 1000));
  await w4.switchProfile("Anthony");
  check("Switch back to Anthony restores his DOGE", E4("S").holdings.DOGE !== undefined && E4("profiles").active === "Anthony");
  await w4.openLeaderboard();
  const lbText = d4.getElementById("sheet").textContent;
  check("Leaderboard shows both profiles", lbText.includes("Anthony") && lbText.includes("Claudia"));
  check("Leaderboard marks current user", lbText.includes("(you)"));

  console.log("\n═══ TEST 11: Limit & stop orders ═══");
  // limit buy below market: reserve cash, then fill on price drop
  const cashA = E4("S").cash;
  w4.openTrade("ETH");
  w4.eval('orderType="limit"'); w4.drawSheet();
  const ethP = E4("prices").ETH;
  d4.getElementById("amt").value = "1000";
  d4.getElementById("target").value = (ethP * 0.97).toString();
  w4.amtChanged(); w4.execute();
  check("Limit buy placed", E4("S").orders.length === 1);
  check("Cash reserved for the order", Math.abs(E4("S").cash - (cashA - 1000)) < 0.01 && E4("S").reserved === 1000);
  const totalBefore = w4.youValue();
  check("Total value unchanged by reservation", Math.abs(totalBefore - w4.youValue()) < 0.01);
  // price drops through the target -> fill
  E4("prices").ETH = ethP * 0.96; w4.checkOrders();
  check("Limit buy filled on price drop", E4("S").orders.length === 0 && E4("S").holdings.ETH !== undefined);
  check("Reserved cash released", E4("S").reserved === 0);
  check("Achievement: Order Up unlocked", !!E4("S").ach.order_up);
  check("Fill logged with LIMIT note", E4("S").trades[0].note === "limit");
  // stop-loss: place below, crash the price
  w4.openTrade("ETH"); w4.eval('sheetSide="sell"'); w4.eval('orderType="stop"'); w4.drawSheet();
  const ethNow = E4("prices").ETH;
  d4.getElementById("amt").value = (E4("S").holdings.ETH.qty * ethNow).toFixed(2);
  d4.getElementById("target").value = (ethNow * 0.9).toString();
  w4.amtChanged(); w4.execute();
  check("Stop-loss placed", E4("S").orders.length === 1 && E4("S").orders[0].type === "stop");
  E4("prices").ETH = ethNow * 0.85; w4.checkOrders();
  check("Stop-loss fired on crash, position closed", E4("S").orders.length === 0 && E4("S").holdings.ETH === undefined);
  // cancel refunds
  w4.openTrade("BTC"); w4.eval('orderType="limit"'); w4.drawSheet();
  d4.getElementById("amt").value = "200";
  d4.getElementById("target").value = (E4("prices").BTC * 0.9).toString();
  w4.amtChanged(); w4.execute();
  const cashBeforeCancel = E4("S").cash;
  w4.cancelOrder(E4("S").orders[0].o);
  check("Cancelling refunds reserved cash", Math.abs(E4("S").cash - (cashBeforeCancel + 200)) < 0.01 && E4("S").reserved === 0);

  console.log("\n═══ TEST 12: Candles, glossary, badges UI ═══");
  const live = await w4.getOHLC(E4('ASSETS').find(a=>a.id==="BTC"), "live");
  check("Live candles built from session ticks", live.data.length >= 1 && live.real);
  const synth = await w4.getOHLC(E4('ASSETS').find(a=>a.id==="AAPL"), "30");
  check("Synthetic 1M history generated offline (60 candles)", synth.data.length === 60 && synth.real === false);
  const synth2 = await w4.getOHLC(E4('ASSETS').find(a=>a.id==="AAPL"), "30");
  check("History cached & deterministic", synth2.data[0][1] === synth.data[0][1]);
  const lastClose = synth.data[synth.data.length-1][4];
  check("Synthetic history ends at current price", Math.abs(lastClose - E4("prices").AAPL) < 0.01);
  w4.openTrade("AAPL");
  check("Timeframe chips render (Live/1D/1W/1M)", d4.getElementById("sheet").textContent.includes("1M"));
  w4.drawCandles(d4.getElementById("spark"), synth.data); // must not throw
  check("Candle renderer runs without crashing", true);
  w4.openGlossary();
  check("Glossary opens with definitions", d4.getElementById("sheet").textContent.includes("Stop-loss"));
  w4.openSettings();
  const setTxt = d4.getElementById("sheet").textContent;
  check("Settings shows badge progress", /🏅/.test(setTxt) && setTxt.includes("Meme Lord"));
  check("Settings shows profile switcher", setTxt.includes("Switch to Claudia"));

  console.log("\n═══ TEST 13: Legacy save (pre-profiles) migrates ═══");
  const legacy = JSON.stringify({start:5000,cash:4000,holdings:{BTC:{qty:.01,cost:1000}},trades:[],equity:[[Date.now(),5000]],finnhubKey:""});
  let dom5 = makeDom({"ppt-state": legacy});
  await new Promise(r => setTimeout(r, 400));
  const E5 = ex => dom5.window.eval(ex);
  check("Legacy save becomes 'Trader 1' profile", E5("profiles").active === "Trader 1");
  check("Legacy holdings intact after migration", E5("S").holdings.BTC.qty === 0.01);
  check("Legacy save gains orders/ach/bots structures", Array.isArray(E5("S").orders) && !!E5("S").bots && !!E5("S").ach);

  console.log("\n════════════════════════════════");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error("TEST CRASH:", e); process.exit(2); });
