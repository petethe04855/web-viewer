// Embeds the exported PNG textures into the glTF binary so the model and its
// textures travel as a single .glb file.
//
//   node scripts/embed-textures.mjs <model.glb> <textureRoot> [out.glb]
//
// CUE4Parse-Conversion writes material placeholders without image data; the
// textures exist as separate PNGs, so they are appended here as new bufferViews.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

const [glbPath, textureRoot, outArg] = process.argv.slice(2);
if (!glbPath || !textureRoot) {
  console.error('usage: node embed-textures.mjs <model.glb> <textureRoot> [out.glb]');
  process.exit(1);
}

// Material suffix -> texture stem. WuWa's shader masks (_ID, _HM, _Switch_D) are
// deliberately skipped: base colour and normal maps are what a generic PBR viewer
// (and Blender's glTF importer) can actually use.
const TEXTURE_FOR_MATERIAL = {
  bangs: 'T_R2T1ChangLiMd10011Bangs',
  hair: 'T_R2T1ChangLiMd10011Hair',
  face: 'T_R2T1ChangLiMd10011Face',
  up: 'T_R2T1ChangLiMd10011Up',
  down: 'T_R2T1ChangLiMd10011Down',
  cloth: 'T_R2T1ChangLiMd10011Cloth',
  eye: 'T_R2T1ChangLiMd10011Eye',
  '5xingstar': 'T_5XingStar',
};

// Textures are scattered across shared folders (CommonTexture, ...), so index the
// whole export tree by file name once instead of assuming they sit next to the model.
const textureIndex = new Map();
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().endsWith('.png')) textureIndex.set(entry.name.toLowerCase(), full);
  }
})(textureRoot);

const findTexture = (name) => textureIndex.get(name.toLowerCase()) ?? null;

const buf = readFileSync(glbPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb file');

const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
let bin = buf.subarray(binStart, binStart + binLen);

// Which PNGs are needed, decided from the material names in the glb.
const needed = new Map();
for (const material of gltf.materials ?? []) {
  const key = Object.keys(TEXTURE_FOR_MATERIAL).find((k) =>
    material.name.toLowerCase().endsWith(k));
  if (!key) continue;

  const stem = TEXTURE_FOR_MATERIAL[key];
  const diffuse = findTexture(`${stem}_D.png`);
  if (!diffuse) { console.warn(`no diffuse texture for ${material.name}`); continue; }
  const normal = findTexture(`${stem}_N.png`);

  material.userData = { ...(material.userData ?? {}), textures: { diffuse, normal } };
  needed.set('base:' + material.name, { file: diffuse, role: 'base', material });
  if (normal) needed.set('normal:' + material.name, { file: normal, role: 'normal', material });
}

// Grow the binary chunk with the PNG payloads (4-byte aligned, as glTF requires).
const parts = [bin];
let offset = bin.length;
const appended = [];

for (const entry of needed.values()) {
  if (offset % 4 !== 0) {
    const padding = 4 - (offset % 4);
    parts.push(Buffer.alloc(padding));
    offset += padding;
  }
  const png = readFileSync(entry.file);
  appended.push({ ...entry, byteOffset: offset, byteLength: png.length });
  parts.push(png);
  offset += png.length;
}
bin = Buffer.concat(parts);

gltf.bufferViews = gltf.bufferViews ?? [];
gltf.images = gltf.images ?? [];
gltf.textures = gltf.textures ?? [];
gltf.samplers = gltf.samplers ?? [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];

for (const { material, role, byteOffset, byteLength } of appended) {
  const bufferView = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength });

  const image = gltf.images.length;
  gltf.images.push({ bufferView, mimeType: 'image/png' });

  const texture = gltf.textures.length;
  gltf.textures.push({ sampler: 0, source: image });

  material.pbrMetallicRoughness = material.pbrMetallicRoughness ?? {};
  if (role === 'base') {
    material.pbrMetallicRoughness.baseColorTexture = { index: texture };
    material.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
    material.pbrMetallicRoughness.metallicFactor = 0;
    material.pbrMetallicRoughness.roughnessFactor = 0.75;
  } else {
    material.normalTexture = { index: texture, scale: 1 };
  }
}

// The exported vertex colours are shader masks, not panel colours: three.js and
// Blender multiply them into the base colour and turn the whole outfit green.
// Drop the attribute from every primitive so the base textures stand on their own.
for (const mesh of gltf.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) delete primitive.attributes?.COLOR_0;
}

for (const image of gltf.images) delete image.uri;
gltf.buffers = [{ byteLength: bin.length }];

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
if (bin.length % 4 !== 0) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);

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

const outPath = outArg ?? join(dirname(glbPath), basename(glbPath, '.glb') + '_textured.glb');
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(total / 1048576).toFixed(1)} MB, ${gltf.images.length} images, ${gltf.materials.length} materials)`);
