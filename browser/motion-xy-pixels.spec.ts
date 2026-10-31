import { expect, test } from './fixtures/harness';

test('the rendered turn advances while the renderer main thread is blocked', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium compositor frame capture uses CDP');
  await page.setViewportSize({ width: 360, height: 320 });
  const cdp = await context.newCDPSession(page);
  const frames: { time: number; png: string }[] = [];
  cdp.on('Page.screencastFrame', frame => {
    frames.push({ time: (frame.metadata.timestamp ?? 0) * 1000, png: frame.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  const scene = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    document.body.style.cssText = 'margin:0;background:white';
    function marker(color: string, y: number) {
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;top:${y}px;left:0;width:14px;height:14px;background:${color};will-change:transform`;
      document.body.append(el); return el;
    }
    const moving = marker('red',180), raw = marker('blue',10), js = marker('lime',30);
    const lead = animate(moving, { x:[0,240] }, { duration:480, ease:'linear' });
    const first = moving.getAnimations()[0]!;
    await first.ready;
    first.pause(); first.currentTime=160;
    const start = performance.now();
    const turn = animate(moving,{ x:80, y:-120 },{ spring:{ mass:1,stiffness:25,damping:10 } });
    const setup = performance.now()-start;
    const active=moving.getAnimations();
    if (active.length!==1 || active[0]===first) throw new Error('missing native turn');
    await active[0]!.ready;
    let inlineWrites = 0;
    const observer = new MutationObserver(records => { inlineWrites += records.length; });
    observer.observe(moving, {attributes:true, attributeFilter:['style']});
    const ref = raw.animate([{transform:'translateX(0px)'},{transform:'translateX(300px)'}],{duration:1000,fill:'both'});
    await ref.ready;
    let count=0, handle=0;
    function tick() { js.style.transform=`translateX(${++count}px)`; handle=requestAnimationFrame(tick); }
    tick();
    for (let i=0;i<3;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const t0=performance.timeOrigin+performance.now(), freezeStart=performance.now();
    while (performance.now()-freezeStart<450) { /* block the renderer, leaving the compositor running */ }
    const t1=performance.timeOrigin+performance.now();
    cancelAnimationFrame(handle);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    inlineWrites += observer.takeRecords().length;
    observer.disconnect();
    turn.finish(); ref.cancel(); await Promise.all([lead.finished,turn.finished]);
    return {t0,t1,setup,inlineWrites};
  });
  await cdp.send('Page.stopScreencast'); await cdp.detach();
  const busy=frames.filter(f=>f.time>scene.t0+35 && f.time<scene.t1-35);
  expect(busy.length).toBeGreaterThanOrEqual(3);
  const pixels=await page.evaluate(async pngs => {
    const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    const positions: {red:number; redX:number; blue:number; green:number}[]=[];
    for (const png of pngs) {
      const img=new Image(); img.src='data:image/png;base64,'+png; await img.decode();
      canvas.width=img.naturalWidth; canvas.height=img.naturalHeight; ctx.drawImage(img,0,0);
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let red=Infinity,redX=Infinity,blue=Infinity,green=Infinity;
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
        const i=4*(y*canvas.width+x), r=data[i]!,g=data[i+1]!,b=data[i+2]!;
        if(r>200&&g<40&&b<40) { red=Math.min(red,y); redX=Math.min(redX,x); }
        if(b>200&&r<40&&g<40) blue=Math.min(blue,x);
        if(g>200&&r<40&&b<40) green=Math.min(green,x);
      }
      positions.push({red,redX,blue,green});
    }
    return positions;
  }, busy.map(f=>f.png));
  expect(pixels.every(p=>Object.values(p).every(Number.isFinite))).toBe(true);
  const travel=(k:'red'|'redX'|'blue'|'green')=>Math.max(...pixels.map(p=>p[k]))-Math.min(...pixels.map(p=>p[k]));
  console.log('native XY busy-window', {frames:pixels.length, motionPx:travel('red'), horizontalPx:travel('redX'), peakHorizontalPx:Math.max(...pixels.map(p=>p.redX))-80, nativeControlPx:travel('blue'), jsControlPx:travel('green'), setupMs:scene.setup});
  expect(scene.inlineWrites).toBe(0);
  expect(travel('blue')).toBeGreaterThan(10);
  expect(travel('green')).toBe(0);
  expect(travel('red')).toBeGreaterThan(4);
  expect(Math.max(...pixels.map(p=>p.redX)) - 80).toBeGreaterThan(8);
  expect(travel('redX')).toBeGreaterThan(3);
});

test('reports the cost of accepting repeated curved retargets from the packed root', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'performance comparison uses the same Chromium main thread');
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const spring = { mass: 1, stiffness: 100, damping: 20 };
    const elements = [document.createElement('div'), document.createElement('div')];
    document.body.append(...elements);
    const runs = elements.map(el => {
      const lead = animate(el, { x: [0, 1000] }, { duration: 1000, ease: 'linear' });
      const native = el.getAnimations()[0]!;
      native.pause(); native.currentTime = 240;
      return lead;
    });
    // Force only the renderer selection in the control lane, after the same initial throw.
    Object.defineProperty(elements[1]!, 'animate', { value: undefined, configurable: true });
    const costs: number[][] = [[], []], nativeCounts = [0, 0];
    for (let i = 0; i < 36; i++) {
      const target = { x: i === 0 ? 240 : i%2 ? -80 : 140, y: [100, -30, 65][i%3]! };
      for (const n of i%2 ? [1,0] : [0,1]) {
        if (i) runs[n]!.seek(20);
        const previous = elements[n]!.getAnimations()[0];
        const start = performance.now();
        runs[n] = animate(elements[n]!, target, { spring });
        const elapsed = performance.now() - start;
        if (i >= 4) costs[n]!.push(elapsed);
        const effects = elements[n]!.getAnimations();
        nativeCounts[n]! += Number(effects.length === 1 && effects[0] !== previous);
      }
    }
    for (const run of runs) run.finish();
    await Promise.all(runs.map(run => run.finished));
    const summary = costs.map(values => {
      values.sort((a,b)=>a-b);
      return { n: values.length, medianMs: values[Math.floor(values.length/2)], p95Ms: values[Math.ceil(values.length*.95)-1] };
    });
    return { summary, nativeCounts };
  });
  console.log('native XY rapid retarget (native, forced JS)', JSON.stringify(result));
  expect(result.nativeCounts[0]).toBeGreaterThan(24);
  expect(result.nativeCounts[1]).toBe(0);
});

test('measures first visible displacement after a retarget', async ({page,browserName}) => {
  test.skip(browserName !== 'chromium', 'paired latency observations use the same browser and screen');
  const result = await page.evaluate(async () => {
    const {animate} = await import('/browser/.artifacts/motion-root.js');
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const latencies: number[][] = [[], []];
    for (let round=0;round<10;round++) {
      const rows = [0,1].map(() => {
        const el=document.createElement('div');
        el.style.cssText='position:absolute;left:0;top:0;width:10px;height:10px;will-change:transform';
        document.body.append(el);
        const run=animate(el,{x:[0,1000]},{duration:1000,ease:'linear'});
        const effect=el.getAnimations()[0]!;
        effect.pause(); effect.currentTime=250;
        return {el,run};
      });
      await nextFrame();
      Object.defineProperty(rows[1]!.el,'animate',{value:undefined,configurable:true});
      const start=[0,0], done=[false,false];
      for(const lane of round%2?[1,0]:[0,1]) {
        const row=rows[lane]!;
        start[lane]=performance.now();
        row.run=animate(row.el,{x:250,y:80},{spring:{mass:1,stiffness:100,damping:20}});
      }
      for(let frame=0;frame<12&&!done.every(Boolean);frame++) {
        await nextFrame();
        for(let lane=0;lane<rows.length;lane++) if(!done[lane] && Math.abs(rows[lane]!.el.getBoundingClientRect().left-250)>1) {
          done[lane]=true;
          latencies[lane]!.push(performance.now()-start[lane]!);
        }
      }
      for(const row of rows){ row.run.finish(); row.el.remove(); }
    }
    return latencies.map(times => {
      times.sort((a,b)=>a-b);
      return {samples:times.length,medianMs:times[Math.floor(times.length/2)],p95Ms:times.at(-1)};
    });
  });
  console.log('native XY first observable frame (native, forced JS)',JSON.stringify(result));
  expect(result.map(item=>item.samples)).toEqual([10,10]);
});

test('a perpendicular throw can be caught again from its rendered position', async ({page}) => {
  const data = await page.evaluate(async () => {
    const {animate} = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div');
    document.body.append(el);
    const spring = {mass:1, stiffness:100, damping:20};
    const first = animate(el, {x:[0,1000]}, {duration:1000, ease:'linear'});
    const launch = el.getAnimations()[0]!;
    await launch.ready;
    launch.pause(); launch.currentTime=250;
    const turn = animate(el, {x:250,y:100}, {spring});
    const effects=el.getAnimations();
    if (effects.length !== 1 || effects[0] === launch) throw new Error('No replacement XY effect');
    const effect=effects[0]!;
    await effect.ready;
    effect.pause(); effect.currentTime=55;
    const matrix=()=>new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const displayed=matrix();
    const next=animate(el,{x:200,y:130},{spring});
    next.pause();
    const pickup=matrix();
    next.finish();
    const states=await Promise.all([first.finished,turn.finished,next.finished]);
    el.remove();
    return {displayed:[displayed.e,displayed.f],pickup:[pickup.e,pickup.f],states:states.map(s=>s.status)};
  });
  const decay=Math.exp(-.55);
  expect(Math.abs(data.displayed[0]!-(250+55*decay))).toBeLessThan(.25);
  expect(Math.abs(data.displayed[1]!-(100-155*decay))).toBeLessThan(.25);
  expect(data.pickup[0]).toBeCloseTo(data.displayed[0]!,1);
  expect(data.pickup[1]).toBeCloseTo(data.displayed[1]!,1);
  expect(data.states).toEqual(['stopped','stopped','finished']);
});
