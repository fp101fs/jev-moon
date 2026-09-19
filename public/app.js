const marketsEl = document.querySelector('#markets');
const tapeEl = document.querySelector('#tape');
const jevBadge = document.querySelector('#jev-badge');
const marketBadge = document.querySelector('#market-badge');
const statusLine = document.querySelector('#status-line');
const counterEl = document.querySelector('#decision-counter');
const primaryMetrics = document.querySelector('#primary-metrics');
const diagnostics = document.querySelector('#diagnostics');
const causalLoop = document.querySelector('#causal-loop');
const toastEl = document.querySelector('#fill-toast');
const modeToggle = document.querySelector('#mode-toggle');
const theaterShell = document.querySelector('#theater-shell');
const theaterMarkets = document.querySelector('#theater-markets');
const theaterStage = document.querySelector('#theater-stage');
const decisionBurst = document.querySelector('#decision-burst');
const heartbeatRail = document.querySelector('#heartbeat-rail');
const heartbeatStatus = document.querySelector('#heartbeat-status');
const theaterCausal = document.querySelector('#theater-causal');
const actionLog = document.querySelector('#action-log');
const jevCore = document.querySelector('#jev-core');
const coreLatency = document.querySelector('#core-latency');
const theaterMode = new URLSearchParams(location.search).get('mode') === 'theater';
const previousDecision = new Map();
const previousPrice = new Map();
const previousMarketUpdate = new Map();
let previousCount = -1;
let previousTheaterCount = -1;
let lastFillKey = '';
let toastTimer;
let burstVersion = 0;

document.body.classList.toggle('theater-mode', theaterMode);
modeToggle.textContent = theaterMode ? 'DASHBOARD VIEW' : 'THEATER VIEW';
modeToggle.href = theaterMode ? location.pathname : `${location.pathname}?mode=theater`;

const money = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', {style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const num = (n, digits = 1) => Number.isFinite(n) ? n.toLocaleString('en-US',{maximumFractionDigits:digits}) : '—';
const pct = (n) => Number.isFinite(n) ? `${Math.round(n*100)}%` : '—';
const clock = (ts) => new Date(ts).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3});
const duration = (ms) => { const s=Math.floor(ms/1000); return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}` };
const signed = (n, suffix='') => `${n>=0?'+':''}${num(n,2)}${suffix}`;

function sparkline(points, symbol){
  if (!points?.length) return '<svg class="spark"></svg>';
  const values=points.map(p=>p.price), min=Math.min(...values), max=Math.max(...values), span=max-min||1;
  const coords=values.map((v,i)=>`${i/(values.length-1||1)*100},${45-(v-min)/span*39}`);
  const line=`M ${coords.join(' L ')}`, fill=`${line} L 100,49 L 0,49 Z`, id=`f-${symbol.replace('/','')}`;
  return `<svg class="spark" viewBox="0 0 100 49" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#73d7ed" stop-opacity=".17"/><stop offset="1" stop-color="#73d7ed" stop-opacity="0"/></linearGradient></defs><path class="fill" style="fill:url(#${id})" d="${fill}"/><path class="line" d="${line}"/></svg>`;
}

function primaryStat(value, suffix){return `<div><strong>${value}</strong><span>${suffix}</span></div>`}
function diagnostic(label, value, alert=false){return `<div><label>${label}</label><strong class="${alert?'alert':''}">${value}</strong></div>`}

function showFill(fill, decision, totalDecisions){
  if (theaterMode) return;
  const key=`${totalDecisions}:${fill?.symbol}:${fill?.side}:${fill?.timestamp}`;
  if (!fill || key === lastFillKey) return;
  lastFillKey = key;
  toastEl.innerHTML = `<small>MARKET EVENT</small><strong>${fill.symbol}</strong><span class="${fill.side}">${fill.side} ${pct(decision.confidence)}</span><em>${num(decision.latency,0)} ms</em><b>PAPER FILL ✓</b>`;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toastEl.classList.remove('show'),850);
}

function emitHeartbeat(action, delay=0){
  setTimeout(()=>{
    const pulse=document.createElement('i');
    pulse.className=`heartbeat-pulse ${action}`;
    heartbeatRail.appendChild(pulse);
    setTimeout(()=>pulse.remove(),1500);
  },delay);
}

function renderTheater(data){
  const m=data.metrics;
  document.querySelector('#theater-count').textContent=num(m.totalDecisions,0);
  document.querySelector('#theater-avg').textContent=num(m.averageLatency,0);
  document.querySelector('#theater-p95').textContent=num(m.p95Latency,0);
  document.querySelector('#theater-rate').textContent=num(m.decisionsPerMinute,0);
  coreLatency.textContent=`${num(m.currentLatency,0)} ms`;

  let marketChanged=false;
  theaterMarkets.innerHTML=Object.entries(data.markets).map(([symbol,x])=>{
    const d=x.decision, probs=d?.probabilities||{BUY:0,HOLD:0,SELL:0};
    const changed=previousMarketUpdate.get(symbol)!==x.timestamp;
    if(previousMarketUpdate.has(symbol)&&changed) marketChanged=true;
    previousMarketUpdate.set(symbol,x.timestamp);
    return `<div class="theater-market ${changed?'snapshot-update':''}"><div class="tm-head"><strong>${symbol}</strong><span>${money(x.mid)}</span></div><div class="tm-decision"><b class="${d?.action||'HOLD'}">${d?.action||'—'}</b><em>${d?pct(d.confidence):'—'}</em><small>${d?num(d.latency,0):'—'} ms</small></div><div class="tm-probs">${['BUY','HOLD','SELL'].map(a=>`<i class="${a.toLowerCase()}" style="--p:${probs[a]*100}%"><span>${a}</span></i>`).join('')}</div></div>`;
  }).join('');
  if(marketChanged){
    theaterStage.classList.remove('snapshot-flow'); void theaterStage.offsetWidth; theaterStage.classList.add('snapshot-flow');
  }

  const eligible=data.tape.filter(d=>d.symbol&&d.type!=='error');
  let fresh=[];
  if(m.totalDecisions!==previousTheaterCount){
    const newest=eligible[0]?.timestamp;
    fresh=eligible.filter(d=>d.timestamp===newest).reverse();
    previousTheaterCount=m.totalDecisions;
  }

  if(fresh.length){
    const version=++burstVersion;
    theaterStage.classList.remove('output-burst'); void theaterStage.offsetWidth; theaterStage.classList.add('output-burst');
    jevCore.classList.remove('deciding'); void jevCore.offsetWidth; jevCore.classList.add('deciding');
    decisionBurst.innerHTML=fresh.map((d,index)=>`<div class="theater-event ${d.action}" style="--delay:${index*55}ms"><div><span>${d.symbol}</span><small>${clock(d.timestamp)}</small></div><strong>${d.action}</strong><em>${pct(d.confidence)}</em><b>${num(d.latency,0)} ms</b>${d.fill?'<i>PAPER FILL ✓</i>':''}</div>`).join('');
    fresh.forEach((d,index)=>emitHeartbeat(d.action,index*55));
    heartbeatStatus.textContent=`${fresh.length} COMPLETED · ${num(fresh[0].latency,0)} ms`;
    const causal=fresh.find(d=>d.action==='BUY'||d.action==='SELL')||fresh[0];
    theaterCausal.innerHTML=`<div class="theater-kicker">LATEST CAUSAL CHAIN</div><div class="chain"><span><b>${causal.symbol}</b> snapshot</span><i>↓</i><span>Jev decision <strong class="${causal.action}">${causal.action} ${pct(causal.confidence)}</strong></span><i>↓</i><span>latency <b>${num(causal.latency,0)} ms</b></span><i>↓</i><span>paper fill <b class="${causal.fill?'fill-yes':''}">${causal.fill?'YES ✓':'NO'}</b></span></div>`;
    setTimeout(()=>{if(version===burstVersion) decisionBurst.innerHTML=''},880);
  }

  actionLog.innerHTML=eligible.slice(0,7).map((d,index)=>`<div class="action-log-row ${d.action} ${index===0?'latest':''}"><i></i><time>${clock(d.timestamp)}</time><strong>${d.symbol.split('/')[0]}</strong><b>${d.action}</b><span>${pct(d.confidence)}</span><em>${num(d.latency,0)} ms</em>${d.fill?'<small>FILL ✓</small>':''}</div>`).join('');
}

function render(data){
  const m=data.metrics, replay=data.status.mode==='replay';
  document.body.classList.toggle('video-mode',Boolean(data.status.videoMode));
  document.body.classList.toggle('replay-mode',replay);
  if (m.totalDecisions !== previousCount) {
    counterEl.textContent=num(m.totalDecisions,0);
    counterEl.classList.remove('tick-up'); void counterEl.offsetWidth; counterEl.classList.add('tick-up');
    previousCount=m.totalDecisions;
  }
  primaryMetrics.innerHTML=primaryStat(num(m.averageLatency,0),'ms AVG')+primaryStat(num(m.p95Latency,0),'ms P95')+primaryStat(num(m.decisionsPerMinute,0),'/ MIN');
  diagnostics.innerHTML=diagnostic('FAILURES',num(m.failedCalls,0),m.failedCalls>0)+diagnostic('SKIPPED',num(m.skippedCycles,0))+diagnostic('LATEST',`${num(m.currentLatency,0)} ms`);
  const meaningful=data.tape.find(d=>d.action==='BUY'||d.action==='SELL')||data.tape.find(d=>d.symbol);
  causalLoop.innerHTML=meaningful?`<div class="causal-title">CAUSAL LOOP</div><div class="causal-step"><span>MARKET</span><i>↓</i><strong>JEV</strong><em>${num(meaningful.latency,0)} ms</em><i>↓</i><b class="${meaningful.action}">${meaningful.action} ${pct(meaningful.confidence)}</b><i>↓</i><span class="paper-step">${meaningful.fill?'PAPER FILL ✓':'RISK GATE'}</span></div>`:'<div class="causal-title">CAUSAL LOOP</div><div class="causal-wait">AWAITING DECISION</div>';

  if(replay){
    marketBadge.className='badge replay'; marketBadge.innerHTML='<i></i> RECORDED LIVE RUN';
    jevBadge.className='badge replay'; jevBadge.innerHTML='<i></i> JEV REPLAY';
  } else {
    marketBadge.className=`badge ${data.status.marketOnline?'live':'offline'}`;
    marketBadge.innerHTML=`<i></i> ${data.status.marketOnline?'LIVE MARKET DATA':'DATA OFFLINE'}`;
    const mode=data.status.model==='mock'?'MOCK MODEL':data.status.jevOnline?'JEV ONLINE':'JEV OFFLINE';
    jevBadge.className=`badge ${data.status.model==='mock'?'mock':data.status.jevOnline?'live':'offline'}`;
    jevBadge.innerHTML=`<i></i> ${mode}`;
  }

  marketsEl.innerHTML=Object.entries(data.markets).map(([symbol,x])=>{
    const d=x.decision, action=d?.action||'WAIT', conf=d?.confidence||0, probs=d?.probabilities||{BUY:0,SELL:0,HOLD:0};
    const decisionKey=`${d?.timestamp}-${action}`, old=previousDecision.get(symbol), isNew=Boolean(old&&old!==decisionKey), pulse=isNew?`pulse-${action.toLowerCase()}`:'';
    if(d) previousDecision.set(symbol,`${d.timestamp}-${action}`);
    const prior=previousPrice.get(symbol), tick=prior&&x.mid?(x.mid-prior)/prior*100:0; if(x.mid)previousPrice.set(symbol,x.mid);
    if(d?.fill) showFill(d.fill,d,m.totalDecisions);
    return `<article class="market ${pulse}"><div class="market-top"><div><div class="symbol">${symbol}</div><div class="exchange">KRAKEN · SPOT</div></div><div class="price-wrap"><div class="price">${x.mid?money(x.mid):'—'}</div><div class="tick ${tick<0?'negative':''}">${x.mid?signed(tick,'%'):'AWAITING BOOK'}</div></div></div>
      <div class="decision-row ${isNew?'decision-event':''}"><div class="decision ${action==='WAIT'?'pending':action}">${action}</div><div class="confidence"><small>CONFIDENCE</small><strong>${d?pct(conf):'—'}</strong></div></div>
      <div class="card-latency ${isNew?'latency-event':''}"><span>JEV LATENCY</span><strong>${d?num(d.latency,0):'—'}</strong><em>ms</em></div>
      <div class="probabilities">${['BUY','HOLD','SELL'].map(a=>`<div class="prob ${a.toLowerCase()}"><span>${a}</span><div class="bar"><i style="width:${probs[a]*100}%"></i></div><em>${pct(probs[a])}</em></div>`).join('')}</div>
      <div class="position-row"><div><label>PAPER POSITION</label><strong>${x.portfolio?signed(x.portfolio.positionUsd,' USD'):'—'}</strong></div><div><label>UNREALIZED P&L</label><strong class="${x.portfolio?.unrealizedPnl>=0?'positive':'negative'}">${x.portfolio?`${x.portfolio.unrealizedPnl>=0?'+':''}${money(x.portfolio.unrealizedPnl)}`:'—'}</strong></div></div>
      <div class="features"><span>SPREAD <b>${num(x.spreadBps,2)} bps</b></span><span>IMBALANCE <b>${signed(x.bookImbalance*100,'%')}</b></span><span>FLOW <b>${signed(x.recentTradeFlow*100,'%')}</b></span></div>
      ${sparkline(x.sparkline,symbol)}</article>`;
  }).join('');

  tapeEl.innerHTML=data.tape.slice(0,8).map((d,index)=>d.type==='error'?`<div class="tape-row"><span class="error">${clock(d.timestamp)} · JEV ERROR · ${d.message}</span></div>`:`<div class="tape-row ${index===0?'newest':''}"><span>${clock(d.timestamp)}</span><span>${d.symbol.split('/')[0]}</span><span class="${d.action}">${d.action}</span><span>${pct(d.confidence)}</span><span>${num(d.latency,0)} ms</span><span class="${d.fill?'fill':''}">${d.fill?'PAPER FILL ✓':'—'}</span></div>`).join('');
  statusLine.textContent=replay
    ? `RECORDED LIVE RUN · PAPER TRADING · ${m.successfulCalls} CAPTURED CALLS · ${m.failedCalls} FAILURES`
    : `JEV API ${data.status.jevOnline?'ONLINE':'OFFLINE'} · MARKET FEED ${data.status.marketOnline?'ONLINE':'OFFLINE'} · UPTIME ${duration(data.now-data.startedAt)} · ${m.successfulCalls} OK / ${m.failedCalls} FAILED · ${m.skippedCycles} MISSED`;
  renderTheater(data);
}

const source=new EventSource('/api/events');
source.onmessage=(event)=>render(JSON.parse(event.data));
source.onerror=()=>{jevBadge.className='badge offline';jevBadge.innerHTML='<i></i> STREAM OFFLINE'};
