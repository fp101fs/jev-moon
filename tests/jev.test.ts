import { describe, expect, test } from "bun:test";
import { parseJevResponse } from "../src/jev";

const valid={answers:{BTC_USD:{type:"choice",choice:"BUY",confidence:.8,probabilities:{BUY:.8,SELL:.1,HOLD:.1}}},usage:{input_tokens:10,output_tokens:4}};
describe("Jev response parsing",()=>{
  test("accepts a strict Choice response",()=>expect(parseJevResponse(valid,["BTC_USD"]).decisions.BTC_USD?.action).toBe("BUY"));
  test("rejects unknown choices",()=>expect(()=>parseJevResponse({answers:{BTC_USD:{type:"choice",choice:"WAIT",confidence:.8,probabilities:{BUY:.8,SELL:.1,HOLD:.1}}}},["BTC_USD"])).toThrow());
  test("rejects invalid probability values",()=>expect(()=>parseJevResponse({answers:{BTC_USD:{type:"choice",choice:"BUY",confidence:.8,probabilities:{BUY:1.2,SELL:-.1,HOLD:-.1}}}},["BTC_USD"])).toThrow());
});
