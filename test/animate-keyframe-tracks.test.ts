import { describe, expect, it, vi } from 'vitest';
import * as api from '../src/animate/index.js';
import { groupRecord } from '../src/animate/channels.js';
import { fakeEl, makeClock, makeTimer, pickAnimate, translateXSeries } from './animate-facade-helpers.js';

const animate = pickAnimate(api);
const x = (f: ReturnType<typeof fakeEl>) => translateXSeries(f.writes).at(-1)!;
const linear = (t: number) => t;

describe('animate: авторский многоточечный track и прежний lifecycle', () => {
  it('здоровый контроль: прежняя пара остаётся прежним tween', () => {
    const f = fakeEl(); const c = animate(f.el, { x: [0, 100] }, { duration: 100, ease: linear, requestFrame: () => 1 });
    c.seek(25); expect(x(f)).toBe(25); c.cancel();
  });
  it('неравномерный track проходит все точки без ручного sampler/clock', async () => {
    const f = fakeEl(); const done = vi.fn();
    const c = animate(f.el, { x: [0, 120, -40, 0], opacity: [0, 1, 1, 0] }, { duration: 800, times: [0, .25, .75, 1], requestFrame: () => 1, onComplete: done });
    for (const [t, expected] of [[0, 0], [100, 60], [200, 120], [400, 40], [600, -40], [700, -20]]) {
      c.seek(t!); expect(x(f)).toBeCloseTo(expected!, 10);
    }
    c.seek(800); await c.finished; expect(done).toHaveBeenCalledTimes(1); expect(x(f)).toBe(0);
    const count=f.writes.length; c.seek(0); c.play(); c.pause(); c.cancel(); c.stop(); expect(f.writes).toHaveLength(count);
  });
  it('easing относится к сегменту; разные N без общей times не угадываются', () => {
    const f = fakeEl();
    const c = animate(f.el, { x: [0, 100, 0], opacity: [0, .5, 1, 0] }, { duration: 1000, ease: (t:number)=>t*t, requestFrame: () => 1 });
    c.seek(250); expect(x(f)).toBe(25); expect(Number(f.el.style.getPropertyValue('opacity'))).toBeCloseTo(.28125, 10); c.cancel();
  });
  it('duplicate interior offset выбирает правый stop и правую конечную скорость', () => {
    const f=fakeEl(); const c=animate(f.el,{x:[0,100,50,200]},{duration:1000,times:[0,.5,.5,1],requestFrame:()=>1});
    c.seek(500); expect(x(f)).toBe(50);
    expect(groupRecord(f.el,'transform')._owner!._captureNum('x')!._velocity).toBeCloseTo(300,7); c.cancel();
  });
  it('CSS codecs и transform axes не становятся отдельными владельцами', () => {
    const f=fakeEl(); const c=animate(f.el,{x:[0,100,0],rotate:[0,90,0],backgroundColor:['#000','#fff','#000'],width:['0px','20px','0px']},{duration:1000,requestFrame:()=>1});
    c.seek(250); expect(f.el.style.getPropertyValue('transform')).toBe('translateX(50px) rotate(45deg)');
    expect(f.el.style.getPropertyValue('width')).toBe('10px'); expect(f.el.style.getPropertyValue('background-color')).toBe('rgb(180, 180, 180)'); c.cancel();
  });
  it('номер точки не заменяет время: N=11, границы, общий законченный вызов', () => {
    const f=fakeEl(); const values=Array.from({length:11},(_,i)=>i*i);
    const c=animate(f.el,{x:values},{duration:1000,requestFrame:()=>1});
    c.seek(350); expect(x(f)).toBeCloseTo(12.5,10); c.seek(900); expect(x(f)).toBe(81); c.cancel();
  });
  it('caller arrays снимаются до selector и поздней мутации', () => {
    const f=fakeEl(); const values=[0,100,0],times=[0,.5,1],ease=[linear,linear];
    const query=vi.fn(()=>{values[1]=900;times[1]=.9;ease[0]=()=>0;return [f.el];});
    vi.stubGlobal('document',{querySelectorAll:query});
    try {const c=animate('.item',{x:values},{duration:1000,times,ease,requestFrame:()=>1});c.seek(250);expect(x(f)).toBe(50);c.cancel();} finally {vi.unstubAllGlobals();}
  });
  it.each([
    [{x:[0,1,2]},{spring:{mass:1,stiffness:100,damping:20}},'LM136'],
    [{x:[0,1,2]},{times:[0,1]},'LM035'],
    [{x:[0,1,2]},{times:[0,.8,.7]},'LM037'],
    [{x:[0,1,2]},{ease:[linear]},'LM040'],
    [{x:[0,1,2],opacity:[0,1]},{times:[0,.5,1]},'LM035'],
    [{x:[0,,2]},{},'LM173'],
    [{width:['0px','oops','2px']},{},'LM144'],
  ])('некорректный authoring не достигает selector/host %#', (props,options,code)=>{
    const query=vi.fn(()=>[]);vi.stubGlobal('document',{querySelectorAll:query});
    try {expect(()=>animate('.item',props as any,options)).toThrow(code);expect(query).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
  });
  it('reduced motion сразу публикует последний stop без WAAPI или rAF', async () => {
    const f=fakeEl({},true),frame=vi.fn(()=>1),done=vi.fn();
    const c=animate(f.el,{x:[0,100,40]},{delay:100,requestFrame:frame,matchMedia:()=>({matches:true}),onComplete:done});
    await c.finished;expect(x(f)).toBe(40);expect(f.animateCalls).toHaveLength(0);expect(frame).not.toHaveBeenCalled();expect(done).toHaveBeenCalledTimes(1);
  });
  it('много целей: stagger/pause/play/cancel используют общий batch и один finished',async()=>{
    const a=fakeEl(),b=fakeEl(),clock=makeClock(),done=vi.fn();
    const c=animate([a.el,b.el],{x:[0,100,0]},{duration:100,stagger:50,requestFrame:clock.requestFrame,onComplete:done});
    clock.step(0);clock.step(25);expect(x(a)).toBe(50);expect(b.writes).toHaveLength(0);
    c.pause();const len=a.writes.length;clock.step(100);expect(a.writes).toHaveLength(len);
    c.play();clock.step(0);clock.step(25);expect(x(a)).toBe(100);expect(x(b)).toBe(0);
    c.cancel();await c.finished;clock.drain();expect(done).not.toHaveBeenCalled();
  });
  it('линейные native tracks: один effect на surface, pause/play не начинают track сначала',async()=>{
    const f=fakeEl({},true),timer=makeTimer();let time=250;
    const original=f.el.animate!;f.el.animate=(...args)=>({...original(...args),get currentTime(){return time;}});
    const c=animate(f.el,{x:[0,100,0]},{duration:1000,now:()=>0,setTimer:timer.setTimer});
    expect(f.animateCalls).toHaveLength(1);expect(f.animateCalls[0]!.keyframes).toHaveLength(3);
    c.pause();expect(x(f)).toBe(50);c.play();expect(f.animateCalls).toHaveLength(2);expect(f.animateCalls[1]!.timing.delay).toBe(-250);
    time=250;c.cancel();await c.finished;expect(timer.pending()).toHaveLength(0);
  });
});
