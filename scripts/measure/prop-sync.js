/*
 * Headless client integration against the real server registry, using a
 * deterministic delivery queue. It checks the runtime without DOM, sockets,
 * renderers or React, including the no-overlapping-authorities handoff.
 */
import assert from 'node:assert/strict'
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { createPropNetwork } from '../../src/game/net/remoteProps.ts'
import { CATALOGUE } from '../../src/game/sandbox/catalogue.ts'
import { createPropRegistry, PROP_KINDS } from '../../server/src/props.js'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
import { historyOf } from '../../src/game/sandbox/history.ts'
import { contraptionOf } from '../../src/game/sandbox/contraption/contraption.ts'
assert.deepEqual([...PROP_KINDS].sort(), CATALOGUE.map(k=>k.id).sort(), 'server allowlist matches every catalogue kind')
let time = 0
const sent = []
const players = new Map(), inbound = [], outbound = []
const registry = createPropRegistry({ players, now:()=>time, send: (ws, m) => inbound.push([ws, structuredClone(m)]) })
const client = async (id) => {
  const sb = createSandbox({ collision: makeCollisionSet({minX:-100,maxX:100,minZ:-100,maxZ:100}), walker:false, ground:{heightAt:()=>0,lattice:()=>0} })
  await sb.whenReady
  const ws = { world:{id,level:'test',x:0,y:0,z:0},nick:`player${id}` }
  const net = createPropNetwork(m=>{sent.push(structuredClone(m));outbound.push([ws,structuredClone(m)])},console.log,()=>time)
  ws.net = net; players.set(id,ws)
  net.attach(sb,'test'); net.receive({type:'world-welcome',you:id,tick:66,slot:0,players:[]})
  registry.join(ws)
  return {sb,ws,net}
}
const a=await client(1),b=await client(2)
function flush() {
  let guard=0
  while(outbound.length||inbound.length) {
    assert.ok(++guard<10000)
    while(outbound.length) {const [ws,m]=outbound.shift();registry.handle(ws,m)}
    while(inbound.length) {const [ws,m]=inbound.shift();ws.net.receive(m)}
  }
}
function step(n) {
  for(let i=0;i<n;i++) {time+=1000/60; a.sb.tick({dt:1/60,active:true,focus:{x:0,y:5,z:0}});b.sb.tick({dt:1/60,active:true,focus:{x:0,y:5,z:0}});flush();registry.tick();flush()}
}
const props=s=>{const list=[];s.forEach(p=>{if(p.data.net)list.push(p)});return list}
flush()
const id=a.sb.spawn('crate',{x:0,y:3,z:0},{frozen:true,scale:1.3})
for(let i=0;i<10;i++){time+=100;a.sb.tick({dt:1/60,active:true})}
assert.equal(outbound.filter(([,m])=>m.type==='world-prop-spawn').length,1,'pending spawns never retransmit each frame')
flush()
assert.equal(props(b.sb).length,1)
assert.equal(props(b.sb)[0].scale,1.3)
a.sb.unfreeze(id);a.sb.setVelocity(id,{x:2,y:3,z:0})
step(220)
let A=a.sb.get(id),B=props(b.sb)[0]
assert.ok(A&&B)
console.log('headless end positions',A.body.translation(),B.body.translation())
assert.ok(Math.hypot(...['x','y','z'].map(k=>A.body.translation()[k]-B.body.translation()[k]))<0.03)
b.sb.network.claim(B.id,'hand')
// Deliver revoke separately to assert that neither side simulates in flight.
while(outbound.length){const[w,m]=outbound.shift();registry.handle(w,m)}
while(inbound.length){const[w,m]=inbound.shift();w.net.receive(m)}
assert.equal(a.sb.isAuthority(A.id),false);assert.equal(b.sb.isAuthority(B.id),false)
flush()
assert.equal(a.sb.isAuthority(A.id),false);assert.equal(b.sb.isAuthority(B.id),true)
b.sb.network.release(B.id);flush()
const aa=a.sb.spawn('plate_s',{x:8,y:5,z:0},{frozen:true}),ab=a.sb.spawn('beam_s',{x:8,y:6,z:0},{frozen:true})
for(const kind of ['weld','axis','rope','nocollide'])contraptionOf(a.sb).add(kind,aa,ab)
flush();step(10)
assert.equal(contraptionOf(b.sb).stats.constraints,4)
const linked=props(b.sb).find(p=>p.kind.id==='plate_s')
b.sb.network.claim(linked.id,'hand');flush()
assert.ok(contraptionOf(b.sb).linked(linked.id).every(id=>b.sb.isAuthority(id)))
assert.ok(contraptionOf(a.sb).linked(aa).every(id=>!a.sb.isAuthority(id)))
b.sb.network.release(linked.id);flush()
const boom=a.sb.spawn('barrel_explosive',{x:-20,y:8,z:0},{frozen:true});flush()
const remoteBomb=props(b.sb).find(p=>p.kind.id==='barrel_explosive')
b.sb.ignite(remoteBomb.id);flush();step(300)
assert.ok(!a.sb.get(boom));assert.ok(!props(b.sb).some(p=>p.kind.id==='barrel_explosive'))
a.sb.network.cleanup('mine');flush();assert.equal(props(b.sb).length,0)
// An honest contact hands the struck body to the owner of the moving one.
const ram=a.sb.spawn('barrel',{x:-8,y:a.sb.restY('barrel',-8,0),z:0},{frozen:true})
const target=b.sb.spawn('barrel',{x:-5,y:b.sb.restY('barrel',-5,0),z:0})
flush();step(40)
a.sb.unfreeze(ram);a.sb.setVelocity(ram,{x:10,y:0,z:0});step(100)
const struck=props(a.sb).find(p=>p.data.owner===2)
assert.ok(struck&&a.sb.isAuthority(struck.id),'collision transfers authority')
assert.equal(b.sb.isAuthority(target),false)
a.sb.network.cleanup('mine');flush()
assert.equal(props(b.sb).length,1,'cleanup leaves other owners intact')
b.sb.network.cleanup('mine');flush()
// A passenger's client drives the whole machine, then the owner's keys
// can take it back after the seat releases its lock.
const ca=contraptionOf(a.sb),cb=contraptionOf(b.sb)
const plate=a.sb.spawn('plate_s',{x:20,y:10,z:0})
const seat=a.sb.spawn('seat',{x:20,y:12,z:0})
const thruster=a.sb.spawn('thruster',{x:20,y:14,z:0})
ca.add('weld',plate,seat);ca.add('weld',plate,thruster);flush();step(10)
const bs=props(b.sb).find(p=>p.kind.id==='seat')
const bt=props(b.sb).find(p=>p.kind.id==='thruster')
b.sb.network.claim(bs.id,'seat');flush()
assert.ok(cb.linked(bs.id).every(id=>b.sb.isAuthority(id)))
for(const id of cb.linked(bs.id))b.sb.setVelocity(id,{x:0,y:0,z:0},{x:0,y:0,z:0})
cb.input(new Set(['Space','KeyW']),bs.id,100);step(20)
assert.equal(cb.part(bt.id).fire,1)
assert.ok(b.sb.get(bs.id).body.linvel().y>0,'seat drives its welded thruster')
cb.input(new Set(),null);flush()
ca.input(new Set(['KeyI']),null,100);flush();step(10)
assert.ok(a.sb.isAuthority(thruster),'owner key claims back the released machine')
assert.equal(ca.part(thruster).fire,1)
ca.input(new Set(),null);flush()
a.sb.network.cleanup('mine');flush()
// Undo also works before the spawn acknowledgement crosses the wire.
const history=historyOf(a.sb);history.me=1
const undone=a.sb.spawn('crate',{x:0,y:4,z:0},{frozen:true})
history.record({label:'crate',props:undone});history.undo();flush()
assert.equal(a.sb.get(undone),undefined)
assert.equal(props(b.sb).length,0)
// Quiet bodies must produce no background traffic, independent of count.
for(const c of [a,b])for(let i=0;i<100;i++)c.sb.spawn('barrel',{x:20+i%10*3,y:30,z:Math.floor(i/10)*3},{frozen:true})
flush();step(30)
sent.length=0;step(120)
assert.deepEqual(sent,[], '200 resting props send nothing')
console.log('headless prop sync assertions passed, 200 resting props: zero messages')
a.sb.dispose();b.sb.dispose()
