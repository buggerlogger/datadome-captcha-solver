import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

const T = JSON.parse(readFileSync(new URL('../data/devices.json', import.meta.url), 'utf8'));

const FRAME_X = 16;
const FRAME_Y = 95;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  let total = 0;
  for (const x of list) total += x.weight;
  let r = rng() * total;
  for (const x of list) { r -= x.weight; if (r <= 0) return x; }
  return list[list.length - 1];
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const memoryFor = (rng, cores) => {
  const floor = cores >= 16 ? 16 : cores >= 8 ? 8 : 4;
  const usable = T.memory.filter((m) => m.value >= floor);
  return (usable.length ? pick(rng, usable) : T.memory[0]).value;
};

const coresFor = (rng, gpu) => {
  const discrete = /GeForce|Radeon RX|Arc\(TM\)/.test(gpu.model) && !/Graphics$/.test(gpu.model);
  const usable = discrete ? T.cores.filter((c) => c.value >= 6) : T.cores;
  return (usable.length ? pick(rng, usable) : T.cores[0]).value;
};

function compose(scr, gpu, cores, memory, net, outerWidth, outerHeight, seed) {
  return {
    seed,
    hardwareConcurrency: cores,
    deviceMemory: memory,
    devicePixelRatio: scr.dpr,
    innerWidth: outerWidth - FRAME_X,
    innerHeight: outerHeight - FRAME_Y,
    outerWidth,
    outerHeight,
    screen: {
      width: scr.width,
      height: scr.height,
      availWidth: scr.availWidth,
      availHeight: scr.availHeight,
      colorDepth: scr.colorDepth,
      pixelDepth: scr.colorDepth,
    },
    connection: { effectiveType: '4g', downlink: net.downlink, rtt: net.rtt, saveData: net.saveData },
    glVendor: gpu.glVendor,
    glRenderer: gpu.glRenderer,
  };
}

const pow2 = (gb) => { let v = 1; while (v * 2 <= gb) v *= 2; return Math.min(v, 32); };

export function baseDevice() {
  return {
    seed: 0,
    hardwareConcurrency: cpus().length,
    deviceMemory: pow2(Math.round(totalmem() / 1073741824)),
    ...T.base,
  };
}

export function generateDevice(seed) {
  const s = seed === undefined ? (Math.random() * 0xFFFFFFFF) >>> 0 : seed >>> 0;
  const rng = mulberry32(s);
  const scr = pick(rng, T.screens);
  const gpu = pick(rng, T.gpus);
  const cores = coresFor(rng, gpu);

  let outerWidth = scr.availWidth;
  let outerHeight = scr.availHeight;
  if (rng() >= 0.62) {
    outerWidth = randInt(rng, Math.round(scr.availWidth * 0.55), scr.availWidth);
    outerHeight = randInt(rng, Math.round(scr.availHeight * 0.6), scr.availHeight);
  }
  return compose(scr, gpu, cores, memoryFor(rng, cores), pick(rng, T.network), outerWidth, outerHeight, s);
}

export function gpuByName(needle) {
  const hit = T.gpus.find((g) => g.glRenderer.includes(needle));
  if (!hit) throw new Error(`no GPU in data/devices.json matches "${needle}"`);
  return hit;
}

export function describeDevice(d) {
  const gpu = /^ANGLE \([^,]+, (.+?) (?:\(0x|Direct3D11)/.exec(d.glRenderer);
  return `${d.screen.width}x${d.screen.height}@${d.devicePixelRatio} `
    + `win ${d.innerWidth}x${d.innerHeight} · ${d.hardwareConcurrency}c/${d.deviceMemory}GB · `
    + `${gpu ? gpu[1] : 'GPU'} · seed ${d.seed}`;
}
