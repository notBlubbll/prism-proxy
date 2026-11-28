import assert from 'node:assert/strict';
import test from 'node:test';
import {chooseTicket} from '../queue-policy.mjs';

const request = (session,budget,background=false) => ({ticket:{session,budget,arrived:100,passed:0,background},wait:{ms:0}});
test('Focus wins only when both fit; background yields but uses spare capacity', () => {
  const big=request('viewed',1500000), small=request('other',100000);
  const policy={now:101,focused:'viewed',fitBoth:()=>false,waitAfter:()=>0};
  assert.equal(chooseTicket([big,small],policy),small);
  assert.equal(chooseTicket([big,small],{...policy,fitBoth:()=>true}),big);
  assert.equal(chooseTicket([big],policy),big);
  big.ticket.background=true;
  assert.equal(chooseTicket([big,small],{...policy,fitBoth:()=>true}),small);
  small.wait.ms=300;
  assert.equal(chooseTicket([big,small],policy),big);
});
test('Protected work permits only harmless passes, including same-time arrivals', () => {
  const big=request('big',1000), small=request('small',10);
  big.wait.ms=800;
  const policy={now:5500,fitBoth:()=>false,waitAfter:()=>801};
  assert.equal(chooseTicket([big,small],policy),null);
  assert.equal(chooseTicket([big,small],{...policy,waitAfter:()=>800}),small);
  big.wait.ms=0;
  assert.equal(chooseTicket([big,small],policy),big);
});
