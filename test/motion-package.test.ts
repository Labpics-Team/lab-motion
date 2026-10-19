import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import ts from 'typescript';
import ts5 from 'typescript5';
import { rootRecipe } from '../browser/fixtures/motion-root.mjs';

it('установленный пакет предоставляет один root API, одинаковые ESM/CJS и точные типы', () => {
  const work = mkdtempSync(join(tmpdir(), 'lab-motion-api-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: resolve('.'), stdio: 'pipe' });
    const archive = readdirSync(work).find(name => name.endsWith('.tgz'))!;
    const installed = join(work, 'node_modules/@labpics/motion'); mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, archive), '--strip-components=1', '-C', installed]);
    writeFileSync(join(work, 'package.json'), JSON.stringify({ type: 'module' }));
    const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    expect(metadata.exports['.'].import.default).toBe('./dist/motion/index.js');
    writeFileSync(join(work, 'probe.mjs'), `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      const keys=['MotionError','animate','layout','playhead','scope','sequence','value'];
      for (const module of [await import('@labpics/motion'),require('@labpics/motion')]) {
        assert.deepEqual(Object.keys(module).sort(),keys);
        const c=module.animate([], {}, {duration:10});
        assert.deepEqual(await c.finished,{status:'finished'});
        c.stop(); c.seek(NaN); c.finish();
        const v=module.value(2); v.set(3); assert.equal(v.get(),3);
        const motion=module.playhead(v.animate([3,5],{duration:1000})); motion.pause(); motion.seek(250);
        assert.equal(motion.time,250); assert.equal(v.get(),3.5);
        motion.timeScale=.5; motion.reverse(); assert.equal(motion.timeScale,-.5);
        assert.equal(motion.state,'paused'); motion.finish(); assert.equal(v.get(),5);
        v.dispose();
        const s=module.scope({querySelectorAll(){return []}}); s.dispose();
        const stopped=s.animate({get style(){throw Error('stale')}},{get x(){throw Error('stale')}});
        assert.deepEqual(await stopped.finished,{status:'stopped'});
        assert.deepEqual(await module.sequence([]).finished,{status:'finished'});
      }
      console.log('root ESM/CJS PASS');
    `);
    const child = spawnSync(process.execPath, ['probe.mjs'], { cwd: work, encoding: 'utf8', timeout: 15_000 });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const source = `import {animate, scope, sequence, layout, value, playhead, type Playback, type MotionPlayback, type MotionResult} from '@labpics/motion';
const element=document.createElement('div');
const a:Playback=animate(element,{x:[0,100,0]},{duration:200,ease:'ease-out'});
const b:MotionPlayback=playhead(animate(element,{x:200},{spring:{response:280,bounce:.1}}));
const position:number|undefined=b.time;const speed:number|undefined=b.timeScale;
b.timeScale=0.5;b.reverse();void position;void speed;
// @ts-expect-error a requested speed must be a finite number at runtime, never undefined
b.timeScale=undefined;
// @ts-expect-error time is read-only; seek owns repositioning
b.time=20;
// @ts-expect-error layout does not expose reversible mutation
layout(element,()=>{}).reverse();
const area=scope(element); area.on(element,'click',e=>{const x:number=e.clientX;void x});
sequence([[element,{x:100},{at:0,duration:200}]]);
layout(element,async()=>{element.classList.add('expanded')},{duration:100});
const v=value(1);v.animate(2);v.dispose();
a.finished.then((r:MotionResult)=>{if(r.status==='finished')element.remove()});
// @ts-expect-error modes are exclusive
animate(element,{x:1},{duration:200,spring:{response:200}});
// @ts-expect-error coordinate is numeric
animate(element,{x:1},{spring:{response:'slow'}});
// @ts-expect-error direct host clock belongs to tests
animate(element,{x:1},{requestFrame:()=>0});
// @ts-expect-error controls expose one stop
b.cancel();
// @ts-expect-error invalid easing name
animate(element,{x:1},{ease:'infinite'});
area.dispose();`;
    const file = join(work, 'consumer.ts'); writeFileSync(file, source);
    const guide = readFileSync(join(installed, 'docs/getting-started.md'), 'utf8');
    const example = rootRecipe(guide);
    expect(rootRecipe(guide.replaceAll('\n', '\r\n'))).toBe(example);
    const exampleFile = join(work, 'example.ts'); writeFileSync(exampleFile, example!);
    for (const compiler of [ts, ts5]) {
      const program = compiler.createProgram([file, exampleFile], { noEmit: true, strict: true, skipLibCheck: false, target: compiler.ScriptTarget.ES2022,
        module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] });
      expect(compiler.getPreEmitDiagnostics(program).map(d => compiler.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 60_000);

it('10 000 жизненных циклов release удержанных controllers освобождают компоненты', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', 'test/fixtures/motion-production-retention.mjs', resolve('dist/motion/index.js')],
    { encoding: 'utf8', timeout: 90_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const proof = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  expect(proof.cycles).toBe(10_000); expect(proof.retainedComponents).toBe(0); expect(proof.frames).toBe(0);
  expect(proof.nativeCreated).toBeGreaterThan(0); expect(proof.nativeCreated).toBe(proof.nativeRemoved);
  expect(proof.positiveControl).toBe(true);
}, 100_000);


it('отменённый layout освобождает root до завершения обновления приложения', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', 'test/fixtures/motion-layout-pending.mjs', resolve('dist/motion/index.js')],
    { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 20_000);

it('packed playhead сохраняет controls без удержания уничтоженных компонентов', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', 'test/fixtures/motion-production-retention.mjs', resolve('dist/motion/index.js'), 'playhead'],
    { encoding: 'utf8', timeout: 90_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const proof = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  expect(proof.transport).toBe(true); expect(proof.cycles).toBe(10_000);
  expect(proof.retainedComponents).toBe(0); expect(proof.frames).toBe(0);
  expect(proof.nativeCreated).toBeGreaterThan(0); expect(proof.nativeCreated).toBe(proof.nativeRemoved);
  expect(proof.positiveControl).toBe(true);
}, 100_000);
