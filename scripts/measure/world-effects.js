/*
 * Shared portal geometry and delayed jump effects in Node, using the real
 * relay and Rapier stores. Different local prop ids catch accidental handle
 * sharing, and crossing a remote pair exercises collision as well as data.
 */
import assert from 'node:assert/strict'
import { createSandbox } from '../../src/game/sandbox/sandbox.ts'
import { createPortals } from '../../src/game/sandbox/tools/portals.ts'
import { createPortalWalk } from '../../src/game/sandbox/tools/portalWalk.ts'
import { createPropNetwork } from '../../src/game/net/remoteProps.ts'
import { createWorldEffects as createClientEffects } from '../../src/game/net/worldEffects.ts'
import { createWorldEffects } from '../../server/src/worldEffects.js'
import { createPropRegistry } from '../../server/src/props.js'
import { makeCollisionSet } from '../../src/game/physics/collision.ts'
let time=0
const players=new Map(), clients=[], inbound=[], outbound=[], sent=[]
const relayProps=createPropRegistry({players,now:()=>time,send:(w,m)=>inbound.push([w,structuredClone(m)]),onRemove:(level,ids)=>relay.removeProps(level,ids)})
const relay=createWorldEffects({players,prop:relayProps.get,now:()=>time,send:(w,m)=>inbound.push([w,structuredClone(m)])})
async function client(id) {
  const collision=makeCollisionSet({minX:-100,maxX:100,minZ:-100,maxZ:100})
  const wall=new THREE.Box3(new THREE.Vector3(-5,-1,-0.8),new THREE.Vector3(5,8,-0.02))
  collision.boxes.push(wall)
  const sb=createSandbox({collision,walker:false,ground:{heightAt:()=>0,lattice:()=>0}})
  await sb.whenReady
  if(id===2)sb.spawn('gib_wood',{x:80,y:1,z:80},{id:5000,data:{gib:true},frozen:true})
  const w={world:{id,level:'overworld',x:0,y:0,z:0},nick:`peer${id}`}
  const send=m=>{outbound.push([w,structuredClone(m)]);sent.push(structuredClone(m))}
  const props=createPropNetwork(send,()=>{},()=>time)
  const portals=createPortals(), clouds=[]
  const effects=createClientEffects({send,now:()=>time,level:()=>w.world.level,
    world:level=>level==='overworld'?{boxes:collision.boxes,sb}:{boxes:[],sb:null},cloud:(level,at)=>clouds.push({level,...at})})
  effects.attach(portals); props.attach(sb,'overworld')
  w.receive=m=>{props.receive(m);effects.receive(m)}
  players.set(id,w);w.receive({type:'world-welcome',you:id,tick:66,players:[],slot:0})
  relayProps.join(w);relay.snapshot(w)
  const c={w,sb,collision,wall,portals,effects,clouds};clients.push(c);return c
}
function flush() {
  let limit=0
  while(inbound.length||outbound.length){assert.ok(++limit<10000)
    while(outbound.length){const[w,m]=outbound.shift();if(m.type.startsWith('world-prop-'))relayProps.handle(w,m);else relay.handle(w,m)}
    while(inbound.length){const[w,m]=inbound.shift();w.receive(m)}
  }
}
function step(n=1){for(let i=0;i<n;i++){time+=1000/60;for(const c of clients){c.sb.tick({dt:1/60,active:true});c.portals.tick(1/60);c.effects.tick();c.portals.follow()}flush();relayProps.tick();relay.tick();flush()}}
const a=await client(1),b=await client(2);flush()
const v=(x,y,z)=>new THREE.Vector3(x,y,z), up=v(0,1,0)
a.portals.placeAt(0,'overworld',v(0,2,0),v(0,0,1),up)
a.portals.placeAt(1,'overworld',v(20,2,0),v(-1,0,0),up)
step(12)
assert.equal(b.portals.list.filter(Boolean).length,0)
assert.equal(b.portals.all.filter(Boolean).length,2)
b.portals.aperture('overworld',v(0,2,0.5));assert.equal(b.wall.through,true,'remote portal opens the local collision host')
const eye=v(0,4,1), velocity=v(0,0,0)
const walker={feetY:0,yaw:0,pitch:0,teleport:(x,z,y)=>{walker.feetY=y;eye.set(x,y+4,z)},fling:(x,y,z)=>velocity.set(x,y,z)}
const walk=createPortalWalk({portals:b.portals,walk:walker,eye,level:()=>({id:'overworld',collision:b.collision,groundY:0})})
walk.before();eye.z=-1
const cross=walk.after(0,0,-12)
assert.equal(cross.from.owner,1);assert.equal(cross.to.owner,1)
assert.ok(eye.x<20&&eye.x>18);assert.ok(velocity.x< -11.9)
b.portals.placeAt(0,'overworld',v(40,2,0),v(0,0,1),up);step(10)
assert.equal(a.portals.all.filter(Boolean).length,3,'pairs coexist without replacing local endpoints')
const panel=a.sb.spawn('portal_panel',{x:0,y:3,z:6},{frozen:true});flush()
const p=a.portals.placeAt(0,'overworld',v(0,3,6.2),v(0,0,1),up)
p.anchor={kind:'prop',sb:a.sb,id:panel,local:new THREE.Matrix4().makeTranslation(0,0,0.2)};p.skin=0.55
step(12)
let remote=b.portals.all.find(q=>q?.owner===1&&q.color===0)
assert.ok(remote.anchor?.kind==='prop');assert.notEqual(remote.anchor.id,panel)
sent.length=0
a.sb.setTransform(panel,{x:7,y:3,z:6});step(30)
remote=b.portals.all.find(q=>q?.owner===1&&q.color===0)
assert.ok(Math.abs(remote.pos.x-7)<0.02)
assert.equal(sent.filter(m=>m.type==='world-portal').length,0,'prop motion does not duplicate portal traffic')
const c=await client(3);flush();step(10)
assert.ok(Math.abs(c.portals.all.find(q=>q?.owner===1&&q.color===0).pos.x-7)<0.02,'late snapshot resolves the current prop frame')
b.effects.airHop(0,3,0);flush()
assert.equal(a.clouds.length,0,'cloud waits for remote pose playback')
c.w.world.level='moon';c.effects.setLevel('moon');relay.snapshot(c.w);flush()
step(10)
assert.equal(a.clouds.length,1);assert.equal(b.clouds.length,0);assert.equal(c.clouds.length,0)
a.sb.remove(panel);flush();step(10)
assert.equal(b.portals.all.filter(q=>q?.owner===1).length,1,'removing an anchor closes its portal')
players.delete(a.w.world.id);relay.leave(a.w.world.id);flush()
assert.equal(b.portals.all.filter(q=>q?.owner===1).length,0)
b.portals.aperture('overworld',v(0,2,0));assert.equal(b.wall.through,false)
for(const c of clients){c.effects.offline();c.sb.dispose()}
console.log('world effects: remote crossing, local collision hosts, independent pairs, moving prop anchors, late join, cleanup and delayed hop clouds passed')
