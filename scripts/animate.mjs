// Turns the JSON animation dumps from `ue-runner --anim-dump` into glTF
// animations inside an existing .glb.
//
//   node scripts/animate.mjs <model.glb> <animDir> <out.glb>
//
// The mesh exporter converted EVery bone transform with  (x, y, z) -> (x, z, y)
// and quaternions with (x, y, z, w) -> (x, z, y, -w), plus a 0.01 unit scale.
// The animation keys have to go through exactly the same mapping or the pose
// ends up mirrored.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [glbPath, animDir, outArg] = process.argv.slice(2);
if (!glbPath || !animDir) {
  console.error('usage: node scripts/animate.mjs <model.glb> <animDir> <out.glb>');
  process.exit(1);
}

const UNIT_SCALE = 0.01;

const swapVec = (v) => [v[0], v[2], v[1]];
const swapQuat = (q) => {
  const out = [q[0], q[2], q[1], -q[3]];
  const len = Math.hypot(...out);
  return out.map((c) => c / len);
};

const buf = readFileSync(glbPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb file');

const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
const chunks = [buf.subarray(binStart, binStart + binLen)];

const nodeByName = new Map();
(gltf.nodes ?? []).forEach((node, index) => {
  if (node.name && !nodeByName.has(node.name)) nodeByName.set(node.name, index);
});

gltf.accessors = gltf.accessors ?? [];
gltf.bufferViews = gltf.bufferViews ?? [];
gltf.animations = gltf.animations ?? [];

let cursor = binLen;
const align4 = () => {
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
};

// Appends one float array and returns the accessor index describing it.
function addAccessor(values, type, componentsPerElement) {
  align4();
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  chunks.push(bytes);

  const bufferView = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length });
  cursor += bytes.length;

  const accessor = gltf.accessors.length;
  gltf.accessors.push({
    bufferView,
    componentType: 5126,
    count: values.length / componentsPerElement,
    type,
  });
  return accessor;
}

const files = readdirSync(animDir).filter((f) => f.toLowerCase().endsWith('.json'));
let appended = 0;

for (const file of files) {
  const data = JSON.parse(readFileSync(join(animDir, file), 'utf8'));
  const name = data.name || basename(file, '.json');
  const fps = data.fps || 30;
  const frames = data.frames;

  const times = [];
  for (let i = 0; i < frames; i++) times.push(i / fps);
  const input = addAccessor(times, 'SCALAR', 1);

  const samplers = [];
  const channels = [];

  let matched = 0;
  for (const track of data.tracks) {
    const bone = data.bones[track.bone];
    if (!bone) continue;
    const node = nodeByName.get(bone.name);
    if (node === undefined) continue;
    matched++;

    const rotations = [];
    const translations = [];
    for (let f = 0; f < frames; f++) {
      rotations.push(...swapQuat(track.rot[f]));
      const p = swapVec(track.pos[f]);
      translations.push(p[0] * UNIT_SCALE, p[1] * UNIT_SCALE, p[2] * UNIT_SCALE);
    }

    const rotationAccessor = addAccessor(rotations, 'VEC4', 4);
    const rotationSampler = samplers.length;
    samplers.push({ input, output: rotationAccessor, interpolation: 'LINEAR' });
    channels.push({ sampler: rotationSampler, target: { node, path: 'rotation' } });

    const translationAccessor = addAccessor(translations, 'VEC3', 3);
    const translationSampler = samplers.length;
    samplers.push({ input, output: translationAccessor, interpolation: 'LINEAR' });
    channels.push({ sampler: translationSampler, target: { node, path: 'translation' } });
  }

  if (matched === 0) {
    console.warn(`${name}: no bone names matched the glb skeleton, skipped`);
    continue;
  }

  gltf.animations.push({ name, samplers, channels });
  appended++;
  const missing = data.tracks.length - matched;
  console.log(`${name}: ${frames} frames @ ${fps.toFixed(2)} fps, ${matched} channels${missing ? `, ${missing} bones missing` : ''}`);
}

let bin = Buffer.concat(chunks);
if (bin.length % 4 !== 0) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
gltf.buffers = [{ byteLength: bin.length }];

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);

const total = 12 + 8 + json.length + 8 + bin.length;
const out = Buffer.alloc(total);
let p = 0;
out.writeUInt32LE(0x46546c67, p); p += 4;
out.writeUInt32LE(2, p); p += 4;
out.writeUInt32LE(total, p); p += 4;
out.writeUInt32LE(json.length, p); p += 4;
out.writeUInt32LE(0x4e4f534a, p); p += 4;
json.copy(out, p); p += json.length;
out.writeUInt32LE(bin.length, p); p += 4;
out.writeUInt32LE(0x004e4942, p); p += 4;
bin.copy(out, p);

const outPath = outArg ?? join(dirname(glbPath), basename(glbPath, '.glb') + '_animated.glb');
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(total / 1048576).toFixed(1)} MB, ${appended} animations)`);
