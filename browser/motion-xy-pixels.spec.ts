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
    turn.finish(); ref.cancel(); await Promise.all([lead.finished,turn.finished]);
    return {t0,t1,setup};
  });
  await cdp.send('Page.stopScreencast'); await cdp.detach();
  const busy=frames.filter(f=>f.time>scene.t0+35 && f.time<scene.t1-35);
  expect(busy.length).toBeGreaterThanOrEqual(3);
  const pixels=await page.evaluate(async pngs => {
    const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    const positions: {red:number; blue:number; green:number}[]=[];
    for (const png of pngs) {
      const img=new Image(); img.src='data:image/png;base64,'+png; await img.decode();
      canvas.width=img.naturalWidth; canvas.height=img.naturalHeight; ctx.drawImage(img,0,0);
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let red=Infinity,blue=Infinity,green=Infinity;
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
        const i=4*(y*canvas.width+x), r=data[i]!,g=data[i+1]!,b=data[i+2]!;
        if(r>200&&g<40&&b<40) red=Math.min(red,y);
        if(b>200&&r<40&&g<40) blue=Math.min(blue,x);
        if(g>200&&r<40&&b<40) green=Math.min(green,x);
      }
      positions.push({red,blue,green});
    }
    return positions;
  }, busy.map(f=>f.png));
  expect(pixels.every(p=>Object.values(p).every(Number.isFinite))).toBe(true);
  const travel=(k:'red'|'blue'|'green')=>Math.max(...pixels.map(p=>p[k]))-Math.min(...pixels.map(p=>p[k]));
  console.log('native XY busy-window', {frames:pixels.length, motionPx:travel('red'), nativeControlPx:travel('blue'), jsControlPx:travel('green'), setupMs:scene.setup});
  expect(travel('blue')).toBeGreaterThan(10);
  expect(travel('green')).toBe(0);
  expect(travel('red')).toBeGreaterThan(4);
});
