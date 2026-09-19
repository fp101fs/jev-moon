import { describe, expect, test } from "bun:test";
import { gateAction, notionalForConfidence, PaperEngine } from "../src/paper";

describe("confidence gating",()=>{
  test("holds low confidence or stale actions",()=>{expect(gateAction("BUY",.54,false)).toBe("HOLD");expect(gateAction("SELL",.9,true)).toBe("HOLD");expect(gateAction("BUY",.8,false)).toBe("BUY")});
  test("sizes deterministically",()=>{expect(notionalForConfidence(.6)).toBe(100);expect(notionalForConfidence(.75)).toBe(250);expect(notionalForConfidence(.9)).toBe(500)});
});

describe("paper execution and accounting",()=>{
  test("fills at ask plus slippage and applies fees",()=>{const p=new PaperEngine(10_000,2_000,5,1);const fill=p.execute("BTC/USD","BUY",.9,99,100)!;expect(fill.price).toBeCloseTo(100.01);expect(fill.fee).toBeCloseTo(.25);expect(p.cash).toBeCloseTo(9499.75)});
  test("realizes pnl when reducing a position",()=>{const p=new PaperEngine(10_000,2_000,0,0);p.execute("ETH/USD","BUY",.9,99,100);p.execute("ETH/USD","SELL",.9,109,110);expect(p.positions["ETH/USD"].realizedPnl).toBeCloseTo(41.2844,3)});
  test("clamps absolute exposure",()=>{const p=new PaperEngine(10_000,600,0,0);p.execute("SOL/USD","BUY",.9,99,100);p.execute("SOL/USD","BUY",.9,99,100);expect(Math.abs(p.summary("SOL/USD",99.5).positionUsd)).toBeLessThanOrEqual(600)});
  test("accounts for short positions in equity",()=>{const p=new PaperEngine(10_000,2_000,0,0);p.execute("SOL/USD","SELL",.9,100,101);expect(p.equity({"SOL/USD":90})).toBeCloseTo(10_050)});
});
